import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { X, PictureInPicture2, Undo2, Redo2, ImagePlus, ListPlus, RotateCcw, Captions, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { createPortal } from "react-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isEditorWindow, usesKvjWindow } from "../../lib/windowRole";
import type { TrackSummary } from "../../types";
import { Select } from "../common/Select";
import type { VisualizerFeatureTimeline } from "../../types/audioVisualizer";
import { api, visualizerApi } from "../../lib/api";
import { createVisualizerProject, loadVisualizerDraft, saveVisualizerDraft, studioDuration, studioLyricText, hasStudioLyrics, syncVisualizerImages, validateVisualizerProject, STUDIO_IMAGE_LIMIT, clamp, type VisualizerDraft, type VisualizerProject } from "../../lib/visualizerStudio";
import { drawStudioFrame, loadStudioImages, prepareStudio, studioPictureSideAt } from "../../lib/visualizerStudioRenderer";
import { visualizerCropExtent } from "../../lib/audioVisualizerScene";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { FloatingVideoControls, FloatingVideoScrub } from "../player/FloatingVideoControls";
import { FloatingPreviewFrame } from "../player/FloatingPreviewFrame";
import { useToastStore } from "../../stores/toastStore";
import { getCompositionClock } from "../../lib/compositionPlayback";
import { prefersReducedSeekMotion, SEEK_TRANSITION_MS } from "../../lib/seekTransition";
import { getPlayerSession, requestPlayerCommand, subscribePlayerSession } from "../../lib/playerSession";
import { playTrack } from "../../lib/playTrack";
import { useLyricsStore } from "../../stores/lyricsStore";
import { LyricsSourcePicker } from "../player/LyricsSourcePicker";
import type { LyricsEngine } from "../../lib/lyricsPrefs";
import { useAppStore } from "../../stores/appStore";
import { useVideoPip } from "../../lib/videoPip";
import { usePreviewFullscreen } from "../../lib/usePreviewFullscreen";
import { ArcKnob } from "../player/ManagerMixerControls";
import { applyVisualizerPreferences, loadVisualizerPreferences, saveVisualizerPreferences, switchVisualizerContentLayout } from "../../lib/visualizerStudioPreferences";
import "./VisualizerStudioPanel.css";

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
function Range({ label, value, resetValue, min = 0, max = 1, step = .01, disabled = false, percentagePoints = false, onChange }: { label: string; value: number; resetValue: number; min?: number; max?: number; step?: number; disabled?: boolean; percentagePoints?: boolean; onChange: (value: number) => void }) {
  const unit = percentagePoints ? 1 : 100;
  const relative = (v: number) => 50 + (v - resetValue) * unit;
  const format = (v: number) => `${Number(v.toFixed(2))}%`;
  // Display a delta from the real default, not a remapping of the allowed range.
  // Retain the full parameter limits; neutral is always drawn at twelve o'clock.
  return <div className="kd-viz-dial"><span>{label}</span><ArcKnob label={label} value={relative(value)} min={relative(min)} max={relative(max)} step={step * unit} center={50} size="xs" disabled={disabled} snapToCenter={false} resetLabel="双击回到 50%（默认）" format={format} onChange={v => onChange(clamp(Number((resetValue + (v - 50) / unit).toFixed(6)), min, max))} onReset={() => onChange(resetValue)} /><output title={`实际值 ${Number(value.toFixed(3))}；默认值 ${Number(resetValue.toFixed(3))}`}>{format(relative(value))}</output></div>;
}
function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className="kd-djp-toggle kd-viz-toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="kd-djp-toggle-label">{label}</span>
    <span className="kd-djp-toggle-state" data-onoff={checked ? "on" : "off"} aria-hidden="true">{checked ? "开" : "关"}</span>
  </button>;
}
function Group({ title, children }: { title: string; children: ReactNode }) { return <section className="kd-viz-group" aria-label={title}><h3>{title}</h3><div className="kd-viz-fields">{children}</div></section>; }
function ImageChoice({ blob, label, disabled, onClick }: { blob?: Blob; label: string; disabled: boolean; onClick: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) { setUrl(""); return; }
    const next = URL.createObjectURL(blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return <button type="button" className="kd-viz-image-choice" disabled={disabled} onClick={onClick}>{url ? <img src={url} alt="" /> : <ImagePlus size={16} aria-hidden="true" />}<span>{label}</span></button>;
}

function StudioSettings({ target, inline, children }: { target: HTMLElement | null; inline: boolean; children: ReactNode }) {
  return target ? createPortal(children, target) : inline ? null : children;
}

/** Playback ticks update just the overlay, not every settings control in Studio. */
function StudioPosition({ position, scrub, refresh, children }: {
  position: RefObject<number>; scrub: RefObject<number | null>; refresh: RefObject<(() => void) | null>;
  children(position: number): ReactNode;
}) {
  const [cursor, setCursor] = useState(() => scrub.current ?? position.current);
  useEffect(() => {
    const update = () => setCursor(scrub.current ?? position.current);
    refresh.current = update; update();
    const timer = window.setInterval(update, 125);
    return () => { window.clearInterval(timer); refresh.current = null; };
  }, [position, scrub, refresh]);
  return children(cursor);
}

type ContentState = "loading" | "ready" | "empty";

export default function VisualizerStudioPanel({ onClose, inlineTrack, showDetails = true, onContentStateChange }: { onClose?: () => void; inlineTrack?: TrackSummary; showDetails?: boolean; onContentStateChange?: (state: ContentState) => void }) {
  const selectedTrack = useVisualizerStudioStore(s => s.track);
  const fromPlayback = useVisualizerStudioStore(s => s.fromPlayback);
  const track = inlineTrack ?? selectedTrack;
  return track ? <Studio key={track.id} track={track} fromPlayback={inlineTrack ? true : fromPlayback} inline={!!inlineTrack} showDetails={showDetails} onClose={onClose} onContentStateChange={onContentStateChange} /> : null;
}
function Studio({ track, fromPlayback, inline, showDetails, onClose, onContentStateChange }: { track: TrackSummary; fromPlayback: boolean; inline: boolean; showDetails: boolean; onClose?: () => void; onContentStateChange?: (state: ContentState) => void }) {
  const readOnlyPreview = inline && usesKvjWindow();
  const [savedRevision, setSavedRevision] = useState(0);
  const dirty = useRef(false);
  useEffect(() => {
    if (!readOnlyPreview) return;
    let active = true;
    const stop = getCurrentWebviewWindow().listen<number>("kdj:visualizer-saved", event => {
      if (active && event.payload === track.id) setSavedRevision(value => value + 1);
    });
    void stop.catch(error => useToastStore.getState().show(`无法同步可视化：${message(error)}`));
    return () => { active = false; void stop.then(unlisten => unlisten()).catch(() => undefined); };
  }, [readOnlyPreview, track.id]);
  const settingsOpen = useVisualizerStudioStore(state => inline && state.inlineSettings && state.track?.id === track.id);
  const settingsTarget = useVisualizerStudioStore(state => settingsOpen ? state.settingsTarget : null);
  const previewRequest = useVisualizerStudioStore(state => !inline && state.track?.id === track.id ? state.previewRequest : 0);
  const [draft, setDraft] = useState<VisualizerDraft | null>(null);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  const [coverAvailable, setCoverAvailable] = useState<boolean | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [analysis, setAnalysis] = useState<{ timeline: VisualizerFeatureTimeline; signature: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const analyzedSpectrum = useRef<string | null>(null);
  // Inline selection is not a request to decode another song while playback continues.
  const [loadAllowed, setLoadAllowed] = useState(() => !inline);
  const [previewVisible, setPreviewVisible] = useState(() => !inline);
  const [loadingLyrics, setLoadingLyrics] = useState(false);
  const lyricSource = useLyricsStore(s => s.byId[track.id]?.meta?.platform);
  const lyricMatching = useLyricsStore(s => !!s.byId[track.id]?.inflight);
  const [notice, setNotice] = useState("");
  const { fullscreen: expanded, applyFullscreen } = usePreviewFullscreen();
  const [floating, setFloating] = useState(() => previewRequest > 0);
  useEffect(() => { if (previewRequest > 0) setFloating(true); }, [previewRequest]);
  const panel = useRef<HTMLElement>(null);
  const closing = useRef(false);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const scrubTime = useRef<number | null>(null);
  const refreshCursor = useRef<(() => void) | null>(null);
  const cursorRef = useRef(0), drawPreview = useRef<(() => void) | null>(null);
  const [previewWidth, setPreviewWidth] = useState(640);
  const lastPrepared = useRef<ReturnType<typeof prepareStudio> | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const imageInput = useRef<HTMLInputElement>(null), lyricInput = useRef<HTMLInputElement>(null);
  const pictureDrag = useRef<{ side: "left" | "right"; x: number; y: number; fx: number; fy: number; scale: number; angle: number; kx: number; ky: number } | null>(null);
  const imageSlot = useRef(0);
  const history = useRef<{ past: VisualizerDraft[]; future: VisualizerDraft[]; last: number }>({ past: [], future: [], last: 0 });
  const saveChain = useRef(Promise.resolve());
  const p = draft?.project;
  const defaults = useMemo(() => createVisualizerProject(track), [track.id]);
  const leftContent = p?.leftContent ?? defaults.leftContent!;
  const downloadDirectory = useAppStore(state => state.settings?.download_dir || "");
  useEffect(() => {
    if (!p || (p.output.directoryMode === "download" && p.output.directory === downloadDirectory)) return;
    setDraft(current => current ? { ...current, project: { ...current.project, output: { ...current.project.output, directoryMode: "download", directory: downloadDirectory } } } : current);
  }, [downloadDirectory, p?.output.directoryMode, p?.output.directory]);
  const hasLyrics = useMemo(() => hasStudioLyrics(p?.lyrics.lrc || ""), [p?.lyrics.lrc]);
  const spectrumKey = p ? JSON.stringify([p.scene.spectrum.bands, p.scene.spectrum.sensitivity, p.scene.spectrum.smoothing]) : "";
  const duration = analysis ? studioDuration(analysis.timeline) : track.duration || 0;

  useEffect(() => {
    if (!inline) return;
    const target = panel.current;
    if (!target) return;
    if (typeof IntersectionObserver !== "function") { setPreviewVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      setPreviewVisible(entries[0]?.isIntersecting ?? false);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [inline]);
  const previewRequested = !inline || previewVisible || floating || expanded || settingsOpen;
  useEffect(() => {
    if (!inline || !previewRequested) return;
    // Hidden dock slots stay mounted to preserve editors, but are not requests to
    // decode a song. Once admitted, keep assets through same-song seek handoffs.
    const update = () => { if (getPlayerSession().trackId === track.id) setLoadAllowed(true); };
    update();
    return subscribePlayerSession(update);
  }, [inline, track.id, previewRequested]);

  useEffect(() => {
    // Following a switch must not reissue play while the new transport is loading.
    // Opening KVJ settings is not a DJ transport command; only explicit play/seek loads a source.
    if (!fromPlayback && !isEditorWindow) {
      const pip = useVideoPip.getState(); if (pip.active) pip.clear();
      if (getCompositionClock().trackId !== track.id) playTrack(track, false, "composition", 0);
    }
    const update = () => {
      const clock = getCompositionClock(), active = clock.trackId === track.id && clock.ready;
      playingRef.current = active && clock.playing;
      setPlaying(playingRef.current);
      if (active && clock.fresh !== false && scrubTime.current === null) {
        cursorRef.current = Math.max(0, clock.currentTime);
      }
      const session = getPlayerSession();
      if (session.trackId === track.id && session.error) setNotice(session.error);
      drawPreview.current?.();
    };
    const unlisten = subscribePlayerSession(update), timer = window.setInterval(update, 125);
    update(); return () => { unlisten(); window.clearInterval(timer); };
  }, [track.id, fromPlayback]);

  useEffect(() => {
    if (inline) return;
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [inline]);

  useEffect(() => {
    if (!loadAllowed) return;
    let active = true; const controller = new AbortController();
    void (async () => {
      let restored: VisualizerDraft | undefined;
      try {
        const current = latestDraft.current;
        restored = current && !readOnlyPreview ? { project: structuredClone(current.project), images: current.images } : await loadVisualizerDraft(track.id);
        if (restored?.images.length) validateVisualizerProject(restored.project);
      } catch { restored = undefined; }
      const install = (next: VisualizerDraft) => {
        if (!(readOnlyPreview && restored)) {
          const preferences = loadVisualizerPreferences(next.project);
          if (preferences) applyVisualizerPreferences(next.project, preferences);
          else rememberCommon(next.project);
        }
        next.project.output.directoryMode = "download";
        next.project.output.directory = useAppStore.getState().settings?.download_dir || "";
        setDraft(next);
      };
      if (!active) return;
      if (restored) {
        restored.project.track = createVisualizerProject(track).track;
        if (!hasStudioLyrics(restored.project.lyrics.lrc)) restored.project.lyrics.mode = "off";
        install(restored); return;
      }
      const project = createVisualizerProject(track);
      project.output.directory = useAppStore.getState().settings?.download_dir || "";
      const blobs: Blob[] = [];
      // Artwork is first paint. Optional metadata must not hold it behind a network lookup.
      const lyricsPromise = api.libraryLyrics(track.id).catch(() => null);
      const cover = await visualizerApi.cover(track.id, controller.signal).catch(() => null);
      if (!active) return;
      if (cover && cover.size <= STUDIO_IMAGE_LIMIT) blobs.push(cover);
      syncVisualizerImages(project, blobs.length); install({ project, images: blobs });
      const initialLyrics = JSON.stringify(project.lyrics);
      const lyrics = await lyricsPromise;
      if (!active || !lyrics) return;
      setDraft(current => {
        // A late response cannot overwrite lyrics the user has already edited.
        if (!current || JSON.stringify(current.project.lyrics) !== initialLyrics) return current;
        const next = structuredClone(current.project);
        next.lyrics.lrc = studioLyricText(lyrics.lrc || "", lyrics.word_lrc);
        next.lyrics.translation = lyrics.translated_lrc || "";
        next.lyrics.mode = hasStudioLyrics(next.lyrics.lrc) ? "scroll" : "off";
        return { ...current, project: next };
      });
    })().catch(e => { if (active) { setMediaFailed(true); setNotice(message(e)); } });
    return () => { active = false; controller.abort(); };
  }, [track.id, loadAllowed, savedRevision, readOnlyPreview]);

  useEffect(() => {
    if (!draft || readOnlyPreview || !dirty.current) return;
    const snapshot = draft;
    const timer = window.setTimeout(() => {
      saveChain.current = saveChain.current.catch(() => undefined).then(() => saveVisualizerDraft(snapshot));
      void saveChain.current.then(() => setNotice(current => current.startsWith("无法记住当前调整：") ? "" : current), e => { setNotice(`无法记住当前调整：${message(e)}`); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [draft, readOnlyPreview]);
  useEffect(() => {
    let active = true;
    setMediaFailed(false);
    if (draft?.images.length) void loadStudioImages(draft.images).then(v => { if (active) setImages(v); }, e => { if (active) { setMediaFailed(true); setNotice(message(e)); } });
    else setImages([]);
    return () => { active = false; };
  }, [draft?.images]);
  useEffect(() => {
    if (!p || !images.length || !loadAllowed || !previewRequested || analyzedSpectrum.current === spectrumKey) { setAnalyzing(false); return; }
    const controller = new AbortController(); setAnalyzing(true);
    const timer = window.setTimeout(() => {
      void visualizerApi.analyze(track.id, p.scene.spectrum, controller.signal).then(result => {
        if (!controller.signal.aborted) { analyzedSpectrum.current = spectrumKey; setAnalysis(result); }
      }).catch(e => { if (!controller.signal.aborted) { setNotice(message(e)); } }).finally(() => { if (!controller.signal.aborted) setAnalyzing(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [track.id, spectrumKey, loadAllowed, previewRequested, images.length]);

  // A tiny neutral timeline lets artwork render before global audio analysis. It does not
  // fabricate spectral activity or allocate one silent frame per second of a long track.
  const firstPaintTimeline = useMemo<VisualizerFeatureTimeline>(() => ({
    version: 1, sample_rate: 22050, sample_count: Math.max(1, Math.round((track.duration || 1) * 22050)),
    fps: 30, frames: [{ bands: Array(64).fill(0), bass: 0, rms: 0, onset: 0 }],
  }), [track.duration]);
  const prepared = useMemo(() => {
    if (!loadAllowed || !p || !images.length || images.length !== p.scene.images.length) return null;
    try { return prepareStudio(p, images, analysis?.timeline ?? firstPaintTimeline, previewWidth); } catch { return null; }
  }, [p, images, analysis, firstPaintTimeline, previewWidth, loadAllowed]);
  const emptyMedia = inline && !prepared && (draft ? draft.images.length === 0 : coverAvailable === false);
  const contentState: ContentState = prepared ? "ready" : emptyMedia || mediaFailed || (images.length > 0 && !!p && images.length === p.scene.images.length) ? "empty" : "loading";
  // Effects run after the canvas layout effect has painted the first complete frame.
  useEffect(() => { onContentStateChange?.(contentState); }, [contentState, onContentStateChange]);
  useEffect(() => {
    const target = canvas.current; if (!target || !p) return;
    let timer = 0;
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const width = target.getBoundingClientRect().width; if (!width) return;
        const pixels = Math.ceil(width * Math.min(window.devicePixelRatio || 1, inline && !expanded && !floating ? 1.25 : 2) / 64) * 64;
        setPreviewWidth(Math.min(p.scene.canvas.width, Math.max(320, Math.min(inline && !expanded && !floating ? 960 : 1440, pixels))));
      }, 120);
    };
    const observer = new ResizeObserver(resize); observer.observe(target); window.addEventListener("resize", resize); resize();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); window.clearTimeout(timer); };
  }, [!!prepared, p?.scene.canvas.width, p?.scene.canvas.height, floating, expanded]);
  useLayoutEffect(() => {
    if (!prepared || !canvas.current) return;
    const target = canvas.current;
    const c = target.getContext("2d", { alpha: false }); if (!c) return;
    // Capture before resizing: analysis/metadata arrivals keep the same canvas and fade from
    // its last complete picture. Never briefly unmount it or expose a cleared backing store.
    let previous: HTMLCanvasElement | null = null;
    if (lastPrepared.current && lastPrepared.current !== prepared) {
      previous = document.createElement("canvas"); previous.width = target.width; previous.height = target.height;
      previous.getContext("2d")?.drawImage(target, 0, 0);
    }
    lastPrepared.current = prepared;
    const { width, height } = prepared.project.scene.canvas;
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    let frame = 0, nextDraw = -Infinity, lastTime = NaN, visible = true;
    let transitionStart = performance.now();
    let lastDrawAt = transitionStart, lastRate = 0;
    let lastRevision: number | null = null;
    // A detached small window has the same frame budget as the inline preview.
    // Fullscreen retains 60 fps; export uses its own explicit output frame rate.
    const interval = 1000 / (expanded ? 60 : 30);
    const draw = (now: number, force = false) => {
      const clock = getCompositionClock();
      if (scrubTime.current === null && clock.ready && clock.fresh !== false && clock.trackId === track.id) cursorRef.current = clock.currentTime;
      const time = scrubTime.current ?? cursorRef.current;
      if (!force && !previous && time === lastTime) return;
      if (!force && now < nextDraw - 1) return;
      // Blend the last complete picture into the new timeline, never interpolate the audio clock.
      const owned = clock.ready && clock.fresh !== false && clock.trackId === track.id;
      const revision = owned ? clock.discontinuityRevision : null;
      const expected = lastTime + (now - lastDrawAt) / 1000 * lastRate;
      const jumped = Number.isFinite(lastTime) && (Math.abs(time - expected) > .25
        || (revision !== null && lastRevision !== null && revision !== lastRevision));
      if (jumped && scrubTime.current === null && !prefersReducedSeekMotion()) {
        previous = document.createElement("canvas"); previous.width = width; previous.height = height;
        previous.getContext("2d")?.drawImage(target, 0, 0);
        transitionStart = now;
      }
      if (prefersReducedSeekMotion()) previous = null;
      // Keep cadence across small rAF jitter, but never catch up a hidden/stalled window.
      nextDraw = force || now - nextDraw > interval ? now + interval : nextDraw + interval;
      lastDrawAt = now; lastRate = owned && clock.playing ? clock.rate : 0; lastRevision = revision;
      lastTime = time;
      drawStudioFrame(c, prepared, time);
      if (previous) {
        const amount = Math.min(1, (now - transitionStart) / SEEK_TRANSITION_MS);
        if (amount < 1) {
          c.save(); c.globalAlpha = 1 - amount; c.drawImage(previous, 0, 0, width, height); c.restore();
        } else previous = null;
      }
    };
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden || !visible) return;
      draw(now);
      if (playingRef.current || previous) frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame); frame = 0;
      if (!document.hidden && visible) { draw(performance.now(), true); if (playingRef.current || previous) frame = requestAnimationFrame(tick); }
    };
    drawPreview.current = () => {
      if (document.hidden || !visible) return;
      if (!playingRef.current || scrubTime.current !== null) draw(performance.now());
      if ((playingRef.current || previous) && !frame) frame = requestAnimationFrame(tick);
      else if (!playingRef.current && !previous && frame) { cancelAnimationFrame(frame); frame = 0; }
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true; resume();
    }) : null;
    observer?.observe(target);
    document.addEventListener("visibilitychange", resume); resume();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); drawPreview.current = null; document.removeEventListener("visibilitychange", resume); };
  }, [prepared, floating, expanded]);
  useEffect(() => {
    return () => {
      const snapshot = latestDraft.current;
      if (snapshot && !readOnlyPreview && dirty.current) void saveChain.current.catch(() => undefined).then(() => saveVisualizerDraft(snapshot))
        .catch(error => useToastStore.getState().show(`无法记住可视化调整：${message(error)}`));
    };
  }, []);
  useEffect(() => {
    if (inline && !settingsOpen) return;
    const handler = () => close();
    useVisualizerStudioStore.getState().setBeforeClose(handler);
    return () => { if (useVisualizerStudioStore.getState().beforeClose === handler) useVisualizerStudioStore.getState().setBeforeClose(null); };
  }, [draft, busy, inline, settingsOpen]);

  function checkpoint(current: VisualizerDraft, force = false) {
    dirty.current = true;
    const now = performance.now();
    if (force || now - history.current.last > 300) { history.current.past.push(current); if (history.current.past.length > 30) history.current.past.shift(); }
    history.current.future = []; history.current.last = now;
  }
  function rememberCommon(project: VisualizerProject) {
    if (readOnlyPreview) return;
    try { saveVisualizerPreferences(project); }
    catch (error) { setNotice(`无法记住通用设置：${message(error)}`); }
  }
  function edit(fn: (project: VisualizerProject) => void) {
    if (!draft || busy || readOnlyPreview) return;
    checkpoint(draft); const project = structuredClone(draft.project); fn(project);
    switchVisualizerContentLayout(project, draft.project); rememberCommon(project);
    setDraft({ ...draft, project });
  }
  function replaceDraft(next: VisualizerDraft) { if (draft) checkpoint(draft, true); setDraft(next); setNotice(""); }
  function refreshAutomaticConfiguration() {
    if (!draft || busy) return;
    const project = createVisualizerProject(track);
    project.output = { ...draft.project.output };
    project.lyrics = { ...draft.project.lyrics, size: project.lyrics.size };
    // Keep each chosen picture in its original role while resetting its layout.
    for (const role of ["left", "right", "disc"] as const) project.scene[role].image = draft.project.scene[role].image;
    syncVisualizerImages(project, draft.images.length);
    rememberCommon(project); replaceDraft({ project, images: draft.images });
  }
  function undo(redo = false) {
    if (!draft || busy || readOnlyPreview) return;
    dirty.current = true;
    const from = redo ? history.current.future : history.current.past, to = redo ? history.current.past : history.current.future;
    const next = from.pop(); if (next) { to.push(draft); rememberCommon(next.project); setDraft(next); history.current.last = 0; }
  }
  async function installImage(blob: Blob, slot: number) {
    if (!draft || busy) return;
    if (blob.size > STUDIO_IMAGE_LIMIT) throw new Error("每张图片最多 16 MiB");
    await loadStudioImages([blob]);
    const next: VisualizerDraft = { project: structuredClone(draft.project), images: [...draft.images] };
    next.images[Math.min(slot, next.images.length)] = blob;
    syncVisualizerImages(next.project, next.images.length);
    if (slot === 1) next.project.scene.right.image = 1;
    else { next.project.scene.left.image = 0; next.project.scene.disc.image = 0; }
    replaceDraft(next);
  }
  async function onImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
    try { if (!/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) throw new Error("请选择 PNG / JPEG / WebP / BMP 图片"); await installImage(file, imageSlot.current); } catch (error) { setNotice(message(error)); }
  }
  async function saveNow() { if (!draft || readOnlyPreview || !dirty.current) return; await saveChain.current.catch(() => undefined); await saveVisualizerDraft(draft); }
  function requestClose() { if (onClose) onClose(); else void close(); }
  async function close(): Promise<boolean> {
    if (closing.current) return false;
    closing.current = true;
    try {
      try { await saveNow(); } catch (e) { if (!window.confirm(`无法记住当前调整：${message(e)}。仍要关闭？`)) return false; }
      if ((!inline || settingsOpen) && useVisualizerStudioStore.getState().track?.id !== track.id) return false;
      if (!await applyFullscreen(false)) return false;
      if (inline) onClose?.();
      else useVisualizerStudioStore.getState().close();
      return true;
    } finally { closing.current = false; }
  }
  async function enqueueExport() {
    if (!draft || !prepared || busy || analyzing) return;
    setBusy(true); setNotice("");
    try {
      await useVisualizerExportStore.getState().enqueue(draft);
      useToastStore.getState().show("已加入可视化导出队列");
    } catch (error) { setNotice(`加入导出队列失败：${message(error)}`); }
    finally { setBusy(false); }
  }
  function seek(time: number) {
    if (!prepared || busy) return;
    const next = clamp(time, 0, duration);
    scrubTime.current = null;
    const clock = getCompositionClock();
    // Readiness can briefly drop while an earlier seek is landing. Keep issuing
    // seeks to the loaded track; playTrack would restart its entire load pipeline.
    if (clock.trackId === track.id || getPlayerSession().trackId === track.id) requestPlayerCommand({ type: "seek", position: next });
    else playTrack(track, false, "composition", next);
    cursorRef.current = next; refreshCursor.current?.(); drawPreview.current?.();
  }
  function scrub(event: PointerEvent<HTMLDivElement>, commit = false) {
    const rect = event.currentTarget.getBoundingClientRect(); if (!rect.width) return;
    const next = clamp((event.clientX - rect.left) / rect.width * duration, 0, duration);
    if (commit) seek(next);
    else { scrubTime.current = next; refreshCursor.current?.(); drawPreview.current?.(); }
  }
  function togglePlayback() {
    if (busy || !prepared) return;
    const clock = getCompositionClock();
    if (clock.trackId === track.id && clock.ready) requestPlayerCommand({ type: "toggle" });
    else playTrack(track, true, "composition", cursorRef.current);
  }
  async function loadSongLyrics(platform?: LyricsEngine) {
    if (!draft || loadingLyrics || busy) return;
    const before = draft.project.lyrics;
    setLoadingLyrics(true); setNotice("");
    try {
      const source = await api.track(track.id);
      await useLyricsStore.getState().ensure(source, { matchMissing: true, platform });
      const entry = useLyricsStore.getState().byId[track.id];
      if (entry?.error || entry?.status === "error") throw new Error(entry.error || "歌词匹配失败，请稍后重试。");
      const lrc = entry?.meta ? studioLyricText(entry.meta.lrc, entry.meta.word_lrc) : "";
      if (!hasStudioLyrics(lrc)) return;
      setDraft(current => {
        // Never replace text edited while a slower lyric lookup was pending.
        if (!current || current.project.lyrics.lrc !== before.lrc || current.project.lyrics.translation !== before.translation) return current;
        checkpoint(current, true);
        const project = { ...current.project, lyrics: { ...current.project.lyrics, mode: hasStudioLyrics(before.lrc) ? current.project.lyrics.mode : "scroll" as const, lrc, translation: entry?.meta?.translated_lrc || "" } };
        switchVisualizerContentLayout(project, current.project); rememberCommon(project);
        return { ...current, project };
      });
    } catch (error) { setNotice(message(error)); }
    finally { setLoadingLyrics(false); }
  }

  const lyricsVisible = hasLyrics && p?.lyrics.mode !== "off";
  const togglePreviewLyrics = () => {
    if (!hasLyrics) void loadSongLyrics();
    else edit(project => { project.lyrics.mode = project.lyrics.mode === "off" ? "scroll" : "off"; });
  };

  return <section ref={panel} tabIndex={-1} className="kd-viz-panel" data-inline={inline || undefined} data-floating={floating || undefined} aria-label="音频可视化编辑器" onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Escape" && (expanded || !inline)) { e.preventDefault(); if (expanded) void applyFullscreen(false); else requestClose(); return; }
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(e.shiftKey); }
      if (e.key === " " && !target.closest("button, summary, [role=slider]")) { e.preventDefault(); togglePlayback(); }
    }}>
    <div className="kd-viz-content kd-scroll">
    <div className="kd-viz-preview-column">
    <FloatingPreviewFrame floating={floating} fullscreen={expanded} editing={!floating && !expanded} compact={emptyMedia}
      ratio={inline ? 16 / 9 : p ? p.scene.canvas.width / p.scene.canvas.height : 16 / 9}
      onEscape={() => { if (expanded) void applyFullscreen(false); else if (floating) setFloating(false); else requestClose(); }}>
      {inline && !expanded && <button type="button" className="kd-viz-settings-entry"
        aria-label="打开可视化操作与设置" title="可视化操作与设置" aria-pressed={settingsOpen}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => useVisualizerStudioStore.getState().openInlineSettings(track)}><SlidersHorizontal size={15} /></button>}
      {inline && !expanded && !readOnlyPreview && <button type="button" className="kd-viz-settings-entry kd-viz-lyrics-entry"
        title={loadingLyrics ? "正在匹配歌词…" : lyricsVisible ? "关闭歌词" : "开启歌词"}
        aria-label={lyricsVisible ? "关闭可视化歌词" : "开启可视化歌词"} aria-pressed={lyricsVisible}
        aria-busy={loadingLyrics} disabled={!p || busy || loadingLyrics || lyricMatching}
        onPointerDown={event => event.stopPropagation()} onClick={togglePreviewLyrics}>
        {loadingLyrics ? <LoaderCircle size={15} className="kd-spin" /> : <Captions size={15} />}
      </button>}
      {prepared && p ? <canvas ref={canvas} aria-label={readOnlyPreview ? "音频可视化预览" : "音频可视化预览，可拖动左右图片调整位置"} onPointerDown={e => {
        if (readOnlyPreview || busy || floating || expanded || e.button !== 0 || !e.isPrimary || !draft) return;
        const rect = e.currentTarget.getBoundingClientRect(), scene = prepared.project.scene;
        const scale = Math.min(rect.width / scene.canvas.width, rect.height / scene.canvas.height);
        if (!scale) return;
        const x = (e.clientX - rect.left - (rect.width - scene.canvas.width * scale) / 2) / scale;
        const y = (e.clientY - rect.top - (rect.height - scene.canvas.height * scale) / 2) / scale;
        if (x < 0 || y < 0 || x > scene.canvas.width || y > scene.canvas.height) return;
        const side = studioPictureSideAt(prepared.project, x, y), transform = scene[side], image = images[transform.image];
        if (!image) return;
        const texture = prepared[side], fit = p.look[side === "left" ? "leftFit" : "rightFit"] || (side === "left" ? "cover" : "auto");
        const cover = fit === "cover" || (fit === "auto" && image.naturalWidth / image.naturalHeight >= .85);
        let kx = texture.width * .5, ky = texture.height * .5;
        if (cover) {
          const [cw, ch] = visualizerCropExtent(texture.width, texture.height, transform.rotation_deg);
          const sw = Math.max(1, Math.floor(Math.min(image.naturalWidth, image.naturalHeight * cw / ch) / transform.zoom));
          const sh = Math.max(1, Math.floor(sw * ch / cw));
          kx = (image.naturalWidth - sw) * cw / sw; ky = (image.naturalHeight - sh) * ch / sh;
        }
        const clock = getCompositionClock(), time = clock.trackId === track.id && clock.ready ? clock.currentTime : cursorRef.current;
        const spin = side === "left" ? time * Math.PI * 2 / 60 * (p.look.leftRotationRpm ?? .35) * p.look.motion : 0;
        const overscan = side === "right" ? 1.015 + p.look.motion * texture.height * .108 / Math.min(texture.width, texture.height) : 1;
        pictureDrag.current = { side, x: e.clientX, y: e.clientY, fx: transform.focus_x, fy: transform.focus_y, scale, angle: spin + (cover ? transform.rotation_deg * Math.PI / 180 : 0), kx: kx * overscan, ky: ky * overscan };
        checkpoint(draft, true); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        const start = pictureDrag.current; if (!start || busy) return;
        const dx = (e.clientX - start.x) / start.scale, dy = (e.clientY - start.y) / start.scale;
        const x = dx * Math.cos(start.angle) + dy * Math.sin(start.angle), y = -dx * Math.sin(start.angle) + dy * Math.cos(start.angle);
        setDraft(current => {
          if (!current) return current;
          const project = structuredClone(current.project), layer = project.scene[start.side];
          layer.focus_x = start.kx > .001 ? clamp(start.fx - x / start.kx) : start.fx;
          layer.focus_y = start.ky > .001 ? clamp(start.fy - y / start.ky) : start.fy;
          return { ...current, project };
        });
      }} onPointerUp={() => { pictureDrag.current = null; }} onPointerCancel={() => { pictureDrag.current = null; }} onLostPointerCapture={() => { pictureDrag.current = null; }} /> : <div className="kd-viz-empty">
        {!inline && <img src={api.coverUrl(track.id, track.modified_at)} alt="" aria-hidden="true"
          onLoad={() => setCoverAvailable(true)} onError={() => setCoverAvailable(false)} />}
        {loadAllowed && <div className="kd-viz-empty-action">
          {!draft || analyzing || draft.images.length ? <LoaderCircle className="kd-spin" size={20} role="status" aria-label={!draft ? "正在加载可视化" : "正在分析音频"} />
            : <button type="button" disabled={busy} aria-label="添加图片" title="添加图片" onClick={() => { if (readOnlyPreview) useVisualizerStudioStore.getState().open(track); else { imageSlot.current = 0; imageInput.current?.click(); } }}><ImagePlus size={20} /></button>}
        </div>}
      </div>}
      {inline && !settingsTarget && notice && <div className="kd-viz-notice kd-viz-inline-notice" role="alert">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}
      {prepared && <StudioPosition position={cursorRef} scrub={scrubTime} refresh={refreshCursor}>{cursor => <>
        <FloatingVideoControls title={track.title || track.filename} playing={playing} position={cursor} duration={duration} fullscreen={expanded} showTitle={floating && !expanded}
          onToggle={togglePlayback} onFullscreen={() => void applyFullscreen(!expanded)}
          onClose={floating ? () => { void applyFullscreen(false).then(ok => { if (ok) setFloating(false); }); } : undefined} closeLabel="收回预览小窗"
          extra={<>
            {!floating && <button type="button" aria-label="打开预览小窗" title="打开预览小窗" onClick={() => { void applyFullscreen(false).then(ok => { if (ok) setFloating(true); }); }}><PictureInPicture2 size={13} /></button>}
          </>} />
        <FloatingVideoScrub position={cursor} duration={duration} aria-label="预览时间" aria-disabled={busy}
          onPointerDown={e => { if (busy || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
          onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e); }}
          onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { scrub(e, true); e.currentTarget.releasePointerCapture(e.pointerId); } }}
          onPointerCancel={() => { scrubTime.current = null; drawPreview.current?.(); }} onLostPointerCapture={() => { scrubTime.current = null; drawPreview.current?.(); }}
          onKeyDown={e => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return; e.preventDefault(); seek(e.key === "Home" ? 0 : e.key === "End" ? duration : cursor + (e.key === "ArrowRight" ? 5 : -5)); }} />
      </>}</StudioPosition>}
    </FloatingPreviewFrame>
    <StudioSettings target={settingsTarget} inline={inline}>
    <div className="kd-viz-preview-actions">
    <div className="kd-viz-song"><strong title={track.title || track.filename}>{track.title || track.filename}</strong>{track.artist && <small title={track.artist}>{track.artist}</small>}</div>
    <div className="kd-viz-toolbar">
      <button type="button" disabled={!history.current.past.length || busy} onClick={() => undo()} title="撤销" aria-label="撤销"><Undo2 size={14} /></button>
      <button type="button" disabled={!history.current.future.length || busy} onClick={() => undo(true)} title="重做" aria-label="重做"><Redo2 size={14} /></button>
      <button type="button" disabled={!p || busy || loadingLyrics} title={hasLyrics && p?.lyrics.mode !== "off" ? "隐藏歌词" : "显示歌词"} aria-label={hasLyrics && p?.lyrics.mode !== "off" ? "隐藏歌词" : "显示歌词"} aria-pressed={hasLyrics ? p?.lyrics.mode !== "off" : undefined} onClick={() => {
        if (!hasLyrics) void loadSongLyrics();
        else edit(n => { n.lyrics.mode = n.lyrics.mode === "off" ? "scroll" : "off"; });
      }}><Captions size={13} /><span>{loadingLyrics ? "正在匹配歌词…" : hasLyrics && p?.lyrics.mode !== "off" ? "隐藏歌词" : "显示歌词"}</span></button>
      <span className="kd-viz-job" aria-live="polite">{analyzing ? "正在分析频谱…" : ""}</span>
      <button type="button" className="kd-viz-export" title="加入导出队列" aria-label="加入导出队列" disabled={!prepared || analyzing || busy} onClick={() => void enqueueExport()}><ListPlus size={14} /><span>{busy ? "加入中…" : "加入队列"}</span></button>
    </div>
    {notice && <div className="kd-viz-notice" role="alert">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}
    </div>
    </StudioSettings>
    </div>
    {(!inline || showDetails || settingsTarget) && <StudioSettings target={settingsTarget} inline={inline}><fieldset className="kd-viz-settings" disabled={busy}>{p && draft && <>
      <div className="kd-viz-settings-column">
      <Group title="基础">
        <button type="button" className="kd-viz-wide" onClick={refreshAutomaticConfiguration} title="恢复默认布局、字号、特效和歌曲信息；保留图片、歌词与输出设置，可撤销"><RotateCcw size={13} />刷新自动配置</button>
        {hasLyrics ? <Toggle label="显示歌词" checked={p.lyrics.mode !== "off"} onChange={v => edit(n => { n.lyrics.mode = v ? "scroll" : "off"; })} /> : <button type="button" disabled={loadingLyrics} aria-busy={loadingLyrics} onClick={() => void loadSongLyrics()}><Captions size={15} aria-hidden="true" />{loadingLyrics ? "正在匹配歌词…" : "尝试匹配歌词"}</button>}
        {hasLyrics && <Toggle label="显示翻译" checked={p.lyrics.showTranslation !== false} onChange={v => edit(n => { n.lyrics.showTranslation = v; })} />}
        <Range label="整体字号" value={p.text.scale} resetValue={defaults.text.scale} min={.5} max={1.5} onChange={v => edit(n => { n.text.scale = v; })} />
      </Group>
      <Group title="图片">
        <ImageChoice blob={draft.images[0]} label={draft.images.length ? "更换主图" : "添加主图"} disabled={busy} onClick={() => { imageSlot.current = 0; imageInput.current?.click(); }} />
        <ImageChoice blob={draft.images[1]} label={draft.images.length > 1 ? "更换背景图" : "添加背景图"} disabled={busy || !draft.images.length} onClick={() => { imageSlot.current = 1; imageInput.current?.click(); }} />
        {draft.images.length > 1 && <div className="kd-viz-wide kd-viz-buttons">
          <button type="button" onClick={() => { const project = structuredClone(p); syncVisualizerImages(project, 1); replaceDraft({ project, images: draft.images.slice(0, 1) }); }}>移除背景图</button>
        </div>}
        <div className="kd-viz-wide kd-viz-picture-positions">
          {(["left", "right"] as const).map(side => <div key={side} className="kd-viz-picture-position" role="group" aria-label={side === "left" ? "左侧图片调整" : "右侧图片调整"}>
            <h4>{side === "left" ? "左侧图片" : "右侧图片"}</h4>
            <Range label="水平位置" percentagePoints value={p.scene[side].focus_x * 100} resetValue={defaults.scene[side].focus_x * 100} max={100} step={1} onChange={v => edit(n => { n.scene[side].focus_x = v / 100; })} />
            <Range label="垂直位置" percentagePoints value={p.scene[side].focus_y * 100} resetValue={defaults.scene[side].focus_y * 100} max={100} step={1} onChange={v => edit(n => { n.scene[side].focus_y = v / 100; })} />
            <Range label="缩放" value={p.scene[side].zoom} resetValue={defaults.scene[side].zoom} min={1} max={4} onChange={v => edit(n => { n.scene[side].zoom = v; })} />
            {side === "left" && <Range label="背景加深（%）" percentagePoints value={p.look.leftVeil * 100} resetValue={defaults.look.leftVeil * 100} max={100} step={1} onChange={v => edit(n => { n.look.leftVeil = v / 100; })} />}
          </div>)}
        </div>
      </Group>
      <Group title="左侧整体">
        <div className="kd-viz-wide kd-viz-picture-position" role="group" aria-label="左侧整体布局" title="封面、文字、歌词及下方频谱一起移动，背景和分界圆弧不变">
          <Range label="左右移动（%）" percentagePoints value={leftContent.x * 100} resetValue={defaults.leftContent!.x * 100} min={-40} max={40} step={.5} onChange={v => edit(n => { n.leftContent = { ...(n.leftContent ?? defaults.leftContent!), x: v / 100 }; })} />
          <Range label="上下移动（%）" percentagePoints value={leftContent.y * 100} resetValue={defaults.leftContent!.y * 100} min={-40} max={40} step={.5} onChange={v => edit(n => { n.leftContent = { ...(n.leftContent ?? defaults.leftContent!), y: v / 100 }; })} />
          <Range label="整体缩放" value={leftContent.scale} resetValue={defaults.leftContent!.scale} min={.5} max={1.5} onChange={v => edit(n => { n.leftContent = { ...(n.leftContent ?? defaults.leftContent!), scale: v }; })} />
        </div>
      </Group>
      </div>
      <div className="kd-viz-settings-column">
      <Group title="内容">
        <Toggle label="显示专辑信息" checked={p.text.showAlbum === true} onChange={v => edit(n => { n.text.showAlbum = v; })} />
        {([["title", "歌曲标题"], ["artist", "艺人"], ["album", "专辑"]] as const).map(([key, label]) => <label key={key} className={key === "album" ? "kd-viz-wide" : undefined}>{label}<input value={p.text[key]} maxLength={500} onChange={e => edit(n => { n.text[key] = e.target.value; })} /></label>)}
        <div className="kd-viz-wide kd-viz-buttons">
          <LyricsSourcePicker platform={lyricSource} disabled={busy || !draft} matching={loadingLyrics || lyricMatching} onSelect={platform => void loadSongLyrics(platform)} />
          {hasLyrics && <button type="button" disabled={loadingLyrics || lyricMatching} aria-busy={loadingLyrics} onClick={() => void loadSongLyrics()}>{loadingLyrics ? "正在读取歌词…" : "重新读取歌词"}</button>}
          <button type="button" onClick={() => lyricInput.current?.click()}>导入歌词</button>
        </div>
      </Group>
      <Group title="画面">
        <Range label="左右画面比例" percentagePoints value={p.scene.arc.position * 100} resetValue={defaults.scene.arc.position * 100} min={25} max={75} step={.5} onChange={v => edit(n => { n.scene.arc.position = v / 100; })} />
        <Range label="背景动态" value={p.look.motion} resetValue={defaults.look.motion} onChange={v => edit(n => { n.look.motion = v; })} />
        <Range label="频谱强度" value={p.look.spectrumGain} resetValue={defaults.look.spectrumGain} min={.1} max={3} onChange={v => edit(n => { n.look.spectrumGain = v; })} />
        <Toggle label="显示唱片" checked={p.scene.disc.mode !== "hidden"} onChange={v => edit(n => { n.scene.disc.mode = v ? "cover" : "hidden"; })} />
        <Toggle label="显示频谱" checked={p.look.mainSpectrum || p.look.smallSpectrum !== "off"} onChange={v => edit(n => { n.look.mainSpectrum = v; n.look.smallSpectrum = v ? "mixed" : "off"; })} />
        <Toggle label="显示能量线" checked={p.look.energyLine} onChange={v => edit(n => { n.look.energyLine = v; })} />
        <Toggle label="显示水印" checked={p.output.watermark !== false} onChange={v => edit(n => { n.output.watermark = v; })} />
      </Group>
      <Group title="导出">
        <label>分辨率<Select value={`${p.scene.canvas.width}x${p.scene.canvas.height}`} onChange={e => { const [width, height] = e.target.value.split("x").map(Number); edit(n => { n.scene.canvas = { width, height, fps: 30 }; }); }}>
          <option value="1920x1080">1080p · 16:9</option><option value="1280x720">720p · 16:9</option><option value="1920x840">1920 × 840 · 超宽</option><option value="2560x1080">2560 × 1080 · 超宽</option>
        </Select></label>
        <label>帧率<Select value={p.output.fps} onChange={e => edit(n => { n.output.fps = Number(e.target.value) as 30 | 60; })}><option value={30}>30 fps</option><option value={60}>60 fps</option></Select></label>
        <label className="kd-viz-wide">文件名<input value={p.output.filename} onChange={e => edit(n => { n.output.filename = e.target.value; })} /></label>
      </Group>
      </div>
    </>}</fieldset></StudioSettings>}
    </div>
    <input hidden ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" onChange={e => void onImage(e)} />
    <input hidden ref={lyricInput} type="file" accept=".lrc,.txt" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; if (file.size > 250000) { setNotice("歌词文件过大"); return; } void file.text().then(text => edit(n => { n.lyrics.lrc = text; })).catch(error => setNotice(message(error))); }} />
  </section>;
}
