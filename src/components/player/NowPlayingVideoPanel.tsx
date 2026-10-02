import type { Track } from "../../types";
import { useVideoPip } from "../../lib/videoPip";
import { Panel } from "../common";
import { LocalVideoPlayer } from "../library/LocalVideoPlayer";

/** The same local video scheduler/decoder used by previews; never mount a second floating copy. */
export function NowPlayingVideoPanel({ track }: { track: Track }) {
  const floating = useVideoPip(state => state.active && state.mode === "float"
    && state.session?.source === "local" && state.session.trackId === track.id);
  return <Panel heading="视频" className="kd-playing-video-panel" padded={false} dense>
    {!floating && <LocalVideoPlayer track={track} />}
  </Panel>;
}
