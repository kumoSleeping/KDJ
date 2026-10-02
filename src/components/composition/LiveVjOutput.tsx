import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, visualizerApi } from "../../lib/api";
import { liveVjApi, liveVjAge, liveVjActive, liveVjPosition, type LiveVjMatch, type LiveVjView } from "../../lib/liveVj";
import type { LocalVideoClock } from "../../lib/mediaSync";
import { VideoPlaybackEngine, VIDEO_LIVE_RATE_ALIGNMENT_LIMIT_SEC } from "../../lib/videoPlaybackEngine";
import { observeVideoFrames } from "../../lib/videoFrames";
import { createVisualizerProject, hasStudioLyrics, loadVisualizerDraft, studioLyricText, syncVisualizerImages } from "../../lib/visualizerStudio";
import { drawStudioFrame, loadStudioImages, prepareStudio } from "../../lib/visualizerStudioRenderer";
import { FloatingVideoControls } from "../player/FloatingVideoControls";
import { LiveVjStandby } from "./LiveVjStandby";
import "./LiveVjPanel.css";

interface Slot { key: number; match: LiveVjMatch; alignment: boolean; standby?: boolean }
interface PreparedPicture { valid(): boolean; prepare(): void; metrics?(): ReturnType<VideoPlaybackEngine["liveMetrics"]> }
interface Output { slots: Slot[]; front: number | null; fading: number | null }
// Fade the prepared incoming picture over an opaque, still-moving outgoing
// picture: a short dissolve without the black dip of fading both layers out.
const FADE_MS = 160;

