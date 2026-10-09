import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { X, PictureInPicture2, Undo2, Redo2, ImagePlus, ListPlus, RotateCcw, Captions, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { createPortal } from "react-dom";
import type { TrackSummary } from "../../types";
import { Select } from "../common/Select";
import { Slider } from "../common/Slider";
import { Segmented } from "../common/Segmented";
import type { VisualizerFeatureTimeline } from "../../types/audioVisualizer";
import { api, visualizerApi } from "../../lib/api";
import { createVisualizerProject, loadVisualizerDraft, saveVisualizerDraft, studioDuration, studioLyricText, hasStudioLyrics, syncVisualizerImages, validateVisualizerProject, STUDIO_IMAGE_LIMIT, clamp, type VisualizerDraft, type VisualizerProject } from "../../lib/visualizerStudio";
import { drawStudioFrame, loadStudioImages, prepareStudio, studioPictureSideAt } from "../../lib/visualizerStudioRenderer";
import { studioExportBytes } from "../../lib/visualizerStudioFrames";
import { formatBytes } from "../../lib/format";
import { visualizerCropExtent } from "../../lib/audioVisualizerScene";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { FloatingVideoControls, FloatingVideoScrub } from "../player/FloatingVideoControls";
import { FloatingPreviewFrame } from "../player/FloatingPreviewFrame";
import { useToastStore } from "../../stores/toastStore";
import { noteVisualizerExportSong } from "../tasks/taskCovers";
import { getCompositionClock } from "../../lib/compositionPlayback";
import { prefersReducedSeekMotion, SEEK_TRANSITION_MS } from "../../lib/seekTransition";
import { useVisualizerPopup } from "../../lib/visualizerPopup";
import { getPlayerSession, requestPlayerCommand, subscribePlayerSession } from "../../lib/playerSession";
import { playTrack } from "../../lib/playTrack";
import { useLyricsStore } from "../../stores/lyricsStore";
import { LyricsSourcePicker } from "../player/LyricsSourcePicker";
import type { LyricsEngine } from "../../lib/lyricsPrefs";
import { useAppStore } from "../../stores/appStore";
import { usePreviewFullscreen } from "../../lib/usePreviewFullscreen";
import { applyVisualizerPreferences, loadVisualizerPreferences, saveVisualizerPreferences, switchVisualizerContentLayout } from "../../lib/visualizerStudioPreferences";
import { EditorSeparator, EditorTabs } from "../workspace/EditorChrome";
import { SlidePages } from "../drawer/SlidePages";
import { useDrawer } from "../drawer/Drawer";
import { studioTabs, useStudioTab, type StudioTab } from "../../lib/visualizerStudioTabs";
import "./VisualizerStudioPanel.css";

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const percent = (v: number) => `${Number(v.toFixed(1))}%`;
const ratio = (v: number) => `${Math.round(v * 100)}%`;
const signedPercent = (v: number) => `${v > 0 ? "+" : ""}${Number(v.toFixed(1))}%`;
const times = (v: number) => `×${v.toFixed(2)}`;
const resolutions = [["1920x1080", "1080p · 16:9"], ["1280x720", "720p · 16:9"], ["1920x840", "1920 × 840 · 超宽"], ["2560x1080", "2560 × 1080 · 超宽"]] as const;
const studioTabIds = studioTabs.map(tab => tab.id);
const frameRates = [{ value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }] as const;
function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className="kd-djp-toggle kd-viz-toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="kd-djp-toggle-label">{label}</span>
    <span className="kd-djp-toggle-state" data-onoff={checked ? "on" : "off"} aria-hidden="true">{checked ? "开" : "关"}</span>
  </button>;
}
function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) { return <section className="kd-viz-group" aria-label={title}><h3 title={hint}>{title}</h3><div className="kd-viz-fields">{children}</div></section>; }
/** A named control on the parameter grid: the name in the label column, the control beside it. */
function Row({ label, children }: { label: string; children: ReactNode }) { return <label className="kd-viz-row"><span>{label}</span>{children}</label>; }
function ImageChoice({ blob, label, action, disabled, onPick, onRemove }: { blob?: Blob; label: string; action: string; disabled: boolean; onPick: () => void; onRemove?: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) { setUrl(""); return; }
    const next = URL.createObjectURL(blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return <div className="kd-viz-image">
    <button type="button" className="kd-viz-image-choice" disabled={disabled} aria-label={action} title={action} onClick={onPick}>
      <span className="kd-viz-image-thumb">{url ? <img src={url} alt="" /> : <ImagePlus size={16} aria-hidden="true" />}</span><span>{label}</span>
    </button>
    {onRemove && <button type="button" className="kd-viz-image-remove" disabled={disabled} aria-label={`移除${label}`} title={`移除${label}`} onClick={onRemove}><X size={13} /></button>}
  </div>;
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

/**
 * `inlineTrack`: the playing song's picture, hosted by another surface. `popup`: that picture
 * exists only as the floating window; closing that window closes the popup.
 * `track`: the configuration of exactly this song (the right column's app); without either,
 * the song the store has open.
 */
export default function VisualizerStudioPanel({ onClose, inlineTrack, track: pinnedTrack, showDetails = true, popup = false, onContentStateChange }: { onClose?: () => void; inlineTrack?: TrackSummary; track?: TrackSummary; showDetails?: boolean; popup?: boolean; onContentStateChange?: (state: ContentState) => void }) {
  const selectedTrack = useVisualizerStudioStore(s => s.track);
  const track = inlineTrack ?? pinnedTrack ?? selectedTrack;
  return track ? <Studio key={track.id} track={track} inline={!!inlineTrack} showDetails={showDetails} popup={popup} onClose={onClose} onContentStateChange={onContentStateChange} /> : null;
}
function Studio({ track, inline, showDetails, popup, onClose, onContentStateChange }: { track: TrackSummary; inline: boolean; showDetails: boolean; popup: boolean; onClose?: () => void; onContentStateChange?: (state: ContentState) => void }) {
  const dirty = useRef(false);
  const settingsOpen = useVisualizerStudioStore(state => inline && state.inlineSettings && state.track?.id === track.id);
  const settingsTarget = useVisualizerStudioStore(state => settingsOpen ? state.settingsTarget : null);
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
  const [detached, setDetached] = useState(false);
  const floating = popup || detached;
  const setFloating = (value: boolean) => {
    if (popup && !value) useVisualizerPopup.getState().setOpen(false);
    else setDetached(value);
  };
  const panel = useRef<HTMLElement>(null);
  const closing = useRef(false);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const scrubTime = useRef<number | null>(null);
  const refreshCursor = useRef<(() => void) | null>(null);
  const cursorRef = useRef(0), drawPreview = useRef<(() => void) | null>(null);
  const [previewWidth, setPreviewWidth] = useState(640);
  const lastPrepared = useRef<ReturnType<typeof prepareStudio> | null>(null);
  const lastProject = useRef<VisualizerProject | null>(null);
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
    // Opening the configuration is not a transport command: what is playing keeps playing.
    // Only this picture's own play and seek load its song.
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
  }, [track.id]);

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
        restored = current ? { project: structuredClone(current.project), images: current.images } : await loadVisualizerDraft(track.id);
        if (restored?.images.length) validateVisualizerProject(restored.project);
      } catch { restored = undefined; }
      const install = (next: VisualizerDraft) => {
        const preferences = loadVisualizerPreferences(next.project);
        if (preferences) applyVisualizerPreferences(next.project, preferences);
        else rememberCommon(next.project);
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
  }, [track.id, loadAllowed]);

  useEffect(() => {
    if (!draft || !dirty.current) return;
    const snapshot = draft;
    const timer = window.setTimeout(() => {
      saveChain.current = saveChain.current.catch(() => undefined).then(() => saveVisualizerDraft(snapshot));
      void saveChain.current.then(() => setNotice(current => current.startsWith("无法记住当前调整：") ? "" : current), e => { setNotice(`无法记住当前调整：${message(e)}`); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [draft]);
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
    // Capture before resizing: analysis/metadata arrivals during playback keep the same canvas
    // and fade from its last complete picture. An edit is applied on the very next frame: a
    // dragged picture or slider must track the pointer, not dissolve towards it. Never briefly
    // unmount the canvas or expose a cleared backing store.
    let previous: HTMLCanvasElement | null = null;
    const edited = lastProject.current !== p;
    if (lastPrepared.current && lastPrepared.current !== prepared && !edited && playingRef.current) {
      previous = document.createElement("canvas"); previous.width = target.width; previous.height = target.height;
      previous.getContext("2d")?.drawImage(target, 0, 0);
    }
    lastPrepared.current = prepared; lastProject.current = p ?? null;
    const { width, height } = prepared.project.scene.canvas;
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    let frame = 0, nextDraw = -Infinity, lastTime = NaN, visible = true;
    // Under an ancestor marked `data-covered` the picture is hidden behind something else: paint
    // nothing meanwhile, and catch up once when the picture is uncovered.
    let owed = false;
    const covered = () => { const yes = target.closest("[data-covered]") !== null; if (yes) owed = true; return yes; };
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
      // Only a playing picture dissolves across a jump; a paused one lands on its frame.
      if (jumped && playingRef.current && scrubTime.current === null && !prefersReducedSeekMotion()) {
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
      if (document.hidden || !visible || covered()) return;
      draw(now);
      if (playingRef.current || previous) frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame); frame = 0;
      if (!document.hidden && visible && !covered()) { draw(performance.now(), true); if (playingRef.current || previous) frame = requestAnimationFrame(tick); }
    };
    drawPreview.current = () => {
      if (document.hidden || !visible || covered()) return;
      if (owed) { owed = false; draw(performance.now(), true); }
      else if (!playingRef.current || scrubTime.current !== null) draw(performance.now());
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
      if (snapshot && dirty.current) void saveChain.current.catch(() => undefined).then(() => saveVisualizerDraft(snapshot))
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
    try { saveVisualizerPreferences(project); }
    catch (error) { setNotice(`无法记住通用设置：${message(error)}`); }
  }
  function edit(fn: (project: VisualizerProject) => void) {
    if (!draft || busy) return;
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
    if (!draft || busy) return;
    dirty.current = true;
    const from = redo ? history.current.future : history.current.past, to = redo ? history.current.past : history.current.future;
    const next = from.pop(); if (next) { to.push(draft); rememberCommon(next.project); setDraft(next); history.current.last = 0; }
  }
  async function installImage(blob: Blob, slot: number) {
    if (!draft || busy) return;
    if (blob.size > STUDIO_IMAGE_LIMIT) throw new Error("每张图片最多 16 MiB");
    await loadStudioImages([blob]);
    // Decoding can take a while; build on the draft as it is now, not as it was at the click.
    const current = latestDraft.current ?? draft;
    const next: VisualizerDraft = { project: structuredClone(current.project), images: [...current.images] };
    next.images[Math.min(slot, next.images.length)] = blob;
    syncVisualizerImages(next.project, next.images.length);
    if (slot === 1) next.project.scene.right.image = 1;
    else { next.project.scene.left.image = 0; next.project.scene.disc.image = 0; }
    checkpoint(current, true); setDraft(next); setNotice("");
  }
  async function onImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
    try { if (!/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) throw new Error("请选择 PNG / JPEG / WebP / BMP 图片"); await installImage(file, imageSlot.current); } catch (error) { setNotice(message(error)); }
  }
  async function saveNow() { if (!draft || !dirty.current) return; await saveChain.current.catch(() => undefined); await saveVisualizerDraft(draft); }
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
      // The export's task bubble is drawn from the queue itself; it only needs to know the song.
      noteVisualizerExportSong(draft.project.track.id);
      await useVisualizerExportStore.getState().enqueue(draft);
    } catch (error) { noteVisualizerExportSong(0); setNotice(`加入导出队列失败：${message(error)}`); }
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

  const tab = useStudioTab(state => state.tab);
  const selectTab = useStudioTab(state => state.setTab);
  const tabPanelId = useId();
  // In a drawer the sections are the drawer's title; elsewhere the inspector carries its own tabs.
  const inDrawer = useDrawer() !== null || !!settingsTarget?.closest(".kd-drawer");
  const lyricsVisible = hasLyrics && p?.lyrics.mode !== "off";
  const togglePreviewLyrics = () => {
    if (!hasLyrics) void loadSongLyrics();
    else edit(project => { project.lyrics.mode = project.lyrics.mode === "off" ? "scroll" : "off"; });
  };

  // Standalone: in place. Inline: only when a settings host exists (the picture stays in its panel).
  const settings = (node: ReactNode) => !inline ? node : settingsTarget ? createPortal(node, settingsTarget) : null;
  const settingsVisible = !inline || showDetails || !!settingsTarget;
  const toolbar = <div className="kd-viz-bar kd-editor-bar" role="toolbar" aria-label="可视化操作">
    <button type="button" disabled={!history.current.past.length || busy} onClick={() => undo()} title="撤销 · ⌘/Ctrl Z" aria-label="撤销"><Undo2 size={14} /></button>
    <button type="button" disabled={!history.current.future.length || busy} onClick={() => undo(true)} title="重做 · ⌘/Ctrl Shift Z" aria-label="重做"><Redo2 size={14} /></button>
    <EditorSeparator />
    <button type="button" disabled={!p || busy || loadingLyrics} aria-busy={loadingLyrics} title={loadingLyrics ? "正在匹配歌词…" : lyricsVisible ? "隐藏歌词" : "显示歌词"}
      aria-label={lyricsVisible ? "隐藏歌词" : "显示歌词"} aria-pressed={hasLyrics ? lyricsVisible : undefined} onClick={togglePreviewLyrics}>
      {loadingLyrics ? <LoaderCircle size={14} className="kd-spin" /> : <Captions size={14} />}</button>
    <button type="button" disabled={!p || busy} onClick={refreshAutomaticConfiguration} aria-label="刷新自动配置"
      title="恢复默认布局、字号、特效和歌曲信息；保留图片、歌词与输出设置，可撤销"><RotateCcw size={14} /></button>
    <span className="kd-editor-spacer" />
    <span className="kd-editor-status" aria-live="polite">{analyzing ? "正在分析频谱…" : ""}</span>
    <button type="button" className="kd-viz-export" title="加入导出队列" aria-label="加入导出队列" disabled={!prepared || analyzing || busy} onClick={() => void enqueueExport()}><ListPlus size={14} /><span>{busy ? "加入中…" : "加入队列"}</span></button>
  </div>;
  const noticeRow = notice && <div className="kd-viz-notice" role="alert">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>;
  const pickImage = (slot: number) => { imageSlot.current = slot; imageInput.current?.click(); };
  // Where the picture sits in its frame: also set by dragging it in the preview.
  const pictureSide = (side: "left" | "right") => p && <Group title={side === "left" ? "左侧图片" : "右侧图片"}>
    <Slider label="水平" value={p.scene[side].focus_x * 100} defaultValue={defaults.scene[side].focus_x * 100} min={0} max={100} origin={50} format={percent} onChange={v => edit(n => { n.scene[side].focus_x = v / 100; })} />
    <Slider label="垂直" value={p.scene[side].focus_y * 100} defaultValue={defaults.scene[side].focus_y * 100} min={0} max={100} origin={50} format={percent} onChange={v => edit(n => { n.scene[side].focus_y = v / 100; })} />
    <Slider label="缩放" value={p.scene[side].zoom} defaultValue={defaults.scene[side].zoom} min={1} max={4} step={.01} format={times} onChange={v => edit(n => { n.scene[side].zoom = v; })} />
    {side === "left" && <Slider label="加深" value={p.look.leftVeil * 100} defaultValue={defaults.look.leftVeil * 100} min={0} max={100} format={percent} onChange={v => edit(n => { n.look.leftVeil = v / 100; })} />}
  </Group>;
  const moveLeftContent = (patch: Partial<NonNullable<VisualizerProject["leftContent"]>>) => edit(n => { n.leftContent = { ...(n.leftContent ?? defaults.leftContent!), ...patch }; });
  const inspector = <aside className="kd-viz-inspector" aria-label="可视化设置">
    {!inDrawer && <EditorTabs<StudioTab> label="可视化设置分区" tabs={studioTabs} value={tab} onChange={selectTab} panelId={tabPanelId} />}
    <SlidePages page={tab} order={studioTabIds}>
    <fieldset id={tabPanelId} role="tabpanel" className="kd-viz-settings kd-scroll" disabled={busy}>{p && draft && <>
      {tab === "scene" && <>
        <Group title="画面">
          <Slider label="左右比例" value={p.scene.arc.position * 100} defaultValue={defaults.scene.arc.position * 100} min={25} max={75} step={.5} format={percent} onChange={v => edit(n => { n.scene.arc.position = v / 100; })} />
          <Slider label="背景动态" value={p.look.motion} defaultValue={defaults.look.motion} min={0} max={1} step={.01} format={ratio} onChange={v => edit(n => { n.look.motion = v; })} />
          <Slider label="频谱强度" value={p.look.spectrumGain} defaultValue={defaults.look.spectrumGain} min={.1} max={3} step={.05} format={ratio} onChange={v => edit(n => { n.look.spectrumGain = v; })} />
        </Group>
        <Group title="显示">
          <Toggle label="唱片" checked={p.scene.disc.mode !== "hidden"} onChange={v => edit(n => { n.scene.disc.mode = v ? "cover" : "hidden"; })} />
          <Toggle label="频谱" checked={p.look.mainSpectrum || p.look.smallSpectrum !== "off"} onChange={v => edit(n => { n.look.mainSpectrum = v; n.look.smallSpectrum = v ? "mixed" : "off"; })} />
          <Toggle label="能量线" checked={p.look.energyLine} onChange={v => edit(n => { n.look.energyLine = v; })} />
        </Group>
        <Group title="左侧内容" hint="封面、文字、歌词及下方频谱一起移动，背景和分界圆弧不变">
          <Slider label="水平" value={leftContent.x * 100} defaultValue={defaults.leftContent!.x * 100} min={-40} max={40} step={.5} origin={0} format={signedPercent} onChange={v => moveLeftContent({ x: v / 100 })} />
          <Slider label="垂直" value={leftContent.y * 100} defaultValue={defaults.leftContent!.y * 100} min={-40} max={40} step={.5} origin={0} format={signedPercent} onChange={v => moveLeftContent({ y: v / 100 })} />
          <Slider label="缩放" value={leftContent.scale} defaultValue={defaults.leftContent!.scale} min={.5} max={1.5} step={.01} format={ratio} onChange={v => moveLeftContent({ scale: v })} />
        </Group>
      </>}
      {tab === "pictures" && <>
        <Group title="图片">
          <div className="kd-viz-images">
            <ImageChoice blob={draft.images[0]} label="主图" action={draft.images.length ? "更换主图" : "添加主图"} disabled={busy} onPick={() => pickImage(0)} />
            <ImageChoice blob={draft.images[1]} label="背景图" action={draft.images.length > 1 ? "更换背景图" : "添加背景图"} disabled={busy || !draft.images.length} onPick={() => pickImage(1)}
              onRemove={draft.images.length > 1 ? () => { const project = structuredClone(p); syncVisualizerImages(project, 1); replaceDraft({ project, images: draft.images.slice(0, 1) }); } : undefined} />
          </div>
        </Group>
        {pictureSide("left")}{pictureSide("right")}
      </>}
      {tab === "text" && <>
        <Group title="歌曲信息">
          {([["title", "标题"], ["artist", "艺人"], ["album", "专辑"]] as const).map(([key, label]) => <Row key={key} label={label}><input value={p.text[key]} maxLength={500} onChange={e => edit(n => { n.text[key] = e.target.value; })} /></Row>)}
          <Toggle label="显示专辑" checked={p.text.showAlbum === true} onChange={v => edit(n => { n.text.showAlbum = v; })} />
          <Slider label="字号" value={p.text.scale} defaultValue={defaults.text.scale} min={.5} max={1.5} step={.01} format={ratio} onChange={v => edit(n => { n.text.scale = v; })} />
        </Group>
        <Group title="歌词">
          {hasLyrics && <Toggle label="显示歌词" checked={p.lyrics.mode !== "off"} onChange={v => edit(n => { n.lyrics.mode = v ? "scroll" : "off"; })} />}
          {hasLyrics && <Toggle label="显示翻译" checked={p.lyrics.showTranslation !== false} onChange={v => edit(n => { n.lyrics.showTranslation = v; })} />}
          <div className="kd-viz-buttons">
            <LyricsSourcePicker platform={lyricSource} disabled={busy || !draft} matching={loadingLyrics || lyricMatching} onSelect={platform => void loadSongLyrics(platform)} />
            <button type="button" disabled={loadingLyrics || lyricMatching} aria-busy={loadingLyrics} onClick={() => void loadSongLyrics()}>
              {!hasLyrics && <Captions size={14} aria-hidden="true" />}{loadingLyrics ? hasLyrics ? "正在读取歌词…" : "正在匹配歌词…" : hasLyrics ? "重新读取" : "匹配歌词"}</button>
            <button type="button" onClick={() => lyricInput.current?.click()}>导入歌词</button>
          </div>
        </Group>
      </>}
      {tab === "output" && <Group title="导出">
        <Row label="分辨率"><Select value={`${p.scene.canvas.width}x${p.scene.canvas.height}`} onChange={e => { const [width, height] = e.target.value.split("x").map(Number); edit(n => { n.scene.canvas = { width, height, fps: 30 }; }); }}>
          {resolutions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select></Row>
        <div className="kd-viz-row"><span>帧率</span><Segmented label="帧率" options={frameRates} value={p.output.fps} onChange={fps => edit(n => { n.output.fps = fps; })} /></div>
        {duration > 0 && <div className="kd-viz-row"><span>预计大小</span><output>约 {formatBytes(studioExportBytes(p.scene.canvas.width, p.scene.canvas.height, p.output.fps, duration))}</output></div>}
        <Row label="文件名"><input value={p.output.filename} onChange={e => edit(n => { n.output.filename = e.target.value; })} /></Row>
        <Toggle label="水印" checked={p.output.watermark !== false} onChange={v => edit(n => { n.output.watermark = v; })} />
      </Group>}
    </>}</fieldset>
    </SlidePages>
  </aside>;

  return <section ref={panel} tabIndex={-1} className="kd-viz-panel" data-inline={inline || undefined} data-floating={floating || undefined} aria-label="音频可视化编辑器" onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Escape" && (expanded || !inline)) { e.preventDefault(); if (expanded) void applyFullscreen(false); else requestClose(); return; }
      const target = e.target as HTMLElement;
      if (target.closest("input:not([type=range]), textarea, select, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(e.shiftKey); }
      if (e.key === " " && !target.closest("button, summary, [role=slider], [role=tab]")) { e.preventDefault(); togglePlayback(); }
    }}>
    {inline && settings(<>{toolbar}{noticeRow}</>)}
    <div className="kd-viz-content">
    <div className="kd-viz-preview-column">
    <FloatingPreviewFrame floating={floating} fullscreen={expanded} editing={!floating && !expanded} compact={emptyMedia}
      shared={popup} title={track.title || track.filename}
      ratio={inline ? 16 / 9 : p ? p.scene.canvas.width / p.scene.canvas.height : 16 / 9}
      onEscape={() => { if (expanded) void applyFullscreen(false); else if (floating) setFloating(false); else requestClose(); }}>
      {prepared && p ? <canvas ref={canvas} aria-label="音频可视化预览，可拖动左右图片调整位置" onPointerDown={e => {
        if (busy || floating || expanded || e.button !== 0 || !e.isPrimary || !draft) return;
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
            : <button type="button" disabled={busy} aria-label="添加图片" title="添加图片" onClick={() => { imageSlot.current = 0; imageInput.current?.click(); }}><ImagePlus size={20} /></button>}
        </div>}
      </div>}
      {inline && !settingsTarget && notice && <div className="kd-viz-notice kd-viz-inline-notice" role="alert">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}
      {prepared && <StudioPosition position={cursorRef} scrub={scrubTime} refresh={refreshCursor}>{cursor => <>
        <FloatingVideoControls title={track.title || track.filename} playing={playing} position={cursor} duration={duration} fullscreen={expanded} showTitle={floating && !expanded}
          onToggle={togglePlayback} onFullscreen={() => void applyFullscreen(!expanded)}
          onClose={floating ? () => { void applyFullscreen(false).then(ok => { if (ok) setFloating(false); }); } : undefined} closeLabel={popup ? "关闭可视化小窗" : "收回预览小窗"}
          extra={<>
            {!floating && <button type="button" aria-label="打开预览小窗" title="打开预览小窗" onClick={() => { void applyFullscreen(false).then(ok => { if (ok) setFloating(true); }); }}><PictureInPicture2 size={13} /></button>}
            {/* Entries live in the control row: the picture's corners belong to the hosting panel's own tools. */}
            {inline && !expanded && <button type="button"
              title={loadingLyrics ? "正在匹配歌词…" : lyricsVisible ? "关闭歌词" : "开启歌词"}
              aria-label={lyricsVisible ? "关闭可视化歌词" : "开启可视化歌词"} aria-pressed={lyricsVisible}
              aria-busy={loadingLyrics} disabled={!p || busy || loadingLyrics || lyricMatching}
              onClick={event => { event.stopPropagation(); togglePreviewLyrics(); }}>
              {loadingLyrics ? <LoaderCircle size={13} className="kd-spin" /> : <Captions size={13} />}
            </button>}
            {inline && !expanded && <button type="button" title={busy ? "正在加入导出队列…" : "加入导出队列"} aria-label="加入导出队列"
              aria-busy={busy} disabled={!prepared || analyzing || busy}
              onClick={event => { event.stopPropagation(); void enqueueExport(); }}>
              {busy ? <LoaderCircle size={13} className="kd-spin" /> : <ListPlus size={13} />}
            </button>}
            {inline && !expanded && <button type="button"
              aria-label="打开可视化操作与设置" title="可视化操作与设置" aria-pressed={settingsOpen}
              onClick={event => { event.stopPropagation(); useVisualizerStudioStore.getState().openInlineSettings(track); }}><SlidersHorizontal size={13} /></button>}
          </>} />
        <FloatingVideoScrub position={cursor} duration={duration} aria-label="预览时间" aria-disabled={busy}
          onPointerDown={e => { if (busy || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
          onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e); }}
          onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { scrub(e, true); e.currentTarget.releasePointerCapture(e.pointerId); } }}
          onPointerCancel={() => { scrubTime.current = null; drawPreview.current?.(); }} onLostPointerCapture={() => { scrubTime.current = null; drawPreview.current?.(); }}
          onKeyDown={e => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return; e.preventDefault(); seek(e.key === "Home" ? 0 : e.key === "End" ? duration : cursor + (e.key === "ArrowRight" ? 5 : -5)); }} />
      </>}</StudioPosition>}
    </FloatingPreviewFrame>
    </div>
    {!inline && <>{toolbar}{noticeRow}</>}
    {settingsVisible && settings(inspector)}
    </div>
    <input hidden ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" onChange={e => void onImage(e)} />
    <input hidden ref={lyricInput} type="file" accept=".lrc,.txt" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; if (file.size > 250000) { setNotice("歌词文件过大"); return; } void file.text().then(text => edit(n => { n.lyrics.lrc = text; })).catch(error => setNotice(message(error))); }} />
  </section>;
}
