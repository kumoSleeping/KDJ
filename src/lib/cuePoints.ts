import type { CuePoint } from "../types";

const CUE_COLORS: Record<string, { css: string; label: string; text: string }> = {
  pink: { css: "#e6579a", label: "粉色", text: "#fff" },
  red: { css: "#e5484d", label: "红色", text: "#fff" },
  orange: { css: "#ed7b2f", label: "橙色", text: "#fff" },
  yellow: { css: "#d4a900", label: "黄色", text: "#171717" },
  green: { css: "#2eaa62", label: "绿色", text: "#fff" },
  aqua: { css: "#1599ad", label: "青色", text: "#fff" },
  cyan: { css: "#1599ad", label: "青色", text: "#fff" },
  blue: { css: "#4676df", label: "蓝色", text: "#fff" },
  purple: { css: "#9656cc", label: "紫色", text: "#fff" },
};

function colorDefinition(cue: CuePoint) {
  const name = typeof cue.color === "string" ? cue.color.trim().toLowerCase() : "";
  return name ? CUE_COLORS[name] ?? null : null;
}

/** 把标准色名转换为波形和色块共用的可见 sRGB。 */
export function cueColor(cue: CuePoint): string {
  return colorDefinition(cue)?.css ?? "#7d8796";
}

export function cueTextColor(cue: CuePoint): string {
  return colorDefinition(cue)?.text ?? "#fff";
}

export function cueColorLabel(cue: CuePoint): string {
  const definition = colorDefinition(cue);
  if (definition) return definition.label;
  if (cue.color.trim()) return cue.color.trim();
  return cue.color_index !== null ? `颜色 ${cue.color_index}` : "";
}

/** Hot Cue 1..26 沿用 DJ 软件常见的 A..Z 标记，更大的编号保持数字。 */
export function hotCueLabel(value: number | null): string {
  if (value === null || !Number.isInteger(value) || value <= 0) return "";
  return value <= 26 ? String.fromCharCode(64 + value) : String(value);
}

export function cueTypeLabel(cue: CuePoint): string {
  const loop = cue.end_ms !== null;
  const hot = hotCueLabel(cue.hot_cue);
  if (hot) return `${loop ? "Hot Loop" : "Hot Cue"} ${hot}`;
  return loop ? "Memory Loop" : "Memory Cue";
}

export function formatCueTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  const main = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${main}.${String(millis).padStart(3, "0")}`;
}

export function cueTimeRange(cue: CuePoint): string {
  const start = formatCueTime(cue.start_ms);
  return cue.end_ms === null ? start : `${start} – ${formatCueTime(cue.end_ms)}`;
}

export function cueTitle(cue: CuePoint): string {
  const comment = typeof cue.comment === "string" ? cue.comment.trim() : "";
  return [cueTypeLabel(cue), cueTimeRange(cue), cueColorLabel(cue), comment]
    .filter(Boolean)
    .join(" · ");
}

/** 现场 Loop（不是某个 Cue Loop）用的预览色，避开 8 个 Hot Cue 色板。 */
export const DEFAULT_LOOP_OVERLAY_COLOR = "#5eb8ff";
const LOOP_ALIGN_MS = 12;

export interface WaveformLoopRegion {
  key: string;
  startSec: number;
  endSec: number;
  color: string;
  active: boolean;
}

export function cueNearTime(
  cues: readonly CuePoint[],
  timeSec: number,
  windowMs = LOOP_ALIGN_MS,
): CuePoint | undefined {
  if (!Number.isFinite(timeSec)) return undefined;
  const ms = timeSec * 1_000;
  return cues.find((cue) => Math.abs(cue.start_ms - ms) <= windowMs);
}

/** 现场 Loop 若正好落在某个已存 Cue Loop 上，预览改用该 Cue 的颜色。 */
export function matchingLoopCue(
  cues: readonly CuePoint[],
  startSec: number,
  lengthSec: number,
  windowMs = LOOP_ALIGN_MS,
): CuePoint | undefined {
  if (!Number.isFinite(startSec) || !Number.isFinite(lengthSec) || lengthSec <= 0) return undefined;
  const startMs = startSec * 1_000;
  const endMs = (startSec + lengthSec) * 1_000;
  return cues.find((cue) => (
    cue.end_ms !== null
    && Math.abs(cue.start_ms - startMs) <= windowMs
    && Math.abs(cue.end_ms - endMs) <= windowMs
  ));
}

/**
 * 波形上要铺的 Loop 预览：已存 Cue Loop 始终画出区间；现场 Loop 若没有对上
 * Cue，就再铺一层默认色。对上了则只加强那条 Cue Loop，避免叠两层。
 */
export function waveformLoopRegions(
  cues: readonly CuePoint[],
  loopStartSec?: number | null,
  loopLengthSec?: number | null,
): WaveformLoopRegion[] {
  const live = typeof loopStartSec === "number"
    && Number.isFinite(loopStartSec)
    && typeof loopLengthSec === "number"
    && Number.isFinite(loopLengthSec)
    && loopLengthSec > 0
    ? { startSec: loopStartSec, endSec: loopStartSec + loopLengthSec }
    : null;
  const liveMatch = live ? matchingLoopCue(cues, live.startSec, live.endSec - live.startSec) : undefined;
  const regions: WaveformLoopRegion[] = [];
  for (const cue of cues) {
    if (cue.end_ms === null || cue.end_ms <= cue.start_ms) continue;
    regions.push({
      key: `cue-loop:${cue.id}`,
      startSec: cue.start_ms / 1_000,
      endSec: cue.end_ms / 1_000,
      color: cueColor(cue),
      active: liveMatch?.id === cue.id,
    });
  }
  if (live && !liveMatch) {
    regions.push({
      key: "live-loop",
      startSec: live.startSec,
      endSec: live.endSec,
      color: DEFAULT_LOOP_OVERLAY_COLOR,
      active: true,
    });
  }
  return regions;
}
