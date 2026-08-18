/** DJ library keeps only performance-relevant columns and fits them beside the fixed index. */
export const DJ_TRACK_TABLE_COLUMN_WIDTHS = {
  title: "38%",
  artist: "20%",
  bpm: "9%",
  camelot: "9%",
  duration: "14%",
} as const;

export function fitDjTrackColumns<T extends { key: string }>(columns: readonly T[]): T[] {
  return columns.filter((column) => column.key in DJ_TRACK_TABLE_COLUMN_WIDTHS);
}
