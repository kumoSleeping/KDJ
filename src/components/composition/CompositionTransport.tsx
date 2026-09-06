import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Pause, Play } from "lucide-react";
import { api } from "../../lib/api";
import { getCompositionClock, useCompositionClock } from "../../lib/compositionPlayback";
import { runtimePlayer } from "../../lib/unifiedPlayer";
import { PLAY_EVENT, playTrack } from "../../lib/playTrack";
import type { CompositionEntry, CompositionTask } from "../../types/composition";
import { Button, InlineNotice } from "../common";

// Rows share one main player, so their pending detail requests share one fence too.
let latestDetail: AbortController | null = null;

export interface CompositionTransportProps { task: CompositionTask }

export function CompositionTransport({ task }: CompositionTransportProps) {
  const request = useRef<AbortController | null>(null);
  const identity = `${task.id}:${task.video?.track_id ?? ""}:${task.audio?.track_id ?? ""}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState("");
  const clock = useCompositionClock();
  const active = clock.trackId !== null && (clock.trackId === task.video?.track_id || clock.trackId === task.audio?.track_id);
  // Replacement audio is the clock for the full-song preview. Overlay composition
  // follows the main video; the muted picture surfaces already share this clock.
  const previewEntry = task.audio && !task.audio.is_video ? task.audio : task.video;
  const previewPlaying = clock.ready && clock.trackId === previewEntry?.track_id && clock.playing;
  const [transportPending, setTransportPending] = useState(false);

  useEffect(() => {
    setPending(null); setError("");
    const cancel = () => {
      const controller = request.current;
      controller?.abort();
      if (latestDetail === controller) latestDetail = null;
      request.current = null;
      setPending(null);
    };
    window.addEventListener(PLAY_EVENT, cancel);
    return () => {
      window.removeEventListener(PLAY_EVENT, cancel);
      request.current?.abort();
      if (latestDetail === request.current) latestDetail = null;
      request.current = null;
    };
  }, [identity]);

  const audition = async (entry: CompositionEntry) => {
    latestDetail?.abort();
    const controller = new AbortController();
    request.current = controller; latestDetail = controller;
    setPending(entry.track_id); setError("");
    try {
      const track = await api.track(entry.track_id, { signal: controller.signal });
      if (controller.signal.aborted || latestDetail !== controller || currentIdentity.current !== identity) return;
      if (track.id !== entry.track_id || !track.path || track.id <= 0) throw new Error("无法加载本地曲目");
      // Clear before dispatch: our own PLAY_EVENT must not invalidate this accepted request.
      latestDetail = null; request.current = null;
      setPending(null);
      playTrack(track, true, "composition");
    } catch (cause) {
      if (!controller.signal.aborted && currentIdentity.current === identity) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (request.current === controller) { request.current = null; setPending(null); }
      if (latestDetail === controller) latestDetail = null;
    }
  };

  const togglePreview = async () => {
    if (!previewEntry || pending !== null || transportPending) return;
    setError("");
    const current = getCompositionClock();
    if (!current.ready || current.trackId !== previewEntry.track_id) {
      await audition(previewEntry);
      return;
    }
    setTransportPending(true);
    try {
      if (current.playing) await runtimePlayer().pause();
      else await runtimePlayer().play();
    } catch (cause) {
      if (currentIdentity.current === identity) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setTransportPending(false); }
  };

  return <div className="kd-composition-transport">
    <div className="kd-composition-preview-controls">
      {task.video && task.audio && <Button variant="primary" size="sm"
        aria-label={previewPlaying ? "暂停合成预览" : "播放合成预览"}
        aria-busy={pending !== null || transportPending} disabled={pending !== null || transportPending || task.offset_ms === null}
        onClick={() => void togglePreview()}>
        {pending !== null || transportPending ? <LoaderCircle size={13} /> : previewPlaying ? <Pause size={13} /> : <Play size={13} />}
        {previewPlaying ? "暂停预览" : "播放预览"}
      </Button>}
      {task.video && <Button variant="ghost" size="sm" aria-busy={pending === task.video.track_id}
        onClick={() => void audition(task.video!)}>主视频试听</Button>}
      {task.audio && <Button variant="ghost" size="sm" aria-busy={pending === task.audio.track_id}
        onClick={() => void audition(task.audio!)}>{task.audio.is_video ? "叠加视频试听" : "音频试听"}</Button>}
    </div>
    <InlineNotice text={error || (active ? clock.error : "")} onDismiss={error ? () => setError("") : undefined} block />
  </div>;
}
