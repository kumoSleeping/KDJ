/**
 * 系统级歌词悬浮窗的前端侧逻辑：权限引导 + 把歌词缓存摊平成原生要的时间轴。
 *
 * Android 的浮层是原生 View：本地曲目由 Rust coordinator 镜像驱动，浏览器试听
 * 由限频外部时钟驱动，所以前端只在换歌或切附加层时推一次整首歌的时间轴
 * （见 `KdjBridge.lyricsTimeline`）。
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

/** 附加层与主词各有一套时间戳，靠最近时间对齐而不是靠下标——两边行数常常不等。 */
function alignedText(lines: LrcLine[], time: number): string | undefined {
  let best: LrcLine | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const distance = Math.abs(line.time - time);
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  // 网易云普通 LRC 与 YRC 常有几十毫秒取整差；更远则视为确实缺少该行。
  return bestDistance <= 0.12 ? best?.text.trim() : undefined;
}

export interface OverlayTimelinePayload {
  trackId: number | null;
  duration: number;
  placeholder: string;
  lines: {
    time: number;
    endTime?: number;
    text: string;
    secondary?: string;
    words?: { start: number; end: number; text: string }[];
  }[];
}

/**
 * 把歌词缓存里的一条 entry 摊平成原生时间轴。
 *
 * 还在搜词或确实没有歌词时返回空内容；只有真实错误才显示文案。
 */
export function buildOverlayTimeline(options: {
  trackId: number | null;
  duration: number;
  entry: LyricsEntry;
  extra: LyricsExtra;
}): OverlayTimelinePayload {
  const { trackId, duration, entry, extra } = options;
  const base: Omit<OverlayTimelinePayload, "lines" | "placeholder"> = { trackId, duration };

  if (entry.status === "idle" || entry.status === "loading") {
    return { ...base, placeholder: "", lines: [] };
  }
  if (entry.status === "error" || entry.status === "empty" || !entry.lines.length) {
    return {
      ...base,
      placeholder: entry.status === "error" ? "歌词暂时不可用" : "",
      lines: [],
    };
  }

  const hasMeaning = entry.translated.some((line) => line.text.trim());
  const hasRomaji = entry.romaji.some((line) => line.text.trim());
  const layer = effectiveLyricExtra(extra, hasMeaning, hasRomaji);
  const secondaryLines =
    layer === "meaning"
      ? entry.translated
      : layer === "romaji"
        ? entry.romaji
        : null;

  return {
    ...base,
    placeholder: "",
    lines: entry.lines.map((line) => ({
      time: line.time,
      endTime: line.endTime,
      text: line.text,
      secondary: secondaryLines ? alignedText(secondaryLines, line.time) : undefined,
      words: line.words,
    })),
  };
}
