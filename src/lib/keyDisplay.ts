import { camelotToLabel, parseCamelot } from "./camelot";
import type { KeyNotation } from "../types";

export interface TrackKeyFields {
  music_key?: string | null;
  camelot?: string | null;
}

const MINOR_BY_PITCH = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
const MAJOR_BY_PITCH = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];

function pitchClass(root: string): number | null {
  const byRoot: Record<string, number> = {
    c: 0, "b#": 0,
    "c#": 1, db: 1,
    d: 2,
    "d#": 3, eb: 3,
    e: 4, fb: 4,
    "e#": 5, f: 5,
    "f#": 6, gb: 6,
    g: 7,
    "g#": 8, ab: 8,
    a: 9,
    "a#": 10, bb: 10,
    b: 11, cb: 11,
  };
  return byRoot[root.toLocaleLowerCase()] ?? null;
}

/** 兼容常见 DJ/ID3 自由文本以及 KDJ、Camelot 调名。 */
export function keyTextToCamelot(value: string | null | undefined): string {
  const raw = value?.trim() ?? "";
  const direct = parseCamelot(raw);
  if (direct) return `${direct.number}${direct.letter}`;
  const normalized = raw.replaceAll("♯", "#").replaceAll("♭", "b");
  const matched = /^([A-Ga-g])([#b]?)(.*)$/.exec(normalized);
  if (!matched) return "";
  const pitch = pitchClass(`${matched[1]!.toUpperCase()}${matched[2] ?? ""}`);
  if (pitch === null) return "";
  const mode = matched[3]!.trim();
  let minor: boolean;
  if (mode === "" || mode === "M") minor = false;
  else if (mode === "m") minor = true;
  else {
    const lower = mode.toLocaleLowerCase();
    if (["major", "maj", "dur"].includes(lower)) minor = false;
    else if (["minor", "min", "mol"].includes(lower)) minor = true;
    else return "";
  }
  return (minor ? MINOR_BY_PITCH : MAJOR_BY_PITCH)[pitch] ?? "";
}

export function canonicalTrackCamelot(key: TrackKeyFields): string {
  const explicit = parseCamelot(key.camelot);
  if (explicit) return `${explicit.number}${explicit.letter}`;
  return keyTextToCamelot(key.music_key);
}

function shortTraditionalLabel(camelot: string, fallback: string): string {
  const traditional = camelotToLabel(camelot);
  if (!traditional) return fallback.trim();
  const [root, mode] = traditional.split(" ");
  return `${root} ${mode === "minor" ? "m" : "M"}`;
}

function transposeCamelot(camelot: string, semitones: number): string {
  const parsed = parseCamelot(camelot);
  if (!parsed) return "";
  const table = parsed.letter === "A" ? MINOR_BY_PITCH : MAJOR_BY_PITCH;
  const from = table.indexOf(`${parsed.number}${parsed.letter}`);
  if (from < 0) return "";
  const shift = Math.round(Number.isFinite(semitones) ? semitones : 0);
  return table[(from + shift % 12 + 12) % 12] ?? "";
}

/** Display-only current KEY after the realtime player transposes the analyzed source. */
export function displayTransposedTrackKey(
  key: TrackKeyFields,
  notation: KeyNotation,
  semitones: number,
): string {
  const original = canonicalTrackCamelot(key);
  const shifted = transposeCamelot(original, semitones);
  if (!shifted) return displayTrackKey(key, notation);
  return notation === "camelot" ? shifted : shortTraditionalLabel(shifted, key.music_key ?? "");
}

/** 显示偏好只决定渲染，不回写曲目；两种列表因此共用同一份确定转换。 */
export function displayTrackKey(key: TrackKeyFields, notation: KeyNotation): string {
  const camelot = canonicalTrackCamelot(key);
  if (notation === "camelot") return camelot || key.music_key?.trim() || "";
  return shortTraditionalLabel(camelot, key.music_key ?? "");
}

/** 筛选始终同时接受数字制和音名制，不因用户切换显示偏好而改变结果集合。 */
export function trackKeyMatches(key: TrackKeyFields, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    key.music_key ?? "",
    displayTrackKey(key, "camelot"),
    displayTrackKey(key, "traditional"),
  ].some((value) => value.toLocaleLowerCase() === needle);
}

export function trackKeySortValue(key: TrackKeyFields): number | null {
  const parsed = parseCamelot(canonicalTrackCamelot(key));
  return parsed ? parsed.number * 2 + (parsed.letter === "B" ? 1 : 0) : null;
}
