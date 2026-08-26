import { create } from "zustand";
import {
  normalizePaint,
  resolveFollowPaint,
  type LyricsColorPaint,
  type LyricsFillMode,
  type LyricsSecondaryMode,
  type LyricsStrokeMode,
} from "./lyricsColor";
import { writeLocalStorageSoon } from "./storageWrite";

export type {
  LyricsColorMode,
  LyricsColorPaint,
  LyricsFillMode,
  LyricsSecondaryMode,
  LyricsStrokeMode,
} from "./lyricsColor";

const STORAGE_KEY = "kd-lyrics-prefs";
/** 0.2.27 曾把在线补词默认设成关闭；新默认开启，并迁移旧的未配置状态。 */
const ONLINE_LYRICS_PREF_VERSION = 1;

export type LyricsEngine = "wyy" | "qqm" | "ytm";
/** 跟随曲库来源，或强制只用来源平台搜/取词。 */
export type LyricsDisplaySource = "follow" | "wyy" | "qqm" | "ytm";
/**
 * 歌词附加层（面板右上角一字切换）：
 * off=原词 · meaning=意（翻译） · romaji=音（罗马音）
 */
export type LyricsExtra = "off" | "meaning" | "romaji";
export type DesktopLyricsPosition = "top" | "bottom";
/** 歌词模式下右栏双极：详情 ↔ 歌词。 */
export type LyricsAsideFace = "detail" | "lyrics";

export interface LyricsPrefs {
  /**
   * 歌词模式（自动显示歌词）：
   * 开 = 播放时后台搜词；点曲目按 asideFace 打开详情/歌词，顶栏可切换；下一首预取。
   * 关 = 不自动打开；点曲目仍开详情；播放条按钮可手动开歌词。
   */
  autoShow: boolean;
  /** 启用的搜词引擎；顺序 = 同分时的偏好。至少保留一家。 */
  engines: LyricsEngine[];
  /** 显示来源：跟随曲目 / 强制网易云 / 强制 QQ / 强制 YouTube Music。 */
  displaySource: LyricsDisplaySource;
  /** 本地没有下载歌词时，是否再按标题/艺人在线匹配。 */
  tryOnlineWhenMissing: boolean;
  /** 当前附加层；点右上角单字在可用态之间循环。 */
  lyricExtra: LyricsExtra;
  /**
   * 歌词模式下右栏记住上次点的是详情还是歌词。
   * 之后点列表 / 定位正在播，都按这个面弹出。
   */
  asideFace: LyricsAsideFace;
  /**
   * 悬浮歌词开关。桌面是独立透明置顶窗口；Android 是原生
   * `TYPE_APPLICATION_OVERLAY` 浮层（需要「显示在其他应用上层」权限）。
   */
  desktopEnabled: boolean;
  /**
   * 内部默认吸附边（无拖动坐标时）。设置里已去掉顶/底开关，只靠自由拖动；
   * 字段保留给原生浮层 gravity / 首次打开兜底。
   */
  desktopPosition: DesktopLyricsPosition;
  /** 锁定后整个歌词窗口触摸/鼠标穿透。 */
  desktopLocked: boolean;
  /** 悬浮歌词字号倍率；1=默认最小，最大 3（300%）。 */
  desktopFontScale: number;
  /**
   * 自由拖动后的坐标；两者齐全时下次打开优先恢复。
   * 桌面是物理屏幕坐标；Android 只用 Y（浮层满宽，仅允许垂直拖动）。
   */
  desktopPositionX: number | null;
  desktopPositionY: number | null;
  /**
   * 主行已唱部分填色（桌面 / Android 都做逐字推进）。
   * `mode=gradient` 时用 start→end 横向渐变。
   */
  desktopAccentMode: LyricsFillMode;
  desktopAccent: string;
  desktopAccentEnd: string;
  /** 副行（翻译 / 下一句）已唱填色；`follow` = 跟主行。 */
  desktopSecondaryMode: LyricsSecondaryMode;
  desktopSecondaryAccent: string;
  desktopSecondaryAccentEnd: string;
  /** 未唱部分填色（主行 / 副行共用）。 */
  desktopDimMode: LyricsFillMode;
  desktopDim: string;
  desktopDimEnd: string;
  /** 描边 / 边框色。 */
  desktopStrokeMode: LyricsStrokeMode;
  desktopStroke: string;
  desktopStrokeEnd: string;
  /** 整体不透明度 0.2–1。 */
  desktopOpacity: number;
}

