export const TRACK_DRAG_STATE_EVENT = "kd:track-drag-state";
export const TRACK_TRASH_DROP_EVENT = "kd:track-trash-drop";

export interface TrackDragDetail {
  ids: number[];
}

export function announceTrackDrag(ids: number[]): void {
  window.dispatchEvent(new CustomEvent<TrackDragDetail>(TRACK_DRAG_STATE_EVENT, { detail: { ids } }));
}

export function endTrackDrag(): void {
  window.dispatchEvent(new CustomEvent<TrackDragDetail>(TRACK_DRAG_STATE_EVENT, { detail: { ids: [] } }));
}
