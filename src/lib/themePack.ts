/**
 * 主题包：数据目录 `themes/<id>/` 下的文件夹（theme.json + CSS + 可选 SVG 滤镜 / JS）。
 *
 * 主题（风格）与深浅（模式）正交：`<html data-theme>` 仍是 light/dark，主题包只在其上
 * 叠加 `data-theme-pack` 与 `data-theme-opt-*`。没选主题包时这里不发请求、不碰 DOM。
 * 选择是本机显示偏好，和字号一样只存 localStorage，不进 settings.json。
 */
import { create } from "zustand";
import { captureDiagnostic } from "./diagnostics";

export type ThemeMode = "light" | "dark";
export type ThemeRgb = readonly [number, number, number];

export interface ThemeOption {
  id: string;
  label: string;
  default: boolean;
}

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  modes: ThemeMode[];
  css: string;
  svg?: string;
  js?: string;
  /** 原生窗口底色与首帧底色，每个支持的模式一个 #rrggbb。 */
  window: Partial<Record<ThemeMode, string>>;
  options: ThemeOption[];
  /** 调性分析的展示形式；不改变调性数据及筛选行为。 */
  camelot?: "wheel" | "grid";
}

export interface ThemeEntry {
  dir: string;
  manifest: ThemeManifest | null;
  error: string;
}

export interface ThemeSelection {
  id: string | null;
  /** 按主题 id 分开存；切换主题不丢别的主题的选项。 */
  options: Record<string, Record<string, boolean>>;
}

/** theme-init.js 首帧要用的最小快照，读它的代码越简单越好。 */
interface StoredSelection extends ThemeSelection {
  boot?: { window: Partial<Record<ThemeMode, string>>; attrs: string[] };
}

export const OFFICIAL_THEMES = [
  { id: "sakulaptop98", name: "Sakura98" },
];

export const THEME_PACK_STORAGE_KEY = "kd-theme-pack";
export const THEME_CHANGE_EVENT = "kd-theme-change";
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const CSS_LINK_ID = "kd-theme-pack-css";
const SVG_HOST_ID = "kd-theme-pack-svg";
const OPTION_ATTR_PREFIX = "data-theme-opt-";
const BOOT_TIMEOUT_MS = 1500;
const INSTANCE_ID = crypto.randomUUID();

function relativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** 返回清单，或一句给用户看的错误。`dir` 是文件夹名，必须与清单 id 相同。 */
export function parseThemeManifest(raw: unknown, dir: string): ThemeManifest | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "theme.json 必须是对象";
  const data = raw as Record<string, unknown>;
  if (data.kdj !== 1) return "不支持的主题格式版本";
  if (typeof data.id !== "string" || !THEME_ID.test(data.id)) return "主题 id 无效";
  if (data.id !== dir) return `主题 id「${data.id}」与文件夹名不一致`;
  if (typeof data.name !== "string" || !data.name.trim()) return "主题缺少名称";
  const modes = (Array.isArray(data.modes) ? data.modes : [])
    .filter((mode): mode is ThemeMode => mode === "light" || mode === "dark");
  if (modes.length === 0) return "主题至少要支持 light 或 dark";
  if (!relativePath(data.css)) return "主题缺少 css 文件";
  if (data.svg !== undefined && !relativePath(data.svg)) return "svg 路径无效";
  if (data.js !== undefined && !relativePath(data.js)) return "js 路径无效";
  const colors = (data.window ?? {}) as Record<string, unknown>;
  const window: ThemeManifest["window"] = {};
  for (const mode of modes) {
    const color = colors[mode];
    if (typeof color !== "string" || !HEX_COLOR.test(color)) return `缺少 ${mode} 模式的窗口底色`;
    window[mode] = color;
  }
  const options = (Array.isArray(data.options) ? data.options : []).flatMap((item): ThemeOption[] => {
    const option = item as Record<string, unknown> | null;
    // 目前只认布尔选项；未知类型直接忽略，旧客户端读新主题不至于整包失败。
    if (!option || option.type !== "boolean") return [];
    if (typeof option.id !== "string" || !THEME_ID.test(option.id)) return [];
    if (typeof option.label !== "string" || !option.label.trim()) return [];
    return [{ id: option.id, label: option.label, default: option.default === true }];
  });
  return {
    id: data.id,
    name: data.name.trim(),
    version: typeof data.version === "string" ? data.version : "",
    author: typeof data.author === "string" ? data.author : "",
    modes: [...new Set(modes)],
    css: data.css,
    svg: data.svg as string | undefined,
    js: data.js as string | undefined,
    window,
    options,
    ...(data.camelot === "grid" ? { camelot: "grid" as const } : {}),
  };
}

