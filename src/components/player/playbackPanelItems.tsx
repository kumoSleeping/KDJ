import { AudioLines, TextQuote, Video, Music2, FilePenLine } from "lucide-react";
import type { Track } from "../../types";
import { isImageTrack, isVideoTrack } from "../../lib/format";
import { isStreamTrack } from "../../lib/streamTrack";

export const playbackPanelItems = {
  information: {label:"曲目信息", icon:<Music2 size={14} />},
  metadata: {label:"Meta", icon:<FilePenLine size={14} />},
  visualizer: { label: "视窗", icon: <AudioLines size={14} /> },
  lyrics: { label: "歌词", icon: <TextQuote size={14} /> },
};

export function isLocalPlaybackVideo(track: Track | null): boolean {
  return !!track && !isStreamTrack(track) && isVideoTrack(track.format);
}

export function playbackPanelItemsForTrack(track: Track | null) {
  return isLocalPlaybackVideo(track)
    ? { ...playbackPanelItems, information: { label: "视频信息", icon: <Video size={14} /> }, visualizer: { ...playbackPanelItems.visualizer, label: "视频", icon: <Video size={14} /> } }
    : playbackPanelItems;
}

export function canShowPlaybackVisual(track: Track | null, editingTrackId: number | null): boolean {
  if (isLocalPlaybackVideo(track)) return true;
  // A draft must have only one editor; the right-side studio owns it while explicitly open.
  return !!track && track.id !== editingTrackId && !isStreamTrack(track) && !isImageTrack(track.format);
}