const DEFAULTS: LyricsPrefs = {
  autoShow: false,
  engines: ["wyy", "qqm", "ytm"],
  displaySource: "follow",
  tryOnlineWhenMissing: true,
  lyricExtra: "meaning",
  asideFace: "detail",
  desktopEnabled: false,
  desktopPosition: "bottom",
  desktopLocked: true,
  desktopFontScale: 1,
  desktopPositionX: null,
  desktopPositionY: null,
  desktopAccentMode: "white",
  desktopAccent: "#ff3b5c",
  desktopAccentEnd: "#ff6b9d",
  desktopSecondaryMode: "follow",
  desktopSecondaryAccent: "#3b82f6",
  desktopSecondaryAccentEnd: "#7dd3fc",
  desktopDimMode: "gray",
  desktopDim: "#9e9e9e",
  desktopDimEnd: "#9e9e9e",
  desktopStrokeMode: "black",
  desktopStroke: "#ff3b5c",
  desktopStrokeEnd: "#334155",
  desktopOpacity: 1,
};

const DEFAULT_ACCENT_PAINT: LyricsColorPaint = {
  mode: DEFAULTS.desktopAccentMode,
  start: DEFAULTS.desktopAccent,
  end: DEFAULTS.desktopAccentEnd,
};
const DEFAULT_SECONDARY_PAINT: LyricsColorPaint = {
  mode: DEFAULTS.desktopSecondaryMode,
  start: DEFAULTS.desktopSecondaryAccent,
  end: DEFAULTS.desktopSecondaryAccentEnd,
};
const DEFAULT_DIM_PAINT: LyricsColorPaint = {
  mode: DEFAULTS.desktopDimMode,
  start: DEFAULTS.desktopDim,
  end: DEFAULTS.desktopDimEnd,
};
const DEFAULT_STROKE_PAINT: LyricsColorPaint = {
  mode: DEFAULTS.desktopStrokeMode,
  start: DEFAULTS.desktopStroke,
  end: DEFAULTS.desktopStrokeEnd,
};

export function accentPaint(prefs: Pick<
  LyricsPrefs,
  "desktopAccentMode" | "desktopAccent" | "desktopAccentEnd"
>): LyricsColorPaint {
  return {
    mode: prefs.desktopAccentMode,
    start: prefs.desktopAccent,
    end: prefs.desktopAccentEnd,
  };
}

export function secondaryPaint(prefs: Pick<
  LyricsPrefs,
  "desktopSecondaryMode" | "desktopSecondaryAccent" | "desktopSecondaryAccentEnd"
>): LyricsColorPaint {
  return {
    mode: prefs.desktopSecondaryMode,
    start: prefs.desktopSecondaryAccent,
    end: prefs.desktopSecondaryAccentEnd,
  };
}

export function dimPaint(prefs: Pick<
  LyricsPrefs,
  "desktopDimMode" | "desktopDim" | "desktopDimEnd"
>): LyricsColorPaint {
  return {
    mode: prefs.desktopDimMode,
    start: prefs.desktopDim,
    end: prefs.desktopDimEnd,
  };
}

export function strokePaint(prefs: Pick<
  LyricsPrefs,
  "desktopStrokeMode" | "desktopStroke" | "desktopStrokeEnd"
>): LyricsColorPaint {
  return {
    mode: prefs.desktopStrokeMode,
    start: prefs.desktopStroke,
    end: prefs.desktopStrokeEnd,
  };
}

/** 副行已解析色：跟随主行时直接返回主行 paint。 */
export function resolvedSecondaryPaint(prefs: LyricsPrefs): LyricsColorPaint {
  return resolveFollowPaint(secondaryPaint(prefs), accentPaint(prefs));
}

