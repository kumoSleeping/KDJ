/**
 * A `.kdjv` project's picture drawn live with mpv (macOS; KdjvLivePicture is the WebView one).
 *
 * Each video clip on screen or about to be (kdjvLive.ts `preparedClips`) is one mpv player in
 * a native view under the page, the page leaving one hole over the canvas (videoHoles.ts). A
 * clip waits paused on its first frame before its cut and is simply let go at the cut, so it
 * comes in moving, with no seek. While shown it follows the project's clock mapped into its
 * source (`sourceTime`, `clipSpeed`); mpv catches small drift by its tempo and jumps by exact
 * seeks (mpv_player.rs `Follow`). Placement, crop and fades are the render's (`clipBox`,
 * `clipAlpha`): the view is the clip's visible rectangle, mpv crops the source to it, and the
 * view's opacity is the fade. The first track is on top.
 *
 * Still images stay HTML on the canvas, over the videos.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { MEDIA_SYNC_EVENT, type MediaSyncDetail } from "../../lib/mediaSync";
import { clipAlpha, clipBox, clipSpeed, preparedClips, sourceTime, type LiveClip } from "../../lib/kdjvLive";
import { MpvVideoController, trackNativeSlot, type MpvBounds, type MpvClock } from "../../lib/mpvPlayer";
import { createVideoHole } from "../../lib/videoHoles";
import { projectTime, type Heard, type LiveTransport } from "./KdjvLivePicture";
import type { KdjvLive } from "../../types";

interface ClipPlayer {
  n: number;
  controller: MpvVideoController;
  /** What was last sent, to send only changes. */
  placed: string;
}

/** `WxH+X+Y` of the clip's crop in source pixels, when it has one and the source size is known. */
function cropOf(project: KdjvLive, c: LiveClip): string | undefined {
  const [l, t, r, b] = c.crop ?? [0, 0, 0, 0];
  const s = project.sources[c.source];
  if (!(l || t || r || b) || !s?.width || !s?.height) return undefined;
  const width = Math.max(1, Math.round(s.width * (1 - l - r)));
  const height = Math.max(1, Math.round(s.height * (1 - t - b)));
  return `${width}x${height}+${Math.round(s.width * l)}+${Math.round(s.height * t)}`;
}

/** The clip's visible rectangle on screen: its box on the canvas, less its crop. */
function clipRect(project: KdjvLive, c: LiveClip, canvas: MpvBounds): MpvBounds {
  const at = clipBox(project, c);
  const [l, t, r, b] = c.crop ?? [0, 0, 0, 0];
  const left = at.left + l * at.width, top = at.top + t * at.height;
  const width = at.width * Math.max(0.01, 1 - l - r), height = at.height * Math.max(0.01, 1 - t - b);
  return {
    x: canvas.x + left / 100 * canvas.width,
    y: canvas.y + top / 100 * canvas.height,
    width: width / 100 * canvas.width,
    height: height / 100 * canvas.height,
  };
}