export function optionValues(
  manifest: ThemeManifest,
  stored: Record<string, boolean> | undefined,
): Record<string, boolean> {
  return Object.fromEntries(
    manifest.options.map((option) => [option.id, stored?.[option.id] ?? option.default]),
  );
}

/** 开着的布尔选项 → `data-theme-opt-<id>` 属性名。 */
export function optionAttributes(
  manifest: ThemeManifest,
  stored: Record<string, boolean> | undefined,
): string[] {
  const values = optionValues(manifest, stored);
  return manifest.options.filter((o) => values[o.id]).map((o) => OPTION_ATTR_PREFIX + o.id);
}

/** 主题只提供一种模式时强制用它；否则沿用用户的深浅选择。 */
export function resolveThemeMode(manifest: ThemeManifest | null, base: ThemeMode): ThemeMode {
  return manifest && !manifest.modes.includes(base) ? manifest.modes[0] : base;
}

function readStored(): StoredSelection {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_PACK_STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      return {
        id: typeof raw.id === "string" && THEME_ID.test(raw.id) ? raw.id : null,
        options: raw.options && typeof raw.options === "object" ? raw.options : {},
      };
    }
  } catch {
    /* 读不到就是没选主题 */
  }
  return { id: null, options: {} };
}

function writeStored(selection: ThemeSelection, active: ThemeManifest | null): void {
  const stored: StoredSelection = { id: selection.id, options: selection.options };
  if (active) {
    stored.boot = {
      window: active.window,
      attrs: optionAttributes(active, selection.options[active.id]),
    };
  }
  try {
    localStorage.setItem(THEME_PACK_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* 只影响下次启动 */
  }
}

interface ThemePackState {
  /** 主题文件夹的绝对路径，给「打开文件夹」用。 */
  dir: string;
  packs: ThemeEntry[];
  official: { id: string; name: string }[];
  installing: string | null;
  selection: ThemeSelection;
  /** 真正生效的主题；选中的包缺失或损坏时为 null，selection 仍保留。 */
  active: ThemeManifest | null;
  error: string;
  /** 每次主题 / 模式 / 选项变化加一；canvas 组件把它放进依赖里触发重画。 */
  epoch: number;
}

export const useThemePack = create<ThemePackState>(() => ({
  dir: "",
  packs: [],
  official: OFFICIAL_THEMES,
  installing: null,
  selection: { id: null, options: {} },
  active: null,
  error: "",
  epoch: 0,
}));

export function activeThemePack(): ThemeManifest | null {
  return useThemePack.getState().active;
}

/** applyTheme 用它判断「主题相关的东西变没变」，没变就不广播重绘。 */
export function themePackSignature(): string {
  const { active, selection } = useThemePack.getState();
  return active ? `${active.id}:${active.version}:${optionAttributes(active, selection.options[active.id]).join(",")}` : "";
}

let mounted: { unmount?: () => void } | null = null;
let loadedId: string | null = null;

function clearOptionAttributes(root: HTMLElement): void {
  for (const name of root.getAttributeNames()) {
    if (name.startsWith(OPTION_ATTR_PREFIX)) root.removeAttribute(name);
  }
}

function unload(): void {
  try {
    mounted?.unmount?.();
  } catch (error) {
    captureDiagnostic("theme", "script.unmount", error);
    console.warn("主题脚本 unmount 失败", error);
  }
  mounted = null;
  loadedId = null;
  document.getElementById(CSS_LINK_ID)?.remove();
  document.getElementById(SVG_HOST_ID)?.remove();
  const root = document.documentElement;
  delete root.dataset.themePack;
  clearOptionAttributes(root);
}

async function fileUrl(id: string, path: string): Promise<string> {
  const { api } = await import("./api");
  return api.themes.fileUrl(id, path);
}

async function load(manifest: ThemeManifest): Promise<void> {
  unload();
  const stamp = `?t=${Date.now()}`; // 主题作者改完文件重新选一次就能看到，不吃 HTTP 缓存
  const link = document.createElement("link");
  link.id = CSS_LINK_ID;
  link.rel = "stylesheet";
  link.href = (await fileUrl(manifest.id, manifest.css)) + stamp;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`加载主题超时：${manifest.css}`)), 15_000);
    link.onload = () => { clearTimeout(timeout); resolve(); };
    link.onerror = () => { clearTimeout(timeout); reject(new Error(`无法加载 ${manifest.css}`)); };
  });
  // 排在 <head> 末尾：同特异性时压过 design.css
  document.head.append(link);
  document.documentElement.dataset.themePack = manifest.id;
  loadedId = manifest.id;
  await ready;

  if (manifest.svg) {
    // 滤镜必须内联：WebKit 不支持 filter: url(外部文件.svg#id)
    const response = await fetch((await fileUrl(manifest.id, manifest.svg)) + stamp);
    if (!response.ok) throw new Error(`无法加载 ${manifest.svg}`);
    const host = document.createElement("div");
    host.id = SVG_HOST_ID;
    host.setAttribute("aria-hidden", "true");
    // 不能 display:none，否则部分内核里滤镜引用失效
    host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    host.innerHTML = await response.text();
    document.body.append(host);
  }

  if (manifest.js) {
    // 脚本坏了不该连累样式：CSS 已经生效，这里只记日志
    try {
      // 取回文本再从 blob: 导入：CSP 的 script-src 不必对本机任意端口放开
      const response = await fetch((await fileUrl(manifest.id, manifest.js)) + stamp);
      if (!response.ok) throw new Error(`无法加载 ${manifest.js}`);
      const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
      const module = await import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
      const entry = module.default as { mount?: (ctx: unknown) => void; unmount?: () => void } | undefined;
      entry?.mount?.({
        id: manifest.id,
        baseUrl: await fileUrl(manifest.id, ""),
        root: document.documentElement,
      });
      mounted = entry ?? null;
    } catch (error) {
      captureDiagnostic("theme", "script.mount", error);
      console.warn("主题脚本加载失败", error);
    }
  }
}

