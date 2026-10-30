import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";

/** What a library video's picture says when this WebView cannot decode it. */
export const PICTURE_FAILED = "无法显示这个视频的画面";
const NO_SOUND = "这个视频的声音无法播放";

/**
 * Whether a library video's sound plays (`/library/video-sound`): KDJ has no FFmpeg, and a track
 * symphonia cannot decode (Opus, AC-3, …) plays as silence so that the picture keeps its clock.
 * Null while unknown.
 */
export function useVideoSound(trackId: number | null): boolean | null {
  const [sound, setSound] = useState<{ id: number; plays: boolean } | null>(null);
  useEffect(() => {
    if (trackId === null) return;
    let alive = true;
    void api.videoSound(trackId)
      .then(answer => { if (alive) setSound({ id: trackId, plays: answer.sound }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [trackId]);
  return sound && sound.id === trackId ? sound.plays : null;
}

/** Opens the library file in the system's own program for it. */
async function openInSystemPlayer(trackId: number, path?: string): Promise<void> {
  const file = path ?? (await api.track(trackId)).path;
  await getBridge().openPath(file);
}

/**
 * What KDJ cannot do with a library video, said over its picture, with the key that hands the
 * file to the system's player: `picture` covers the picture it cannot show; `sound` is a line at
 * the picture's foot while the picture plays without sound.
 */
export function SystemPlayerNotice({ trackId, path, kind }: { trackId: number; path?: string; kind: "picture" | "sound" }) {
  const [error, setError] = useState("");
  return <div className="kd-video-fallback" data-kind={kind} role="status">
    <span>{error || (kind === "picture" ? PICTURE_FAILED : NO_SOUND)}</span>
    <button type="button" className="kd-video-fallback-key" onClick={event => {
      event.stopPropagation();
      setError("");
      void openInSystemPlayer(trackId, path).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    }}>
      <ExternalLink size={12} aria-hidden="true" />用系统播放器打开
    </button>
  </div>;
}
