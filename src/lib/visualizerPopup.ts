import { create } from "zustand";
import type { Track } from "../types";
import { isImageTrack, isVideoTrack } from "./format";
import { isStreamTrack } from "./streamTrack";

/** Whether the playing song's visualizer floats over the app. A session choice, not a preference. */
export const useVisualizerPopup = create<{ open: boolean; setOpen(open: boolean): void }>((set) => ({
  open: false,
  setOpen: open => set({ open }),
}));

/** Local audio only: videos have their own picture, streams and images have no analysis. */
export function canVisualizeTrack(track: Track | null): track is Track {
  return !!track && !isStreamTrack(track) && !isVideoTrack(track.format) && !isImageTrack(track.format);
}