function applyOptions(manifest: ThemeManifest, selection: ThemeSelection): void {
  const root = document.documentElement;
  clearOptionAttributes(root);
  for (const name of optionAttributes(manifest, selection.options[manifest.id])) {
    root.setAttribute(name, "");
  }
}

// Serialize loads: fast switching must not leave CSS/SVG from an older request mounted.
let application = Promise.resolve();
function apply(selection: ThemeSelection, reload = false): Promise<void> {
  application = application.catch(() => undefined).then(() => applyNow(selection, reload));
  return application;
}

async function applyNow(selection: ThemeSelection, reload: boolean): Promise<void> {
  const { packs } = useThemePack.getState();
  const entry = selection.id ? packs.find((pack) => pack.dir === selection.id) : undefined;
  let active = entry?.manifest ?? null;
  let error = "";
  if (selection.id && !active) error = entry ? `${selection.id}：${entry.error}` : `主题包缺失：${selection.id}`;
  try {
    if (!active) unload();
    else if (reload || loadedId !== active.id) await load(active);
    if (active) applyOptions(active, selection);
  } catch (cause) {
    unload();
    captureDiagnostic("theme", "theme.apply", cause);
    error = `${selection.id}：${(cause as Error).message}`;
    active = null;
  }
  // 包缺失时只清首帧缓存，selection 原样保留：把文件夹放回来就恢复
  writeStored(selection, active);
  useThemePack.setState({ selection, active, error });
  if (reload) window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

async function broadcast(selection: ThemeSelection, reload = false): Promise<void> {
  // 桌面歌词是独立 WebView，storage 事件不可靠；与 lyricsPrefs 一样直接带快照广播
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("theme-pack-changed", { ...selection, reload, source: INSTANCE_ID });
  } catch {
    /* 浏览器预览没有 Tauri 事件 */
  }
}

/** 重新扫描主题文件夹，并把当前选择重新套一遍。 */
export async function refreshThemePacks(reload = true): Promise<void> {
  try {
    const { api } = await import("./api");
    const listing = await api.themes.list();
    const packs = listing.themes.map((item): ThemeEntry => {
      const parsed = item.manifest ? parseThemeManifest(item.manifest, item.dir) : item.error ?? "";
      return typeof parsed === "string"
        ? { dir: item.dir, manifest: null, error: parsed }
        : { dir: item.dir, manifest: parsed, error: "" };
    });
    useThemePack.setState({ dir: listing.dir, packs, official: Array.isArray(listing.official) ? listing.official : OFFICIAL_THEMES });
  } catch (error) {
    useThemePack.setState({ error: (error as Error).message });
    return;
  }
  await apply(useThemePack.getState().selection, reload);
}

