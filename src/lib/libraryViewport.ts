export interface LibraryViewportInput {
  total: number; pending: number; top: number; height: number; rowHeight: number;
  headerHeight: number; velocity: number; latency: number;
}
export function libraryViewport(input: LibraryViewportInput) {
  const rowHeight = Math.max(1, input.rowHeight);
  const height = Math.max(rowHeight, input.height - input.headerHeight);
  const count = Math.max(0, input.total + input.pending);
  const maxTop = Math.max(0, count * rowHeight - height);
  const top = Math.min(maxTop, Math.max(0, input.top));
  const screen = Math.max(1, Math.ceil(height / rowHeight));
  const visibleStart = Math.min(count, Math.floor(top / rowHeight));
  const visibleEnd = Math.min(count, Math.ceil((top + height) / rowHeight));
  const fast = Math.abs(input.velocity) > 0.8;
  const ahead = fast ? Math.min(3 * screen, Math.max(screen, Math.ceil(Math.abs(input.velocity) * 100 / rowHeight))) : screen;
  const behind = fast ? Math.ceil(screen / 2) : screen;
  const start = Math.max(0, visibleStart - (input.velocity < 0 ? ahead : behind));
  const end = Math.min(count, visibleEnd + (input.velocity < 0 ? behind : ahead));
  const prefetch = Math.min(5, Math.max(1, Math.ceil(2 + Math.abs(input.velocity) * input.latency / height))) * screen;
  const trackIndex = (index: number) => Math.min(input.total, Math.max(0, index - input.pending));
  return { top, maxTop, count, start, end, visibleStart, visibleEnd,
    trackStart: trackIndex(Math.max(input.pending, start)), trackEnd: trackIndex(end),
    visibleTrackStart: trackIndex(visibleStart), visibleTrackEnd: trackIndex(visibleEnd),
    fetchStart: trackIndex(Math.max(0, visibleStart - (input.velocity < 0 ? prefetch : screen))),
    fetchEnd: trackIndex(Math.min(count, visibleEnd + (input.velocity < 0 ? screen : prefetch))),
  };
}

export function restoreLibraryAnchor(ids: readonly number[], anchorId: number | null, fallbackIndex: number,
  rowOffset: number, rowHeight: number, pending: number): number {
  const found = anchorId === null ? -1 : ids.indexOf(anchorId);
  const index = found >= 0 ? found : Math.min(Math.max(0, fallbackIndex), Math.max(0, ids.length - 1));
  return (pending + index) * rowHeight + Math.min(Math.max(0, rowOffset), rowHeight - 1);
}
