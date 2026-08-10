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
  return CUE_COLORS[cue.color.trim().toLowerCase()] ?? null;
}

/** OneLibrary 颜色表只存标准色名；这里给波形和色块统一转换为可见的 sRGB。 */
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
  return [cueTypeLabel(cue), cueTimeRange(cue), cueColorLabel(cue), cue.comment.trim()]
    .filter(Boolean)
    .join(" · ");
}
