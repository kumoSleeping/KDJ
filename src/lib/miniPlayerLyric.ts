import { activeLrcIndex, type LrcLine } from "./lrc";

/**
 * The line that is being sung at `position` (seconds), as the lyrics panel finds it: empty
 * before the first line, between lines that say when they end, and for a line without words.
 */
export function lyricLineAt(lines: LrcLine[], position: number): string {
  const index = activeLrcIndex(lines, position);
  return index < 0 ? "" : lines[index]!.text.trim();
}
