/** 一行带时间轴的 LRC。 */
export interface LrcLine {
  time: number;
  text: string;
}

function parseStamp(min: string, sec: string, frac: string | undefined): number {
  const minutes = Number(min);
  const seconds = Number(sec);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return NaN;
  let millis = 0;
  if (frac) {
    // .93 → 930ms；.9 → 900ms；.935 → 935ms
    const padded = frac.length >= 3 ? frac.slice(0, 3) : frac.padEnd(3, "0");
    millis = Number(padded);
  }
  return minutes * 60 + seconds + millis / 1000;
}

/** 把 LRC 文本拆成按时间排序的行；纯元数据行（空正文）丢掉。 */
export function parseLrc(raw: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const trimmed = row.trim();
    if (!trimmed.startsWith("[")) continue;
    const stamps = [...trimmed.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = trimmed.replace(/^(?:\[[^\]]*\])+\s*/, "").trim();
    if (!text) continue;
    for (const stamp of stamps) {
      const time = parseStamp(stamp[1]!, stamp[2]!, stamp[3]);
      if (Number.isFinite(time)) lines.push({ time, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** 当前播放位置应对齐的行下标；还没到第一句时返回 -1。 */
export function activeLrcIndex(lines: LrcLine[], position: number): number {
  if (!lines.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.time <= position) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit;
}

/** 与 Android `LyricsOverlayRuntime.fillOf` 对齐：行内演唱进度 0..1。 */
const MIN_FILL_SEC = 1.2;
const PER_CHAR_SEC = 0.34;
const TAIL_LINE_SEC = 6;

/**
 * LRC 只有行级时间戳，行内只能线性推算。直接用「到下一行的间隔」当分母，
 * 遇到间奏会让填充慢到看不出在动，所以再按字数估一个合理演唱时长，取较小值：
 * 唱完就填满，剩下的时间停在满格等下一句。
 */
export function lineFillProgress(
  lines: LrcLine[],
  index: number,
  positionSec: number,
  durationSec = 0,
): number {
  if (index < 0 || index >= lines.length) return 0;
  const line = lines[index]!;
  const nextTime =
    lines[index + 1]?.time ??
    (durationSec > line.time ? durationSec : line.time + TAIL_LINE_SEC);
  const gap = nextTime - line.time;
  if (gap <= 0) return 1;
  const estimated = Math.max(MIN_FILL_SEC, line.text.length * PER_CHAR_SEC);
  const span = Math.min(gap, estimated);
  return Math.min(1, Math.max(0, (positionSec - line.time) / span));
}