function normalizeEngines(value: unknown): LyricsEngine[] {
  if (!Array.isArray(value)) return [...DEFAULTS.engines];
  const out: LyricsEngine[] = [];
  for (const item of value) {
    if ((item === "wyy" || item === "qqm" || item === "ytm") && !out.includes(item)) {
      out.push(item);
    }
  }
  // 旧版默认双开（网易云+QQ）自动带上 YTM，正式启用原生歌词。
  if (out.includes("wyy") && out.includes("qqm") && !out.includes("ytm")) {
    out.push("ytm");
  }
  return out.length ? out : [...DEFAULTS.engines];
}

function normalizeSource(value: unknown): LyricsDisplaySource {
  if (value === "wyy" || value === "qqm" || value === "ytm" || value === "follow") return value;
  return DEFAULTS.displaySource;
}

function normalizeExtra(value: unknown): LyricsExtra {
  if (value === "off" || value === "meaning" || value === "romaji") return value;
  return DEFAULTS.lyricExtra;
}

function normalizeDesktopPosition(value: unknown): DesktopLyricsPosition {
  return value === "top" || value === "bottom" ? value : DEFAULTS.desktopPosition;
}

/** 100%（默认字号）为最小，最大 300%。 */
export const DESKTOP_FONT_SCALE_MIN = 1;
export const DESKTOP_FONT_SCALE_MAX = 3;

function normalizeDesktopFontScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(DESKTOP_FONT_SCALE_MAX, Math.max(DESKTOP_FONT_SCALE_MIN, value))
    : DEFAULTS.desktopFontScale;
}

/** 搜词引擎：全部 / 仅网易云 / 仅 QQ / 仅 YouTube Music。 */
export type LyricsEngineMode = "all" | "wyy" | "qqm" | "ytm";

export function enginesMode(engines: readonly LyricsEngine[]): LyricsEngineMode {
  const hasWyy = engines.includes("wyy");
  const hasQqm = engines.includes("qqm");
  const hasYtm = engines.includes("ytm");
  const count = [hasWyy, hasQqm, hasYtm].filter(Boolean).length;
  if (count >= 2) return "all";
  if (hasYtm) return "ytm";
  if (hasQqm) return "qqm";
  return "wyy";
}

export function enginesFromMode(mode: LyricsEngineMode): LyricsEngine[] {
  if (mode === "all") return ["wyy", "qqm", "ytm"];
  return [mode];
}

function normalizeCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

/** 全透明的悬浮歌词等于消失且无法找回，所以下限留 0.2。 */
export const DESKTOP_OPACITY_MIN = 0.2;

function normalizeOpacity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(DESKTOP_OPACITY_MIN, value))
    : DEFAULTS.desktopOpacity;
}

/** 按本首歌实际有的层，排出可点循环：原 → 意 → 音（缺的跳过）。 */
export function lyricExtraCycle(hasMeaning: boolean, hasRomaji: boolean): LyricsExtra[] {
  const cycle: LyricsExtra[] = ["off"];
  if (hasMeaning) cycle.push("meaning");
  if (hasRomaji) cycle.push("romaji");
  return cycle;
}

export function lyricExtraLabel(extra: LyricsExtra): string {
  if (extra === "meaning") return "意";
  if (extra === "romaji") return "音";
  return "原";
}

export function lyricExtraTitle(extra: LyricsExtra): string {
  if (extra === "meaning") return "翻译（点击切换）";
  if (extra === "romaji") return "罗马音（点击切换）";
  return "原词（点击切换）";
}

function normalizeAsideFace(value: unknown): LyricsAsideFace {
  return value === "detail" || value === "lyrics" ? value : DEFAULTS.asideFace;
}

