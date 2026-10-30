/**
 * A local video drawn with WebCodecs (KdjvCodecPicture) as a project of one clip: the whole file,
 * on the song's clock. The video's sound is the song the native player plays; this is only its
 * picture, decoded by the system decoder and drawn in the page.
 *
 * The file is looked at once (mediabunny reads its header by range): its picture size and length
 * make the one-clip project, and a file the WebView cannot decode (no video, a container or codec
 * it does not know) is refused, so the window keeps its `<video>` for it.
 */
import { useEffect, useState } from "react";
import { Input, MATROSKA, MP4, QTFF, UrlSource, WEBM } from "mediabunny";
import { api } from "./api";
import { tracePlayback } from "./playbackTrace";
import type { KdjvLive } from "../types";

/** The WebView decodes video itself (WebKit with Safari 16.4's WebCodecs, WebView2, Android's WebView). */
export function codecDecodeAvailable(): boolean {
  return typeof VideoDecoder !== "undefined";
}

interface Probe {
  width: number;
  height: number;
  duration: number;
}

const probes = new Map<number, Promise<Probe | null>>();
const refused = new Set<number>();

/** Whether this track's file was found not to decode here: it plays in a `<video>`. */
export function codecVideoRefused(trackId: number): boolean {
  return refused.has(trackId);
}

function probe(trackId: number): Promise<Probe | null> {
  let found = probes.get(trackId);
  if (found) return found;
  found = (async () => {
    const started = performance.now();
    const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new UrlSource(api.videoUrl(trackId)) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("没有视频");
      if (!(await track.canDecode())) throw new Error(`系统解码器不支持 ${track.codec ?? "这种编码"}`);
      const duration = await track.computeDuration();
      tracePlayback("codec-video", { track: trackId, codec: track.codec ?? null, ms: Math.round(performance.now() - started) });
      return { width: track.displayWidth, height: track.displayHeight, duration };
    } catch (reason) {
      refused.add(trackId);
      tracePlayback("codec-video-refused", { track: trackId, error: reason instanceof Error ? reason.message : String(reason) });
      return null;
    } finally {
      input.dispose();
    }
  })();
  probes.set(trackId, found);
  return found;
}

/** The one-clip project of a local video. */
export function videoProject(probe: Probe): KdjvLive {
  const { width, height, duration } = probe;
  return {
    duration, width, height,
    sources: [{ kind: "video", width, height, fps: 0 }],
    clips: [{
      source: 0, track: 0, at: 0, in: 0, out: duration, length: duration,
      x: 0.5, y: 0.5, scale: 1, opacity: 1, fill: false, fade_in: 0, fade_out: 0,
    }],
  };
}

/**
 * The one-clip project for `trackId` once its file has been looked at; `refused` when it does not
 * decode here. Null asks for nothing.
 */
export function useVideoProject(trackId: number | null): { project: KdjvLive | null; refused: boolean; pending: boolean } {
  // The project is made once per file: the picture starts again whenever it is a new object.
  const [state, setState] = useState<{ id: number | null; project: KdjvLive | null; done: boolean }>({ id: null, project: null, done: false });
  useEffect(() => {
    if (trackId === null) return;
    let alive = true;
    void probe(trackId).then(found => {
      if (alive) setState({ id: trackId, project: found ? videoProject(found) : null, done: true });
    });
    return () => { alive = false; };
  }, [trackId]);
  if (trackId === null) return { project: null, refused: false, pending: false };
  const mine = state.id === trackId && state.done;
  return {
    project: mine ? state.project : null,
    refused: mine ? !state.project : refused.has(trackId),
    pending: !mine && !refused.has(trackId),
  };
}