/** 下载到临时目录、校验并安装成功后才切换，失败保留当前主题。 */
export async function installOfficialTheme(id: string): Promise<void> {
  if (useThemePack.getState().installing) return;
  useThemePack.setState({ installing: id, error: "" });
  try {
    const { api } = await import("./api");
    await api.themes.install(id);
    await refreshThemePacks();
    await selectThemePack(id);
    await broadcast(useThemePack.getState().selection, true);
  } catch (error) {
    useThemePack.setState({ error: (error as Error).message });
  } finally {
    useThemePack.setState({ installing: null });
  }
}

export async function selectThemePack(id: string | null): Promise<void> {
  const selection = { ...useThemePack.getState().selection, id };
  await apply(selection);
  void broadcast(selection);
}

let cycling = false;
/** Shiro / Dark are built-in themes. Only installed, valid optional packs enter the cycle. */
export async function cycleThemePack(): Promise<void> {
  if (cycling || useThemePack.getState().installing) return;
  cycling = true;
  try {
    await refreshThemePacks(false);
    const { packs, selection } = useThemePack.getState();
    const installed = packs.filter(pack => pack.manifest);
    const ids = [
      ...OFFICIAL_THEMES.map(theme => theme.id).filter(id => installed.some(pack => pack.dir === id)),
      ...installed.filter(pack => !OFFICIAL_THEMES.some(theme => theme.id === pack.dir)).map(pack => pack.dir),
    ];
    const choices = ["builtin-light", "builtin-dark", ...ids];
    const current = selection.id ?? `builtin-${document.documentElement.dataset.theme === "dark" ? "dark" : "light"}`;
    const next = choices[(choices.indexOf(current) + 1) % choices.length];
    if (next === "builtin-light" || next === "builtin-dark") {
      const { useAppStore } = await import("../stores/appStore");
      await selectThemePack(null);
      await useAppStore.getState().saveSettings({ theme: next === "builtin-light" ? "light" : "dark" });
    } else await selectThemePack(next);
  } catch (error) {
    useThemePack.setState({ error: (error as Error).message });
  } finally {
    cycling = false;
  }
}

export async function setThemeOption(optionId: string, value: boolean): Promise<void> {
  const { selection, active } = useThemePack.getState();
  if (!active) return;
  const next: ThemeSelection = {
    ...selection,
    options: {
      ...selection.options,
      [active.id]: { ...selection.options[active.id], [optionId]: value },
    },
  };
  await apply(next);
  void broadcast(next);
}

/**
 * React 挂载前调用。没选主题时立即返回；选了就等主题 CSS 到位再渲染，
 * 避免先闪一帧默认外观。超时照常渲染，主题稍后补上。
 */
export async function bootThemePack(): Promise<void> {
  const stored = readStored();
  useThemePack.setState({ selection: { id: stored.id, options: stored.options } });
  window.addEventListener(THEME_CHANGE_EVENT, () => {
    rgbCache.clear();
    useThemePack.setState((state) => ({ epoch: state.epoch + 1 }));
  });
  // Fonts arrive after CSS; canvases and lyric measurement must also repaint.
  document.fonts?.addEventListener("loadingdone", () => {
    if (useThemePack.getState().active) window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  });
  const receive = async ({ reload, source, ...selection }: ThemeSelection & { reload?: boolean; source?: string }) => {
    if (source === INSTANCE_ID) return;
    const current = useThemePack.getState().selection;
    if (!reload && JSON.stringify(current) === JSON.stringify(selection)) return;
    useThemePack.setState({ selection });
    if (reload || (selection.id && !useThemePack.getState().packs.some(p => p.dir === selection.id)))
      await refreshThemePacks();
    else await apply(selection);
  };
  if (window.__TAURI_INTERNALS__) {
    try {
      const [{listen, emitTo}, {getCurrentWindow}] = await Promise.all([
        import("@tauri-apps/api/event"), import("@tauri-apps/api/window"),
      ]);
      await listen<ThemeSelection & { reload?: boolean; source?: string }>("theme-pack-changed", ({payload}) => { void receive(payload); });
      const label = getCurrentWindow().label;
      if (label === "main") {
        await listen<string>("theme-pack-request", ({payload: target}) => {
          if (!["lyrics-overlay", "live-vj-output"].includes(target)) return;
          void emitTo(target, "theme-pack-snapshot", {
            selection: useThemePack.getState().selection,
            mode: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
          });
        });
      } else if (["lyrics-overlay", "live-vj-output"].includes(label)) {
        // A newly created WebView can see an old localStorage snapshot and has
        // missed the last broadcast. Ask the main window after listeners exist.
        let done!: () => void;
        const received = new Promise<void>(resolve => { done = resolve; });
        const stop = await listen<{selection: ThemeSelection; mode: ThemeMode}>("theme-pack-snapshot", ({payload}) => {
          document.documentElement.dataset.theme = payload.mode;
          void receive(payload.selection).finally(done);
        });
        try {
          await emitTo("main", "theme-pack-request", label);
          await Promise.race([received, new Promise(resolve => setTimeout(resolve, BOOT_TIMEOUT_MS))]);
        } finally { stop(); }
      }
    } catch (error) { console.warn("窗口主题同步失败，沿用本地主题", error); }
  }
  if (!useThemePack.getState().selection.id) return;
  try {
    await Promise.race([
      useThemePack.getState().active ? Promise.resolve() : refreshThemePacks(),
      new Promise((resolve) => setTimeout(resolve, BOOT_TIMEOUT_MS)),
    ]);
  } finally {
    // theme-init.js 为首帧写的内联底色；主题 CSS 到位后必须让位，否则切模式不变色
    document.documentElement.style.removeProperty("--kd-bg");
  }
}

