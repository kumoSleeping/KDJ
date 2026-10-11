/**
 * What the local track list asks the data lane for, from the rows the virtualizer renders
 * (components/common/rowList.ts). Indices here count rows; the pending downloads come before
 * the tracks, so a track index is a row index less `pending`, clamped to the tracks there are.
 */
export interface LibraryDemandInput {
  total: number;
  pending: number;
  /** Rows the list has rendered: [start, end). */
  start: number;
  end: number;
  /** Rows under the viewport: [visibleStart, visibleEnd). */
  visibleStart: number;
  visibleEnd: number;
  /** Rows a screen holds. */
  screen: number;
}

/** Rows are demanded a screen before they are rendered; the rest of the library follows in the background fill. */
export function libraryDemand(input: LibraryDemandInput) {
  const trackIndex = (index: number) => Math.min(input.total, Math.max(0, index - input.pending));
  return {
    fetchStart: trackIndex(input.start - input.screen),
    fetchEnd: trackIndex(input.end + input.screen),
    visibleTrackStart: trackIndex(input.visibleStart),
    visibleTrackEnd: trackIndex(input.visibleEnd),
  };
}

/** The offset that puts the row of `anchorId` (or the row at `fallbackIndex`) `rowOffset` pixels under the top. */
export function restoreLibraryAnchor(ids: readonly number[], anchorId: number | null, fallbackIndex: number,
  rowOffset: number, rowHeight: number, pending: number): number {
  const found = anchorId === null ? -1 : ids.indexOf(anchorId);
  const index = found >= 0 ? found : Math.min(Math.max(0, fallbackIndex), Math.max(0, ids.length - 1));
  return (pending + index) * rowHeight + Math.min(Math.max(0, rowOffset), rowHeight - 1);
}