function Presentation({session, slot, match, visible, active, paused, ready, released, align, failed}: {
  session: string; slot: Slot; match: LiveVjMatch; visible: boolean; active: boolean; paused: boolean;
  ready(key: number, picture: PreparedPicture): void; released(key: number): void;
  align(key: number): void; failed(key: number, message: string): void;
}) {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const visibleRevision = useRef(-1);
  const feedback = useRef<PreparedPicture["metrics"]>(undefined);
  const latest = useRef({match, paused, active, visible, armed: !slot.standby, ready, released, align, failed});
  latest.current = {match, paused, active, visible, armed: !slot.standby, ready, released, align, failed};
  const engine = useMemo(() => new VideoPlaybackEngine(), []);
  useEffect(() => {
    const controller = new AbortController(); let alive = true, frame = 0;
    let preparation: AbortController | null = null;
    let retryDelay = 5000, preparingRate = 1, preparingPaused = false;
    let prepared = false, preparedRevision = -1, preparingRevision = -1, preparing = false, retryAt = 0, reportedAt = 0, frozen = liveVjPosition(latest.current.match);
    const media = video.current;
    const report = (state: "loading" | "ready" | "failed", error?: string) => {
      if (!alive) return;
      void liveVjApi.outputStatus(session, slot.match.entry.id, latest.current.match.lock_revision, state, error,
        media && state !== "loading" ? engine.liveMetrics(media, clock()) : undefined)
        .catch(e => { if (alive) latest.current.failed(slot.key, `记录输出状态失败：${String(e)}`); });
    };
    const failure = (error: unknown) => {
      if (!alive) return;
      const message = String(error); latest.current.failed(slot.key, message); report("failed", message);
    };
    const clock = (): LocalVideoClock => {
      const {match, paused} = latest.current;
      return {trackId: match.entry.track_id, sourceId: match.entry.track_id, discontinuityRevision: match.lock_revision,
        loopGeneration: 0, loopWrapCount: 0, position: liveVjPosition(match), rate: match.rate,
        playing: !paused, fresh: liveVjAge(match) < 1500};
    };
    feedback.current = media ? () => engine.liveMetrics(media, clock()) : undefined;
    const valid = () => {
      if (!alive || !prepared || !latest.current.armed || preparedRevision !== latest.current.match.lock_revision) return false;
      // Preparation already waited for a frame at the requested position.
      // Never expose a reused decoder solely because its cursor has moved.
      return !media || !media.seeking && media.readyState >= 2;
    };
    const prepare = () => {
      if (!alive || !media || media.readyState < 1 || preparing || !latest.current.armed || latest.current.visible || preparingRevision === latest.current.match.lock_revision && performance.now() < retryAt) return;
      preparing = true; prepared = false;
      const revision = latest.current.match.lock_revision;
      if (preparingRevision !== revision) retryDelay = 5000;
      preparingRevision = revision;
      preparingRate = latest.current.match.rate; preparingPaused = latest.current.paused;
      const attempt = new AbortController(); preparation = attempt;
      report("loading");
      void engine.prepareLiveClock(media, () => alive ? clock() : null, attempt.signal).then(ok => {
        if (!alive || attempt.signal.aborted || !latest.current.armed) return;
        prepared = ok && revision === latest.current.match.lock_revision;
        preparedRevision = revision;
        if (prepared) {
          if (latest.current.paused) media.pause();
          latest.current.ready(slot.key, {valid, prepare, metrics: () => engine.liveMetrics(media, clock())}); report("ready");
        } else if (revision === latest.current.match.lock_revision && clock().fresh !== false) failure("备用画面未就绪，保留当前输出");
      }).catch(error => { if (!attempt.signal.aborted) failure(error); }).finally(() => {
        preparing = false; preparation = null;
        retryAt = prepared || attempt.signal.aborted ? 0 : performance.now() + retryDelay;
        retryDelay = prepared || attempt.signal.aborted ? 5000 : Math.min(60_000, retryDelay * 2);
      });
    };
    const begin = async () => {
      if (latest.current.armed) report("loading");
      if (media) {
        // React sets only the muted property. Persist the silent-output policy
        // in the attribute too, before WebKit loads/reuses this decoder.
        media.defaultMuted = true; media.muted = true; media.volume = 0;
        media.addEventListener("loadedmetadata", prepare, {once: true});
        media.src = api.videoUrl(slot.match.entry.track_id); media.load();
        controller.signal.addEventListener("abort", () => media.removeEventListener("loadedmetadata", prepare), {once: true});
      } else {
        const track = await api.track(slot.match.entry.track_id);
        let draft = await loadVisualizerDraft(track.id);
        if (!alive) return;
        if (!draft) {
          const project = createVisualizerProject(track);
          const [cover, lyrics] = await Promise.all([visualizerApi.cover(track.id, controller.signal), api.libraryLyrics(track.id)]);
          if (!alive) return;
          project.lyrics.lrc = studioLyricText(lyrics.lrc || "", lyrics.word_lrc);
          project.lyrics.translation = lyrics.translated_lrc || "";
          project.lyrics.mode = hasStudioLyrics(project.lyrics.lrc) ? "scroll" : "off";
          draft = {project, images: cover ? [cover] : []};
        }
        if (!draft.images.length) draft.images = [new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#263446"/></svg>'], {type: "image/svg+xml"})];
        syncVisualizerImages(draft.project, draft.images.length);
        const [images, timeline] = await Promise.all([loadStudioImages(draft.images), visualizerApi.analyze(track.id, draft.project.scene.spectrum, controller.signal)]);
        if (!alive) return;
        const studio = prepareStudio(draft.project, images, timeline.timeline, 1280);
        const target = canvas.current!; target.width = studio.project.scene.canvas.width; target.height = studio.project.scene.canvas.height;
        const context = target.getContext("2d"); if (!context) throw new Error("无法创建可视化画布");
        const draw = () => {
          if (!alive) return;
          if (!latest.current.paused) frozen = liveVjPosition(latest.current.match);
          // A hidden standby needs a current first frame, not a second 60fps canvas loop.
          if (latest.current.visible || latest.current.armed && !prepared) drawStudioFrame(context, studio, frozen);
          frame = requestAnimationFrame(draw);
        };
        draw(); prepared = true; preparedRevision = latest.current.match.lock_revision;
        latest.current.ready(slot.key, {valid: () => {
          if (!alive) return false;
          drawStudioFrame(context, studio, liveVjPosition(latest.current.match));
          return prepared;
        }, prepare: () => undefined}); report("ready");
      }
    };
    const timer = window.setInterval(() => {
      if (!alive || !media) return;
      if (!latest.current.armed) {
        preparation?.abort(); prepared = false;
        engine.setBaseRate(media, latest.current.match.rate);
        if (!media.paused) media.pause();
        return;
      }
      // Cancellation must run before the in-flight guard: a later seek must not
      // wait for an obsolete preparation's frame timeout and retry interval.
      if (preparing && (preparingRevision !== latest.current.match.lock_revision
        || Math.abs(preparingRate - latest.current.match.rate) >= 0.003 || preparingPaused !== latest.current.paused)) {
        preparation?.abort(); engine.cancelSeek(media);
      }
      if (preparing) return;
      if (latest.current.paused) {
        engine.setBaseRate(media, latest.current.match.rate);
        if (!media.paused) media.pause();
        return;
      }
      if (latest.current.visible && !latest.current.active) {
        // Keep the outgoing picture moving through the dissolve, but retire
        // its correction task. The standby branch pauses it after the fade.
        engine.setBaseRate(media, latest.current.match.rate);
        return;
      }
      if (!prepared || !latest.current.visible && preparedRevision !== latest.current.match.lock_revision) { prepare(); return; }
      const current = clock();
      if (latest.current.active && performance.now() - reportedAt >= 1000) {
        reportedAt = performance.now();
        void liveVjApi.outputStatus(session, slot.match.entry.id, latest.current.match.lock_revision, visibleRevision.current === latest.current.match.lock_revision ? "visible" : "ready", undefined, engine.liveMetrics(media, current))
          .catch(e => { if (alive) latest.current.failed(slot.key, String(e)); });
      }
      if (current.position >= latest.current.match.entry.duration) {
        engine.setBaseRate(media, current.rate); media.pause(); return;
      }
      engine.followLiveClock(media, current, () => {
        if (latest.current.active) latest.current.align(slot.key);
        else prepare();
      });
      if (media.paused && media.readyState >= 2) void media.play().catch(failure);
    }, 100);
    void begin().catch(failure);
    return () => {
      alive = false; preparation?.abort(); controller.abort(); clearInterval(timer); cancelAnimationFrame(frame);
      engine.dispose(); latest.current.released(slot.key);
      if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
    };
  }, [session, slot.key, engine]);
  useEffect(() => {
    if (!active || slot.standby) { visibleRevision.current = -1; return; }
    const revision = slot.match.lock_revision;
    let stop = () => {}, raf = 0;
    const presented = () => {
      if (!latest.current.active || latest.current.match.lock_revision !== revision) { stop(); return true; }
      if (!layer.current || Number(getComputedStyle(layer.current).opacity) < 0.999 || liveVjAge(latest.current.match) >= 1500) return false;
      const metrics = feedback.current?.();
      if (video.current && (!metrics || metrics.error_ms === null || Math.abs(metrics.error_ms) >= VIDEO_LIVE_RATE_ALIGNMENT_LIMIT_SEC * 1000)) return false;
      visibleRevision.current = revision;
      stop();
      void liveVjApi.outputStatus(session, slot.match.entry.id, revision, "visible", undefined, metrics)
        .catch(e => latest.current.failed(slot.key, `画面状态上报失败：${String(e)}`));
      return true;
    };
    const media = video.current;
    if (media && typeof media.requestVideoFrameCallback === "function") {
      stop = observeVideoFrames(media, presented);
    } else {
      const frame = () => { if (!presented()) raf = requestAnimationFrame(frame); };
      stop = () => cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    }
    return () => stop();
  }, [active, slot.standby, slot.key, slot.match.lock_revision, slot.match.entry.id, session]);
  // Keep the spare decoder warm without relying on hidden compositor callbacks.
  // Only the incoming front animates. Reset a retired layer immediately so
  // rearming it above the front cannot expose a half-faded stale picture.
  const preroll = match.entry.video && !visible && !slot.standby;
  return <div ref={layer} className="kd-live-vj-picture" style={{opacity: visible ? 1 : preroll ? 0.001 : 0, zIndex: preroll ? 3 : active ? 2 : visible ? 1 : 0, transitionDuration: `${active ? FADE_MS : 0}ms`}}>{match.entry.video
    ? <video ref={video} muted playsInline preload="auto" onError={() => latest.current.failed(slot.key, "视频无法解码，保留当前输出")}/>
    : <canvas ref={canvas}/>}</div>;
}

export function LiveVjOutput() {
  const [view, setView] = useState<LiveVjView | null>(null);
  const [output, setOutput] = useState<Output>({slots: [], front: null, fading: null});
  const [error, setError] = useState(""), [paused, setPaused] = useState(false), [fullscreen, setFullscreen] = useState(false);
  const [standbyError, setStandbyError] = useState("");
  const running = liveVjActive(view);
  const latest = useRef(view); latest.current = view;
  const state = useRef(output); state.current = output;
  const stoppedSession = useRef<string | null>(null);
  const sequence = useRef(0), pictures = useRef(new Map<number, PreparedPicture>());
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastAlignment = useRef(-Infinity);
  const change = (next: Output) => { state.current = next; setOutput(next); };
  const resolve = (slot: Slot) => {
    const {matched, candidate} = latest.current ?? {};
    const same = (value: LiveVjMatch | null | undefined) => value?.entry.id === slot.match.entry.id
      && value.lock_revision === slot.match.lock_revision;
    return same(matched) ? matched! : same(candidate) ? candidate! : slot.match;
  };
  const prepare = (match: LiveVjMatch, alignment = false) => {
    const old = state.current;
    if (old.fading !== null) return;
    const pending = old.slots.find(s => s.key !== old.front && !s.standby && s.match.entry.id === match.entry.id);
    if (pending) {
      if (pending.match.lock_revision !== match.lock_revision)
        change({...old, slots: old.slots.map(s => s.key === pending.key ? {...s, match, alignment} : s)});
      return;
    }
    const front = old.slots.find(s => s.key === old.front);
    const spare = old.slots.find(s => s.standby && s.match.entry.id === match.entry.id);
    const next = {key: spare?.key ?? ++sequence.current, match, alignment};
    // Preserve DOM order as well as React identity when rearming a decoder.
    change({slots: spare ? old.slots.map(s => s.key === spare.key ? next : s) : [...(front ? [front] : []), next], front: old.front, fading: null});
  };
  const promote = (key: number) => {
    const old = state.current, slot = old.slots.find(s => s.key === key), picture = pictures.current.get(key);
    if (!liveVjActive(latest.current) || !slot || slot.standby || key === old.front || old.fading !== null || latest.current?.matched?.entry.id !== slot.match.entry.id
      || latest.current.matched.lock_revision !== slot.match.lock_revision || !picture) return;
    if (!picture.valid()) { picture.prepare(); return; }
    const session = latest.current.session, from = old.front;
    // Both decoded pictures remain mounted for the whole fade, including same-file seeks.
    const committed = old.slots.map(s => s.key === key ? {...s, match: latest.current!.matched!, alignment: true} : s);
    const slots = from === null && slot.match.entry.video
      ? [...committed, {key: ++sequence.current, match: latest.current.matched, alignment: true, standby: true}] : committed;
    change({...old, slots, front: key, fading: from}); setError("");
    void liveVjApi.outputStatus(session, slot.match.entry.id, latest.current.matched.lock_revision, "ready", undefined, picture.metrics?.()).catch(e => setError(String(e)));
    if (from !== null) {
      clearTimeout(fadeTimer.current);
      fadeTimer.current = setTimeout(() => {
        const current = state.current;
        if (current.front === key) {
          // Keep the outgoing decoder paused and reusable instead of cold-loading
          // another one for every correction. No background video playback.
          change({...current, slots: current.slots.filter(s => s.key !== from || s.match.entry.video).map(s => s.key === from ? {...s, standby: true} : s), fading: null});
        }
      }, FADE_MS + 40);
    }
  };
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>, unlisten: (() => void) | undefined;
    let unlistenResize: (() => void) | undefined;
    const apply = (next: LiveVjView) => {
      const old = latest.current;
      if (!alive || (old?.session === next.session && old.revision > next.revision)) return;
      if (next.session === stoppedSession.current && liveVjActive(next)) return;
      latest.current = next; setView(next);
    };
    const poll = async () => {
      try { apply(await liveVjApi.status()); } catch (e) { if (alive) setError(String(e)); }
      if (alive) timer = setTimeout(poll, liveVjActive(latest.current) ? 250 : 1000);
    };
    // Calibrate the monotonic clock before first exposure; events remain the immediate path.
    void poll();
    void getCurrentWindow().listen<LiveVjView>("live-vj-presentation", event => apply(event.payload))
      .then(stop => { if (!alive) stop(); else unlisten = stop; })
      .catch(e => { if (alive) setError(`即时通知失败，使用轮询：${String(e)}`); });
    const syncFullscreen = () => {
      void getCurrentWindow().isFullscreen().then(value => { if (alive) setFullscreen(value); }).catch(e => { if (alive) setError(String(e)); });
    };
    syncFullscreen();
    void getCurrentWindow().onResized(syncFullscreen).then(stop => { if (!alive) stop(); else unlistenResize = stop; })
      .catch(e => { if (alive) setError(String(e)); });
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") void getCurrentWindow().setFullscreen(false).then(() => setFullscreen(false)).catch(e => setError(String(e))); };
    window.addEventListener("keydown", key);
    return () => { alive = false; clearTimeout(timer); clearTimeout(fadeTimer.current); unlisten?.(); unlistenResize?.(); window.removeEventListener("keydown", key); };
  }, []);
  useEffect(() => {
    // The native window is reused. Stop must unmount both media slots, abort
    // pending seeks and cancel frame callbacks via Presentation's cleanup.
    clearTimeout(fadeTimer.current); pictures.current.clear(); lastAlignment.current = -Infinity;
    change({slots: [], front: null, fading: null});
    setPaused(false); setError("");
    if (running) void getCurrentWindow().isFullscreen().then(setFullscreen).catch(e => setError(String(e)));
  }, [view?.session, view?.presentation_epoch, running]);
  useEffect(() => {
    void liveVjApi.projectionError(error || standbyError).catch(() => undefined);
  }, [error, standbyError]);
  useEffect(() => {
    if (!liveVjActive(view)) return;
    const old = state.current, front = old.slots.find(s => s.key === old.front);
    const incoming = view?.matched, candidate = view?.candidate;
    const rescue = incoming && (incoming.entry.id !== front?.match.entry.id || incoming.lock_revision !== front.match.lock_revision);
    const candidateNeedsSeek = candidate && (!front || candidate.entry.id !== front.match.entry.id
      || Math.abs(liveVjPosition(candidate) - liveVjPosition(resolve(front))) >= VIDEO_LIVE_RATE_ALIGNMENT_LIMIT_SEC);
    const desired = rescue ? incoming : candidateNeedsSeek ? candidate : null;
    // A confirmed rescue is an explicit discontinuity, not micro-drift: do not
    // wait for a running rate-correction plan or its alignment cooldown.
    if (desired) prepare(desired, Boolean(rescue));
    else if (old.fading === null && old.slots.some(s => s.key !== old.front && !s.alignment && !s.standby))
      change({...old, slots: old.slots.map(s => s.key === old.front ? s : {...s, standby: true})});
    for (const slot of state.current.slots) if (slot.key !== state.current.front && !slot.standby) promote(slot.key);
  }, [view, output.front, output.fading]);
  const stopOutput = async () => {
    // Black out immediately; a slow worker join must not leave the last frame visible.
    stoppedSession.current = latest.current?.session ?? null;
    clearTimeout(fadeTimer.current);
    pictures.current.clear();
    change({slots: [], front: null, fading: null});
    if (latest.current) {
      const stopped = {...latest.current, phase: "stopped", matched: null, candidate: null, output: null};
      latest.current = stopped;
      setView(stopped);
    }
    try { await liveVjApi.closeProjection(); } catch (error) { setError(String(error)); }
  };
  const front = running ? output.slots.find(s => s.key === output.front) : null, selected = front ? resolve(front) : null;
  return <main className="kd-pip-float kd-live-vj-output-window" aria-label="实时 VJ 输出" data-fullscreen={fullscreen || undefined}>
    <LiveVjStandby asset={view?.standby ?? null} visible={!front} failure={setStandbyError}/>
    {running && output.slots.map(slot => <Presentation key={`${view?.session}:${slot.key}`} session={view?.session ?? ""} slot={slot} match={resolve(slot)}
      visible={slot.key === output.front || slot.key === output.fading} active={slot.key === output.front} paused={paused}
      ready={(key, picture) => { pictures.current.set(key, picture); promote(key); }}
      released={key => pictures.current.delete(key)}
      align={key => {
        const current = state.current, match = latest.current?.matched;
        if (key !== current.front || !match || performance.now() - lastAlignment.current < 2000 || current.slots.some(s => s.key !== current.front && !s.standby)) return;
        lastAlignment.current = performance.now(); prepare(match, true);
      }}
      failed={(key, message) => { if (state.current.slots.some(s => s.key === key && s.match.entry.id === latest.current?.matched?.entry.id)) setError(message); }}/>) }
    {!fullscreen && <FloatingVideoControls title={selected?.entry.title ?? "实时 VJ"} playing={!paused} position={selected ? liveVjPosition(selected) : 0}
      duration={selected?.entry.duration ?? 0} fullscreen={fullscreen} showTitle={fullscreen} showVolume={false} onToggle={() => setPaused(v => !v)}
      onFullscreen={() => void getCurrentWindow().setFullscreen(!fullscreen).then(() => setFullscreen(!fullscreen)).catch(e => setError(String(e)))}
      onTitlePointerDown={fullscreen ? undefined : e => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, select, a")) return;
        e.preventDefault();
        void getCurrentWindow().startDragging().catch(e => setError(String(e)));
      }}
      closeLabel="关闭实时 VJ"
      onClose={() => void stopOutput()}/> }
  </main>;
}
