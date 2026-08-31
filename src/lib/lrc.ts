/** 一行带时间轴的 LRC。 */
export interface LrcWord {
  /** 绝对播放时间（秒）。 */
  start: number;
  /** 绝对播放时间（秒）。 */
  end: number;
  text: string;
}

export interface LrcLine {
  time: number;
  text: string;
  /** 平台明确给出的行结束；到点后应清空，不能一直挂到下一句或曲终。 */
  endTime?: number;
  /** 平台给出的真实逐字/音节区间；缺失时只做行级高亮。 */
  words?: LrcWord[];
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

export interface ParseLrcOptions {
  /** 应用 `[offset:±毫秒]`；QQ 时间轴需要，其他来源维持现有行为。 */
  honorOffset?: boolean;
}

/**
 * 把 LRC 文本拆成按时间排序的可见行。
 *
 * 空正文时间戳不渲染成空行，但会成为上一句的明确结束边界。网易云常用这种
 * 写法清掉间奏/尾奏前的歌词；丢掉它会让上一句错误地挂到下一句或曲终。
 */
export function parseLrc(raw: string, options: ParseLrcOptions = {}): LrcLine[] {
  const lines: LrcLine[] = [];
  const emptyBoundaries: number[] = [];
  const rows = raw.split(/\r?\n/);
  // LRC 的全局 offset 单位是毫秒：正数让歌词更早出现，负数让歌词更晚出现。
  // 目前只为 QQ 开启；忽略它时整首词会保持一个固定的提前/延后量。
  let offsetMs = 0;
  if (options.honorOffset) {
    for (const row of rows) {
      const match = row.trim().match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
      if (match) offsetMs = Number(match[1]);
    }
  }
  const offsetSec = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0;

  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed.startsWith("[")) continue;
    const stamps = [...trimmed.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = trimmed.replace(/^(?:\[[^\]]*\])+\s*/, "").trim();
    for (const stamp of stamps) {
      const time = parseStamp(stamp[1]!, stamp[2]!, stamp[3]);
      if (!Number.isFinite(time)) continue;
      const adjusted = time - offsetSec;
      if (text) lines.push({ time: adjusted, text });
      else emptyBoundaries.push(adjusted);
    }
  }
  lines.sort((a, b) => a.time - b.time);
  emptyBoundaries.sort((a, b) => a - b);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextTime = lines[index + 1]?.time ?? Number.POSITIVE_INFINITY;
    const boundary = emptyBoundaries.find(
      (time) => time > line.time && time < nextTime,
    );
    if (boundary !== undefined) line.endTime = boundary;
  }
  return lines;
}

/** 不考虑结束边界，返回已经开始的最后一行；还没到第一句时返回 -1。 */
export function startedLrcIndex(lines: LrcLine[], position: number): number {
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

/** 当前播放位置应对齐的行下标；前奏或明确的空白区间返回 -1。 */
export function activeLrcIndex(lines: LrcLine[], position: number): number {
  const hit = startedLrcIndex(lines, position);
  if (hit < 0) return -1;
  const endTime = lines[hit]!.endTime;
  return endTime !== undefined && position >= endTime ? -1 : hit;
}

/** 解析网易云 `/song/lyric/v1` 返回的 YRC 逐字时间轴。 */
export function parseNeteaseWordLrc(raw: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const header = row.match(/^\[(-?\d+),(-?\d+)\]/);
    if (!header) continue; // 新版响应开头可能是 JSON 创作者元数据。
    const lineStartMs = Number(header[1]);
    const lineDurationMs = Number(header[2]);
    if (!Number.isFinite(lineStartMs) || !Number.isFinite(lineDurationMs)) continue;

    const body = row.slice(header[0].length);
    const markers = [...body.matchAll(/\((-?\d+),(-?\d+),[^)]*\)/g)];
    const words: LrcWord[] = [];
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index]!;
      const startMs = Number(marker[1]);
      const durationMs = Number(marker[2]);
      const textStart = (marker.index ?? 0) + marker[0].length;
      const textEnd = markers[index + 1]?.index ?? body.length;
      const text = body.slice(textStart, textEnd);
      if (
        !text ||
        !Number.isFinite(startMs) ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
      ) continue;
      words.push({
        start: startMs / 1_000,
        end: (startMs + durationMs) / 1_000,
        text,
      });
    }
    const text = words.map((word) => word.text).join("");
    if (!text.trim()) continue;
    const time = lineStartMs / 1_000;
    const declaredEnd = (lineStartMs + Math.max(0, lineDurationMs)) / 1_000;
    const lastWordEnd = words.at(-1)?.end ?? time;
    const endTime = Math.max(declaredEnd, lastWordEnd);
    lines.push({
      time,
      text,
      ...(endTime > time ? { endTime } : {}),
      words,
    });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/**
 * Project a sparse player snapshot for karaoke rendering. Once transport enters an active loop,
 * fold wall-clock progress into that exact source interval; clearing the loop immediately restores
 * linear projection. This prevents the lyric clock from running past loop-out then snapping back.
 */
export function projectLoopedPlaybackTime(
  anchorMedia: number,
  elapsedSeconds: number,
  rate: number,
  loopStart: number | null | undefined,
  loopLength: number | null | undefined,
): number {
  const anchor = Number.isFinite(anchorMedia) ? anchorMedia : 0;
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  // Audible callback rate is signed: zero freezes a parked platter and negative values let
  // karaoke follow reverse scratch instead of continuing forward on the target TEMPO.
  const speed = Number.isFinite(rate) ? rate : 1;
  const linear = anchor + elapsed * speed;
  if (
    typeof loopStart !== "number"
    || typeof loopLength !== "number"
    || !Number.isFinite(loopStart)
    || !Number.isFinite(loopLength)
    || loopStart < 0
    || loopLength <= 0
    || linear < loopStart
  ) return linear;
  const relative = (linear - loopStart) % loopLength;
  return loopStart + (relative < 0 ? relative + loopLength : relative);
}

/**
 * 与 Android `LyricsOverlayRuntime.fillOf` 对齐：按平台逐字区间计算 0..1。
 * 只有行级 LRC 时用本句到下一句/空白边界的区间推进，不再按字数猜时长。
 */
export function lineFillProgress(
  lines: LrcLine[],
  index: number,
  positionSec: number,
): number {
  if (index < 0 || index >= lines.length) return 0;
  const line = lines[index]!;
  if (positionSec < line.time) return 0;
  const words = line.words?.filter((word) => word.text.length > 0) ?? [];
  if (!words.length) {
    const endTime = line.endTime ?? lines[index + 1]?.time ?? line.time + FALLBACK_LINE_SEC;
    const span = endTime - line.time;
    if (span <= 0) return 1;
    return Math.min(1, Math.max(0, (positionSec - line.time) / span));
  }

  const total = words.reduce((sum, word) => sum + word.text.length, 0);
  if (total <= 0) return 1;
  let completed = 0;
  for (const word of words) {
    const weight = word.text.length;
    if (positionSec < word.start) return completed / total;
    const span = word.end - word.start;
    if (span > 0 && positionSec < word.end) {
      const within = Math.min(1, Math.max(0, (positionSec - word.start) / span));
      return (completed + weight * within) / total;
    }
    completed += weight;
  }
  return 1;
}

/** 最后一行既没有结束标记也没有下一句时，只能给出有限的行级退回区间。 */
const FALLBACK_LINE_SEC = 6;