function pickPrefs(state: LyricsPrefs): LyricsPrefs {
  return {
    autoShow: state.autoShow,
    engines: [...state.engines],
    displaySource: state.displaySource,
    tryOnlineWhenMissing: state.tryOnlineWhenMissing,
    lyricExtra: state.lyricExtra,
    asideFace: state.asideFace,
    desktopEnabled: state.desktopEnabled,
    desktopPosition: state.desktopPosition,
    desktopLocked: state.desktopLocked,
    desktopFontScale: state.desktopFontScale,
    desktopPositionX: state.desktopPositionX,
    desktopPositionY: state.desktopPositionY,
    desktopAccentMode: state.desktopAccentMode,
    desktopAccent: state.desktopAccent,
    desktopAccentEnd: state.desktopAccentEnd,
    desktopSecondaryMode: state.desktopSecondaryMode,
    desktopSecondaryAccent: state.desktopSecondaryAccent,
    desktopSecondaryAccentEnd: state.desktopSecondaryAccentEnd,
    desktopDimMode: state.desktopDimMode,
    desktopDim: state.desktopDim,
    desktopDimEnd: state.desktopDimEnd,
    desktopStrokeMode: state.desktopStrokeMode,
    desktopStroke: state.desktopStroke,
    desktopStrokeEnd: state.desktopStrokeEnd,
    desktopOpacity: state.desktopOpacity,
  };
}

function load(): LyricsPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS, engines: [...DEFAULTS.engines] };
    const data = raw as Partial<LyricsPrefs> & {
      floatWindow?: boolean;
      showTranslation?: boolean;
      showRomaji?: boolean;
      desktopLockConfigured?: boolean;
      lyricsPrefsVersion?: number;
    };
    // 兼容旧键 floatWindow
    const autoShow =
      typeof data.autoShow === "boolean"
        ? data.autoShow
        : typeof data.floatWindow === "boolean"
          ? data.floatWindow
          : DEFAULTS.autoShow;
    // 兼容旧的双开关 → 单层状态
    let lyricExtra = normalizeExtra(data.lyricExtra);
    if (data.lyricExtra == null) {
      if (data.showRomaji === true) lyricExtra = "romaji";
      else if (data.showTranslation === false) lyricExtra = "off";
      else lyricExtra = "meaning";
    }
    return {
      autoShow,
      engines: normalizeEngines(data.engines),
      displaySource: normalizeSource(data.displaySource),
      // 0.2.27 的这个开关默认是 false，且没有版本标记；未明确配置过的旧状态
      // 统一迁到新的默认行为，避免升级后“无本地歌词”的曲目继续全部空白。
      tryOnlineWhenMissing:
        data.lyricsPrefsVersion === ONLINE_LYRICS_PREF_VERSION
          ? typeof data.tryOnlineWhenMissing === "boolean"
            ? data.tryOnlineWhenMissing
            : DEFAULTS.tryOnlineWhenMissing
          : true,
      lyricExtra,
      asideFace: normalizeAsideFace(data.asideFace),
      desktopEnabled:
        typeof data.desktopEnabled === "boolean" ? data.desktopEnabled : DEFAULTS.desktopEnabled,
      desktopPosition: normalizeDesktopPosition(data.desktopPosition),
      // 第一版开发态曾默认锁定，导致一打开就完全收不到拖动事件；没有配置标记的一律迁回可拖动。
      desktopLocked:
        data.desktopLockConfigured === true && typeof data.desktopLocked === "boolean"
          ? data.desktopLocked
          : DEFAULTS.desktopLocked,
      desktopFontScale: normalizeDesktopFontScale(data.desktopFontScale),
      desktopPositionX: normalizeCoordinate(data.desktopPositionX),
      desktopPositionY: normalizeCoordinate(data.desktopPositionY),
      ...(() => {
        const accent = normalizePaint(
          data.desktopAccentMode,
          data.desktopAccent,
          data.desktopAccentEnd,
          DEFAULT_ACCENT_PAINT,
        );
        const secondary = normalizePaint(
          data.desktopSecondaryMode,
          data.desktopSecondaryAccent,
          data.desktopSecondaryAccentEnd,
          DEFAULT_SECONDARY_PAINT,
          { allowFollow: true },
        );
        const dim = normalizePaint(
          data.desktopDimMode,
          data.desktopDim,
          data.desktopDimEnd,
          DEFAULT_DIM_PAINT,
        );
        const stroke = normalizePaint(
          data.desktopStrokeMode,
          data.desktopStroke,
          data.desktopStrokeEnd,
          DEFAULT_STROKE_PAINT,
          true,
        );
        // 旧版「单色 + 纯白/纯黑」迁到黑/白预设，避免色相线左右端再塞灰阶。
        const migrateBw = (paint: LyricsColorPaint) => {
          if (paint.mode !== "solid") return paint;
          if (paint.start === "#ffffff") return { ...paint, mode: "white" as const };
          if (paint.start === "#000000") return { ...paint, mode: "black" as const };
          return paint;
        };
        const accentNext = migrateBw(accent);
        const secondaryNext =
          secondary.mode === "follow" ? secondary : migrateBw(secondary);
        // 旧默认 solid #9e9e9e 迁到「灰」预设。
        const dimNext =
          dim.mode === "solid" && dim.start === "#9e9e9e"
            ? { ...dim, mode: "gray" as const }
            : migrateBw(dim);
        const strokeNext = migrateBw(stroke);
        return {
          desktopAccentMode: accentNext.mode as LyricsFillMode,
          desktopAccent: accentNext.start,
          desktopAccentEnd: accentNext.end,
          desktopSecondaryMode: secondaryNext.mode as LyricsSecondaryMode,
          desktopSecondaryAccent: secondaryNext.start,
          desktopSecondaryAccentEnd: secondaryNext.end,
          desktopDimMode: dimNext.mode as LyricsFillMode,
          desktopDim: dimNext.start,
          desktopDimEnd: dimNext.end,
          desktopStrokeMode: strokeNext.mode as LyricsStrokeMode,
          desktopStroke: strokeNext.start,
          desktopStrokeEnd: strokeNext.end,
        };
      })(),
      desktopOpacity: normalizeOpacity(data.desktopOpacity),
    };
  } catch {
    return { ...DEFAULTS, engines: [...DEFAULTS.engines] };
  }
}

