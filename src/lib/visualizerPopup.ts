import { create } from "zustand";
import type { TrackSummary } from "../types";
import { isImageTrack, isVideoTrack } from "./format";
import { getPlayingTrack } from "./playingTrack";

/**
 * A song the window was asked to show by hand (the row's menu) while the player had `over`
 * (a song id, or null for nothing). It is the player's window all the same: the pin holds only
 * until the player's song changes, whether to the pinned song (its own play key) or to another
 * one (the bar's keys, the next song in the queue). Kept past that, the window stayed on a song
 * nobody was playing, with no clock to move it.
 */
export interface VisualizerPopupPin {
  track: TrackSummary;
  over: number | null;
}

/**
 * Whether the playing song's visualizer floats over the app. A session choice, not a preference.
 * It says the window is wanted, not that it is on screen: a song with no picture passes without
 * one while this stays on (see visualizerPopupPicture.ts).
 */
export const useVisualizerPopup = create<{ open: boolean; pin: VisualizerPopupPin | null; openTrack(track: TrackSummary): void; setOpen(open: boolean): void; release(): void }>((set) => ({
  open: false, pin: null,
  openTrack: track => set({ open: true, pin: { track: { ...track }, over: getPlayingTrack()?.id ?? null } }),
  setOpen: open => set({ open, pin: null }),
  release: () => set({ pin: null }),
}));

/** The pinned song while the player is still on what it had when the pin was made. */
export function pinnedPopupTrack(pin: VisualizerPopupPin | null, playingId: number | null): TrackSummary | null {
  return pin && pin.over === playingId ? pin.track : null;
}

/** Local audio only: videos have their own picture, streams and images have no analysis. */
export function canVisualizeTrack<T extends TrackSummary>(track: T | null): track is T {
  return !!track && track.id > 0 && !isVideoTrack(track.format) && !isImageTrack(track.format);
}
