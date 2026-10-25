import { mediaProductionAvailable } from "./platformFeatures";
import { create } from "zustand";
import type { TrackSummary } from "../types";
import { isImageTrack, isVideoTrack } from "./format";

/**
 * Whether the playing song's visualizer floats over the app. A session choice, not a preference.
 * It says the window is wanted, not that it is on screen: a song with no picture passes without
 * one while this stays on (see visualizerPopupPicture.ts).
 */
export const useVisualizerPopup = create<{ open: boolean; track: TrackSummary | null; openTrack(track: TrackSummary): void; setOpen(open: boolean): void }>((set) => ({
  open: false, track: null,
  openTrack: track => set({ open: true, track: { ...track } }),
  setOpen: open => set({ open, track: null }),
}));

/** Local audio only: videos have their own picture, streams and images have no analysis. */
export function canVisualizeTrack<T extends TrackSummary>(track: T | null): track is T {
  return mediaProductionAvailable() && !!track && track.id > 0 && !isVideoTrack(track.format) && !isImageTrack(track.format);
}