function save(prefs: LyricsPrefs): void {
  writeLocalStorageSoon(
    STORAGE_KEY,
    JSON.stringify({
      ...pickPrefs(prefs),
      desktopLockConfigured: true,
      lyricsPrefsVersion: ONLINE_LYRICS_PREF_VERSION,
    }),
    750,
  );
  // 桌面歌词是独立 WebView：WKWebView 往往不派发跨窗 storage 事件，改用 Tauri 广播。
  notifyPrefsChanged();
}

function notifyPrefsChanged(): void {
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit("lyrics-prefs-changed"))
    .catch(() => {});
}

/** 引擎或显示来源变了：清缓存，正在播的歌会重新按新偏好搜。 */
function bustLyricsCache(): void {
  void import("../stores/lyricsStore").then(({ useLyricsStore }) => {
    useLyricsStore.getState().clear();
  });
}

interface LyricsPrefsState extends LyricsPrefs {
  /** 引擎 / 显示来源变更计数；LyricsHost 用来触发重搜。 */
  prefsEpoch: number;
  setAutoShow(value: boolean): void;
  setEngines(engines: LyricsEngine[]): void;
  toggleEngine(engine: LyricsEngine): void;
  setDisplaySource(source: LyricsDisplaySource): void;
  setTryOnlineWhenMissing(value: boolean): void;
  setLyricExtra(extra: LyricsExtra): void;
  setAsideFace(face: LyricsAsideFace): void;
  setDesktopEnabled(value: boolean): void;
  setDesktopPosition(value: DesktopLyricsPosition): void;
  setDesktopLocked(value: boolean): void;
  setDesktopFontScale(value: number): void;
  setDesktopAccentPaint(paint: LyricsColorPaint): void;
  setDesktopSecondaryPaint(paint: LyricsColorPaint): void;
  setDesktopDimPaint(paint: LyricsColorPaint): void;
  setDesktopStrokePaint(paint: LyricsColorPaint): void;
  setDesktopOpacity(value: number): void;
  setDesktopCoordinates(x: number, y: number): void;
  /** Android 浮层满宽，只有垂直偏移会变。 */
  setDesktopVerticalOffset(y: number): void;
  /** 从另一个 WebView 写入的 localStorage 重新同步偏好。 */
  syncFromStorage(): void;
  /** 每次启动：收起桌面歌词，不自动弹出。 */
  prepareForStartup(): void;
  /** 按本首歌可用层循环切换。 */
  cycleLyricExtra(hasMeaning: boolean, hasRomaji: boolean): void;
}