const rgbCache = new Map<string, ThemeRgb>();
let probe: HTMLElement | null = null;

/**
 * canvas 等非 CSS 代码读主题令牌。令牌未定义（默认主题）时得到 fallback 本身，
 * 所以默认外观不变。缓存在主题 / 模式变化时清空。
 */
export function themeRgb(name: string, fallback: ThemeRgb): ThemeRgb {
  if (typeof document === "undefined" || !document.body) return fallback;
  const key = `${name}|${fallback.join(",")}`;
  const cached = rgbCache.get(key);
  if (cached) return cached;
  if (!probe?.isConnected) {
    const host = document.createElement("span");
    host.hidden = true;
    probe = host.appendChild(document.createElement("span"));
    document.body.append(host);
  }
  // 令牌写成了非颜色值时声明在计算阶段失效、改为继承；让它继承到的也是 fallback
  const fallbackCss = `rgb(${fallback.join(",")})`;
  (probe.parentElement as HTMLElement).style.color = fallbackCss;
  probe.style.color = `var(${name}, ${fallbackCss})`;
  // 只认不透明的 rgb()：canvas 这边没有可供透明色叠加的底
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(getComputedStyle(probe).color);
  const value: ThemeRgb = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : fallback;
  rgbCache.set(key, value);
  return value;
}

const BAND_IDENTITY: readonly ThemeRgb[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

/**
 * 波形的显示色里 R/G/B 三个通道分别对应低/中/高频。主题用
 * `--kd-wave-low/mid/high` 给三个频段换颜料；没定义时原样返回。
 */
export function waveBandRgb(rgb: ThemeRgb, frequency?: ThemeRgb): ThemeRgb {
  return createWaveBandMapper()(rgb, frequency);
}

/** Resolve theme tokens once per bitmap, not once per physical-pixel column. */
export function createWaveBandMapper(): (rgb: ThemeRgb, frequency?: ThemeRgb) => ThemeRgb {
  const bands = [
    themeRgb("--kd-wave-low", BAND_IDENTITY[0]),
    themeRgb("--kd-wave-mid", BAND_IDENTITY[1]),
    themeRgb("--kd-wave-high", BAND_IDENTITY[2]),
  ];
  if (bands.every((band, i) => band.every((value, channel) => value === BAND_IDENTITY[i][channel]))) {
    return rgb => rgb;
  }
  const frequencyPalette = typeof document !== "undefined"
    && document.documentElement.dataset.themePack === "sakulaptop98";
  return (rgb, frequency) => {
    // Sakura mixes measured strengths, not the default palette's neutral lift.
    if (frequency && frequencyPalette) {
      const peak = Math.max(...frequency);
      if (peak <= 0) return [0, 0, 0];
      const weights = frequency.map(value => Math.pow(Math.max(0, value) / peak, 2));
      const total = weights.reduce((sum, value) => sum + value, 0);
      return [0, 1, 2].map(channel => Math.round(
        bands.reduce((sum, band, index) => sum + band[channel] * weights[index], 0) / total,
      )) as unknown as ThemeRgb;
    }
    // Normalize shared pigment channels instead of clipping broad-band columns to white.
    const weight = Math.max(255, rgb[0] + rgb[1] + rgb[2]);
    return [0, 1, 2].map((channel) => Math.min(255, Math.round(
      (rgb[0] * bands[0][channel] + rgb[1] * bands[1][channel] + rgb[2] * bands[2][channel]) / weight,
    ))) as unknown as ThemeRgb;
  };
}
