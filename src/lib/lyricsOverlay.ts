/**
 * 系统级歌词悬浮窗的前端侧逻辑：权限引导 + 把歌词缓存摊平成原生要的时间轴。
 *
 * Android 的浮层是原生 View，滚动由持有 ExoPlayer 的原生侧驱动，所以前端只在
 * 换歌或切附加层时推一次整首歌的时间轴（见 `KdjBridge.lyricsTimeline`）。
 * 桌面的歌词窗口是另一个 WebView，自己订阅 store，不走这条路。
 */

import type { LrcLine } from "./lrc";
import type { LyricsExtra } from "./lyricsPrefs";
import type { LyricsEntry } from "../stores/lyricsStore";

/** 用户去系统设置里授权的往返时间；比这还久就当放弃了。 */
const GRANT_TIMEOUT_MS = 90_000;
const GRANT_POLL_MS = 700;

/** 本次安装是否可能有系统级悬浮歌词（目前只有 Android）。 */
export function overlayPermissionSupported(): boolean {
  return Boolean(window.kdj?.overlayPermission);
}

export async function overlayPermissionGranted(): Promise<boolean> {
  const control = window.kdj?.overlayPermission;
  if (!control) return true;
  return control.check().catch(() => false);
}

let pendingGrant: Promise<boolean> | null = null;

/**
 * 确保拿到「显示在其他应用上层」权限，没有就拉起系统设置页并等用户回来。
 *
 * 不需要该权限的平台（桌面）直接返回 true。用户连点开关时共用同一次等待，
 * 否则会叠出好几个系统设置页。
 */
export function ensureOverlayPermission(): Promise<boolean> {
  const control = window.kdj?.overlayPermission;
  if (!control) return Promise.resolve(true);
  if (pendingGrant) return pendingGrant;

  const run = (async () => {
    if (await control.check().catch(() => false)) return true;
    await control.request();
    const deadline = Date.now() + GRANT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await waitTickOrForeground(GRANT_POLL_MS);
      if (await control.check().catch(() => false)) return true;
    }
    return false;
  })();

  pendingGrant = run;
  void run.finally(() => {
    pendingGrant = null;
  });
  return run;
}

/**
 * 等一小会儿，但用户从系统设置切回来时立刻返回——授权后马上生效比
 * 卡在下一个轮询点更重要。
 */
function waitTickOrForeground(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      resolve();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") finish();
    };
    const timer = window.setTimeout(finish, ms);
    document.addEventListener("visibilitychange", onVisibility);
  });
}

/** 本首歌实际有哪层就用哪层；偏好指向的层缺失时退回原词。 */
export function effectiveLyricExtra(
  preferred: LyricsExtra,
  hasMeaning: boolean,
  hasRomaji: boolean,
): LyricsExtra {
  if (preferred === "meaning" && hasMeaning) return "meaning";
  if (preferred === "romaji" && hasRomaji) return "romaji";
  return "off";
}

/** 附加层与主词各有一套时间戳，靠时间对齐而不是靠下标——两边行数常常不等。 */
function alignByTime(lines: LrcLine[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of lines) {
    const text = line.text.trim();
    if (text) map.set(Math.round(line.time * 100), text);
  }
  return map;
}

export interface OverlayTimelinePayload {
  trackId: number | null;
  duration: number;
  placeholder: string;
  lines: { time: number; text: string; secondary?: string }[];
}

/**
 * 把歌词缓存里的一条 entry 摊平成原生时间轴。
 *
 * 还在搜词或压根没有歌词时返回空 lines + 一句 placeholder，与桌面歌词窗口
 * 显示的文案保持一致，免得两个平台看起来像两个功能。
 */
export function buildOverlayTimeline(options: {
  trackId: number | null;
  title: string;
  duration: number;
  entry: LyricsEntry;
  extra: LyricsExtra;
}): OverlayTimelinePayload {
  const { trackId, title, duration, entry, extra } = options;
  const base: Omit<OverlayTimelinePayload, "lines" | "placeholder"> = { trackId, duration };

  if (entry.status === "idle" || entry.status === "loading") {
    return { ...base, placeholder: `${title} · 正在搜歌词…`, lines: [] };
  }
  if (entry.status === "error" || entry.status === "empty" || !entry.lines.length) {
    return { ...base, placeholder: entry.error || "没有找到歌词", lines: [] };
  }

  const hasMeaning = entry.translated.some((line) => line.text.trim());
  const hasRomaji = entry.romaji.some((line) => line.text.trim());
  const layer = effectiveLyricExtra(extra, hasMeaning, hasRomaji);
  const secondaryByTime =
    layer === "meaning"
      ? alignByTime(entry.translated)
      : layer === "romaji"
        ? alignByTime(entry.romaji)
        : null;

  return {
    ...base,
    placeholder: "",
    lines: entry.lines.map((line) => ({
      time: line.time,
      text: line.text,
      secondary: secondaryByTime?.get(Math.round(line.time * 100)),
    })),
  };
}