export function KdjvMpvPicture({ trackId, project, onTransport }: {
  trackId: number;
  project: KdjvLive;
  onTransport?: (transport: LiveTransport) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const transport = useRef(onTransport);
  transport.current = onTransport;
  // Kept across edits of the project: a clip still drawn keeps its player.
  const players = useRef(new Map<string, ClipPlayer>());
  const images = useRef(new Map<number, HTMLImageElement>());

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const fit = () => {
      const scale = Math.min(node.clientWidth / project.width, node.clientHeight / project.height);
      setSize({ width: project.width * scale, height: project.height * scale });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [project.width, project.height]);

  useEffect(() => {
    let heard: Heard | null = null;
    const known: { current: Heard | null } = { current: null };
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || detail.trackId !== trackId) return;
      const playing = detail.action === "play" ? true : detail.action === "pause" ? false : heard?.playing ?? false;
      heard = { position: detail.position ?? heard?.position ?? 0, at: performance.now(), playing, rate: detail.rate ?? 1 };
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    const hole = createVideoHole();
    const tracks = Math.max(0, ...project.clips.map(c => c.track)) + 1;
    // Where the canvas is and whether it may show, kept by the tracker (it measures on changes,
    // scrolls and a slow poll): measuring the page on every frame made scrolling stutter.
    const node = canvas.current;
    let placed: { bounds: MpvBounds; visible: boolean } = { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false };
    const stopTracking = node
      ? trackNativeSlot(node, (bounds, visible) => {
          placed = { bounds, visible };
          hole.set(visible ? bounds : null);
        })
      : () => undefined;
    let frame = 0, lastReport = -Infinity;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const t = projectTime(trackId, heard, known);
      const shown = placed.visible;

      const wanted = new Set<string>();
      for (const n of preparedClips(project, t.position, t.playing)) {
        const c = project.clips[n];
        const source = project.sources[c.source];
        if (source?.kind !== "video") continue;
        const crop = cropOf(project, c);
        const url = source.proxy ? api.kdjvProxyUrl(trackId, c.source) : api.kdjvSourceUrl(trackId, c.source);
        const id = `${n}|${url}|${source.file ?? ""}|${crop ?? ""}`;
        wanted.add(id);
        if (players.current.has(id)) continue;
        const local = t.position - c.at;
        const controller = new MpvVideoController({
          url,
          follow: true,
          bounds: clipRect(project, c, placed.bounds),
          volume: 0,
          start: sourceTime(c, Math.max(0, local)),
          paused: true,
          hole: false,
          opacity: 0,
          layer: (tracks - c.track) * 10_000 + n,
          crop,
          stretch: true,
          onStatus: () => undefined,
          onError: reason => console.warn(`工程素材 ${n} 无法播放：${reason.message}`),
        });
        players.current.set(id, { n, controller, placed: "" });
      }
      for (const [id, player] of players.current) {
        if (wanted.has(id)) continue;
        player.controller.dispose();
        players.current.delete(id);
      }

      for (const player of players.current.values()) {
        const c = project.clips[player.n];
        if (!c) continue;
        const local = t.position - c.at;
        const inside = local >= 0 && local < c.length;
        const alpha = Math.round(clipAlpha(c, local) * 100) / 100;
        const rect = clipRect(project, c, placed.bounds);
        const visible = shown && inside && alpha > 0;
        const layer = (tracks - c.track) * 10_000 + player.n;
        const key = `${rect.x.toFixed(1)},${rect.y.toFixed(1)},${rect.width.toFixed(1)},${rect.height.toFixed(1)},${visible},${alpha},${layer}`;
        if (key !== player.placed) {
          player.placed = key;
          void player.controller.setLook(alpha, layer).catch(() => undefined);
          void player.controller.setBounds(rect, visible).catch(() => undefined);
        }
        // Before its cut: still on its first frame. After its end: still on its last.
        const clock: MpvClock = local < 0
          ? { position: c.in, rate: 0, playing: false }
          : local >= c.length
            ? { position: sourceTime(c, c.length), rate: 0, playing: false }
            : { position: sourceTime(c, local), rate: t.rate * clipSpeed(c), playing: t.playing };
        player.controller.follow(clock);
      }

      for (const [n, image] of images.current) {
        const c = project.clips[n];
        image.style.opacity = c ? String(clipAlpha(c, t.position - c.at)) : "0";
      }
      if (now - lastReport >= 250) {
        lastReport = now;
        transport.current?.({ position: Math.min(project.duration, Math.max(0, t.position)), playing: t.playing });
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
      stopTracking();
      hole.dispose();
    };
  }, [trackId, project]);

  useEffect(() => () => {
    for (const player of players.current.values()) player.controller.dispose();
    players.current.clear();
  }, []);

  const tracks = Math.max(0, ...project.clips.map(c => c.track)) + 1;
  return (
    <div ref={box} className="kd-kdjv-live" data-native="true" aria-hidden="true">
      <div ref={canvas} className="kd-kdjv-live-canvas" style={{ width: size.width, height: size.height }}>
        {project.clips.map((c, n) => {
          const source = project.sources[c.source];
          if (source?.kind === "video") return null;
          const at = clipBox(project, c);
          return <img key={`${n}:${source?.file ?? ""}`} ref={node => {
            if (node) images.current.set(n, node);
            else images.current.delete(n);
          }} className="kd-kdjv-live-clip" alt="" draggable={false} src={api.kdjvSourceUrl(trackId, c.source)}
            style={{
              left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%`, clipPath: at.clip,
              zIndex: (tracks - c.track) * 10_000 + n, opacity: 0,
            }} />;
        })}
      </div>
    </div>
  );
}
