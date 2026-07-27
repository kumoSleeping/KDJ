/**
 * Camelot（调号轮）纯函数 + 配色。
 * 映射表逐条对应 docs/00-architecture.md §3.3 的表格，不要凭印象改。
 */

export type CamelotLetter = "A" | "B";

export interface CamelotParts {
  number: number; // 1..12
  letter: CamelotLetter;
}

/** 轮上顺序：1A..12A（小调）在前，1B..12B（大调）在后。筛选下拉、图例都按这个顺序。 */
export const CAMELOT_ORDER: readonly string[] = [
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}A`),
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}B`),
];

/** Camelot → 音乐调名。A = 小调，B = 大调。 */
const CAMELOT_KEY_NAMES: Record<string, string> = {
  "1A": "Ab minor",
  "2A": "Eb minor",
  "3A": "Bb minor",
  "4A": "F minor",
  "5A": "C minor",
  "6A": "G minor",
  "7A": "D minor",
  "8A": "A minor",
  "9A": "E minor",
  "10A": "B minor",
  "11A": "F# minor",
  "12A": "Db minor",
  "1B": "B major",
  "2B": "F# major",
  "3B": "Db major",
  "4B": "Ab major",
  "5B": "Eb major",
  "6B": "Bb major",
  "7B": "F major",
  "8B": "C major",
  "9B": "G major",
  "10B": "D major",
  "11B": "A major",
  "12B": "E major",
};

/** `"8a"` / `" 8A "` 都能解析；非法返回 null（未分析的曲目 camelot 是空串）。 */
export function parseCamelot(code: string | null | undefined): CamelotParts | null {
  if (!code) return null;
  const matched = /^(\d{1,2})\s*([AaBb])$/.exec(code.trim());
  if (!matched) return null;
  const number = Number(matched[1]);
  if (number < 1 || number > 12) return null;
  return { number, letter: matched[2].toUpperCase() as CamelotLetter };
}

/** 整轮偏 15°，避开 0°（主色 #ef4444 就在那儿），免得某个调号块被当成品牌红。 */
const HUE_OFFSET = 15;

/**
 * 色轮配色：12 个色相按 30° 均匀铺满一圈，A 组低饱和、B 组高饱和（同号大小调一眼能配对）。
 * 亮度不是常数——黄色区天生比蓝色区亮，若统一 66% 黑字在蓝块上会发闷，
 * 所以按色相到蓝(240°)的余弦做 ±6% 补偿，最终落在 60%~72%，保证黑字全程可读。
 */
export function camelotColor(code: string | null | undefined): string {
  const parts = parseCamelot(code);
  if (!parts) return "transparent";
  const hue = ((parts.number - 1) * 30 + HUE_OFFSET) % 360;
  // A/B 仍用饱和度区分，但 A 不能低到在浅色主题里变成灰字。
  const saturation = parts.letter === "A" ? 60 : 80;
  const lightness = 66 + 6 * Math.cos(((hue - 240) * Math.PI) / 180);
  return `hsl(${hue} ${saturation}% ${Math.round(lightness)}%)`;
}

/**
 * 和声兼容的相邻调：轮上 -1、+1（同字母）与同号异字母（相对大小调）。
 * 非法输入返回空数组，调用方不用再判空。
 */
export function camelotNeighbours(code: string | null | undefined): string[] {
  const parts = parseCamelot(code);
  if (!parts) return [];
  const wrap = (n: number) => ((n - 1 + 12) % 12) + 1;
  const other: CamelotLetter = parts.letter === "A" ? "B" : "A";
  return [
    `${wrap(parts.number - 1)}${parts.letter}`,
    `${wrap(parts.number + 1)}${parts.letter}`,
    `${parts.number}${other}`,
  ];
}

/** `"8A"` → `"A minor"`；非法或未知返回空串，方便直接塞进 title/tooltip。 */
export function camelotToLabel(code: string | null | undefined): string {
  const parts = parseCamelot(code);
  if (!parts) return "";
  return CAMELOT_KEY_NAMES[`${parts.number}${parts.letter}`] ?? "";
}