export const useLyricsPrefs = create<LyricsPrefsState>((set, get) => ({
  ...load(),
  prefsEpoch: 0,
  setAutoShow(autoShow) {
    const next = { ...get(), autoShow };
    set({ autoShow });
    save(next);
    if (!autoShow) {
      void import("../stores/appStore").then(({ useAppStore }) => {
        if (useAppStore.getState().showLyrics) useAppStore.getState().dismissOverlay();
      });
    }
  },
  setEngines(engines) {
    const normalized = normalizeEngines(engines);
    let displaySource = get().displaySource;
    // 关掉的正是强制来源时，退回跟随。
    if (
      (displaySource === "wyy" ||
        displaySource === "qqm" ||
        displaySource === "ytm") &&
      !normalized.includes(displaySource)
    ) {
      displaySource = "follow";
    }
    set((state) => ({
      engines: normalized,
      displaySource,
      prefsEpoch: state.prefsEpoch + 1,
    }));
    save({ ...get(), engines: normalized, displaySource });
    bustLyricsCache();
  },
  toggleEngine(engine) {
    const current = get().engines;
    let engines: LyricsEngine[];
    let displaySource = get().displaySource;
    if (current.includes(engine)) {
      // 至少留一家，避免两边都关掉后没法搜。
      engines = current.filter((item) => item !== engine);
      if (!engines.length) return;
      // 关掉的正是强制来源时，退回跟随。
      if (displaySource === engine) displaySource = "follow";
    } else {
      engines = [...current, engine];
    }
    set((state) => ({ engines, displaySource, prefsEpoch: state.prefsEpoch + 1 }));
    save({ ...get(), engines, displaySource });
    bustLyricsCache();
  },
  setDisplaySource(displaySource) {
    const source = normalizeSource(displaySource);
    let engines = get().engines;
    // 强制某家时自动启用对应引擎。
    if ((source === "wyy" || source === "qqm" || source === "ytm") && !engines.includes(source)) {
      engines = [...engines, source];
    }
    set((state) => ({ displaySource: source, engines, prefsEpoch: state.prefsEpoch + 1 }));
    save({ ...get(), displaySource: source, engines });
    bustLyricsCache();
  },
  setTryOnlineWhenMissing(tryOnlineWhenMissing) {
    set((state) => ({
      tryOnlineWhenMissing,
      prefsEpoch: state.prefsEpoch + 1,
    }));
    save({ ...get(), tryOnlineWhenMissing });
    bustLyricsCache();
  },
  setLyricExtra(lyricExtra) {
    const extra = normalizeExtra(lyricExtra);
    set({ lyricExtra: extra });
    save({ ...get(), lyricExtra: extra });
  },
  setAsideFace(asideFace) {
    const face = normalizeAsideFace(asideFace);
    set({ asideFace: face });
    save({ ...get(), asideFace: face });
  },
  setDesktopEnabled(desktopEnabled) {
    set({ desktopEnabled });
    save({ ...get(), desktopEnabled });
  },
  setDesktopPosition(desktopPosition) {
    const position = normalizeDesktopPosition(desktopPosition);
    set({ desktopPosition: position, desktopPositionX: null, desktopPositionY: null });
    save({
      ...get(),
      desktopPosition: position,
      desktopPositionX: null,
      desktopPositionY: null,
    });
  },
  setDesktopLocked(desktopLocked) {
    set({ desktopLocked });
    save({ ...get(), desktopLocked });
  },
  setDesktopFontScale(desktopFontScale) {
    const scale = normalizeDesktopFontScale(desktopFontScale);
    set({ desktopFontScale: scale });
    save({ ...get(), desktopFontScale: scale });
  },
  setDesktopAccentPaint(paint) {
    const next = normalizePaint(paint.mode, paint.start, paint.end, DEFAULT_ACCENT_PAINT);
    const mode = (next.mode === "none" ? "solid" : next.mode) as LyricsFillMode;
    const patch = {
      desktopAccentMode: mode,
      desktopAccent: next.start,
      desktopAccentEnd: next.end,
    };
    set(patch);
    save({ ...get(), ...patch });
  },
  setDesktopSecondaryPaint(paint) {
    const next = normalizePaint(paint.mode, paint.start, paint.end, DEFAULT_SECONDARY_PAINT, {
      allowFollow: true,
    });
    const mode = (
      next.mode === "none" ? "solid" : next.mode === "follow" ? "follow" : next.mode
    ) as LyricsSecondaryMode;
    const patch = {
      desktopSecondaryMode: mode,
      desktopSecondaryAccent: next.start,
      desktopSecondaryAccentEnd: next.end,
    };
    set(patch);
    save({ ...get(), ...patch });
  },
  setDesktopDimPaint(paint) {
    const next = normalizePaint(paint.mode, paint.start, paint.end, DEFAULT_DIM_PAINT);
    const mode = (
      next.mode === "none" || next.mode === "follow" ? "gray" : next.mode
    ) as LyricsFillMode;
    const patch = {
      desktopDimMode: mode,
      desktopDim: next.start,
      desktopDimEnd: next.end,
    };
    set(patch);
    save({ ...get(), ...patch });
  },
  setDesktopStrokePaint(paint) {
    const next = normalizePaint(paint.mode, paint.start, paint.end, DEFAULT_STROKE_PAINT, true);
    const patch = {
      desktopStrokeMode: next.mode as LyricsStrokeMode,
      desktopStroke: next.start,
      desktopStrokeEnd: next.end,
    };
    set(patch);
    save({ ...get(), ...patch });
  },
  setDesktopOpacity(value) {
    const desktopOpacity = normalizeOpacity(value);
    set({ desktopOpacity });
    save({ ...get(), desktopOpacity });
  },
  setDesktopCoordinates(x, y) {
    const desktopPositionX = normalizeCoordinate(x);
    const desktopPositionY = normalizeCoordinate(y);
    if (desktopPositionX == null || desktopPositionY == null) return;
    set({ desktopPositionX, desktopPositionY });
    save({ ...get(), desktopPositionX, desktopPositionY });
  },
  setDesktopVerticalOffset(y) {
    const desktopPositionY = normalizeCoordinate(y);
    if (desktopPositionY == null) return;
    set({ desktopPositionY });
    save({ ...get(), desktopPositionY });
  },
  syncFromStorage() {
    const next = load();
    set((state) => ({ ...next, prefsEpoch: state.prefsEpoch + 1 }));
  },
  prepareForStartup() {
    const state = get();
    if (state.desktopEnabled) {
      set({ desktopEnabled: false });
      save({ ...pickPrefs(state), desktopEnabled: false });
    }
    const control = window.kdj?.desktopLyrics;
    if (!control) return;
    void control({
      visible: false,
      position: state.desktopPosition,
      locked: state.desktopLocked,
      fontScale: state.desktopFontScale,
      reposition: false,
      x: state.desktopPositionX,
      y: state.desktopPositionY,
      accent: state.desktopAccent,
      accentEnd: state.desktopAccentEnd,
      accentMode: state.desktopAccentMode,
      secondaryAccent: state.desktopSecondaryAccent,
      secondaryAccentEnd: state.desktopSecondaryAccentEnd,
      secondaryMode: state.desktopSecondaryMode,
      dim: state.desktopDim,
      dimEnd: state.desktopDimEnd,
      dimMode: state.desktopDimMode,
      stroke: state.desktopStroke,
      strokeEnd: state.desktopStrokeEnd,
      strokeMode: state.desktopStrokeMode,
      opacity: state.desktopOpacity,
    }).catch(() => undefined);
  },
  cycleLyricExtra(hasMeaning, hasRomaji) {
    const cycle = lyricExtraCycle(hasMeaning, hasRomaji);
    if (cycle.length < 2) return;
    const current = get().lyricExtra;
    const index = cycle.indexOf(current);
    const next = cycle[(index >= 0 ? index + 1 : 0) % cycle.length];
    set({ lyricExtra: next });
    save({ ...get(), lyricExtra: next });
  },
}));
