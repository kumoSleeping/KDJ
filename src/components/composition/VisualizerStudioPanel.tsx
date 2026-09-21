import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type ReactNode } from "react";
import { X, PictureInPicture2, Film, Undo2, Redo2, ImagePlus, Volume2, VolumeX, RotateCcw, Captions } from "lucide-react";
import type { TrackSummary } from "../../types";
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
import { getPlayerSession, requestPlayerCommand, subscribePlayerSession } from "../../lib/playerSession";
import { playTrack } from "../../lib/playTrack";
import { useMasterVolume } from "../../lib/masterVolume";
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

export default function VisualizerStudioPanel({ onClose }: { onClose?: () => void }) {
  const track = useVisualizerStudioStore(s => s.track);
  const fromPlayback = useVisualizerStudioStore(s => s.fromPlayback);
  return track ? <Studio key={track.id} track={track} fromPlayback={fromPlayback} onClose={onClose} /> : null;
}
function Studio({ track, fromPlayback, onClose }: { track: TrackSummary; fromPlayback: boolean; onClose?: () => void }) {
  const [draft, setDraft] = useState<VisualizerDraft | null>(null);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  const [analysis, setAnalysis] = useState<{ timeline: VisualizerFeatureTimeline; signature: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [loadingLyrics, setLoadingLyrics] = useState(false);
  const lyricSource = useLyricsStore(s => s.byId[track.id]?.meta?.platform);
  const lyricMatching = useLyricsStore(s => !!s.byId[track.id]?.inflight);
  const [notice, setNotice] = useState("");
  const { fullscreen: expanded, applyFullscreen } = usePreviewFullscreen();
  const [floating, setFloating] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closing = useRef(false);
  const [playing, setPlaying] = useState(false);
  const volume = useMasterVolume(s => s.volume), muted = volume === 0;
  const previousVolume = useRef(volume || 1);
  const scrubTime = useRef<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0), drawPreview = useRef<(() => void) | null>(null);
  const [previewWidth, setPreviewWidth] = useState(960);
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
    // Following a switch must not reissue play while the new transport is loading.
    if (!fromPlayback) {
      const pip = useVideoPip.getState(); if (pip.active) pip.clear();
      if (getCompositionClock().trackId !== track.id) playTrack(track, false, "composition", 0);
    }
    let lastUi = -Infinity;
    const update = () => {
      const clock = getCompositionClock(), active = clock.trackId === track.id && clock.ready;
      setPlaying(active && clock.playing);
      if (active && clock.fresh !== false && scrubTime.current === null) {
        cursorRef.current = Math.max(0, clock.currentTime);
        const now = performance.now();
        if (now - lastUi >= 125 || !clock.playing) { lastUi = now; setCursor(cursorRef.current); }
      }
      const session = getPlayerSession();
      if (session.trackId === track.id && session.error) setNotice(session.error);
      drawPreview.current?.();
    };
    const unlisten = subscribePlayerSession(update), timer = window.setInterval(update, 125);
    update(); return () => { unlisten(); window.clearInterval(timer); };
  }, [track.id, fromPlayback]);

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
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
      const [cover, lyrics] = await Promise.allSettled([visualizerApi.cover(track.id, controller.signal), api.libraryLyrics(track.id)]);
      if (!active) return;
      if (cover.status === "fulfilled" && cover.value && cover.value.size <= STUDIO_IMAGE_LIMIT) blobs.push(cover.value);
      if (lyrics.status === "fulfilled") { project.lyrics.lrc = studioLyricText(lyrics.value.lrc || "", lyrics.value.word_lrc); project.lyrics.translation = lyrics.value.translated_lrc || ""; }
      project.lyrics.mode = hasStudioLyrics(project.lyrics.lrc) ? "scroll" : "off";
      syncVisualizerImages(project, blobs.length); install({ project, images: blobs });
    })().catch(e => { if (active) setNotice(message(e)); });
    return () => { active = false; controller.abort(); };
  }, [track.id]);

  useEffect(() => {
    if (!draft) return;
    const snapshot = draft;
    const timer = window.setTimeout(() => {
      saveChain.current = saveChain.current.catch(() => undefined).then(() => saveVisualizerDraft(snapshot));
      void saveChain.current.then(() => setNotice(current => current.startsWith("无法记住当前调整：") ? "" : current), e => { setNotice(`无法记住当前调整：${message(e)}`); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    let active = true; setImages([]);
    if (draft?.images.length) void loadStudioImages(draft.images).then(v => { if (active) setImages(v); }, e => { if (active) setNotice(message(e)); });
    return () => { active = false; };
  }, [draft?.images]);
  useEffect(() => {
    if (!p) return;
    const controller = new AbortController(); setAnalyzing(true);
    const timer = window.setTimeout(() => {
      void visualizerApi.analyze(track.id, p.scene.spectrum, controller.signal).then(result => { if (!controller.signal.aborted) setAnalysis(result); }).catch(e => { if (!controller.signal.aborted) { setAnalysis(null); setNotice(message(e)); } }).finally(() => { if (!controller.signal.aborted) setAnalyzing(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [track.id, spectrumKey]);

  const prepared = useMemo(() => {
    if (!p || !analysis || !images.length || images.length !== p.scene.images.length) return null;
    try { return prepareStudio(p, images, analysis.timeline, previewWidth); } catch { return null; }
  }, [p, images, analysis, previewWidth]);
  useEffect(() => {
    const target = canvas.current; if (!target || !p) return;
    let timer = 0;
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const width = target.getBoundingClientRect().width; if (!width) return;
        const pixels = Math.ceil(width * Math.min(window.devicePixelRatio || 1, 2) / 64) * 64;
        setPreviewWidth(Math.min(p.scene.canvas.width, Math.max(320, Math.min(1440, pixels))));
      }, 120);
    };
    const observer = new ResizeObserver(resize); observer.observe(target); window.addEventListener("resize", resize); resize();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); window.clearTimeout(timer); };
  }, [!!prepared, p?.scene.canvas.width, p?.scene.canvas.height, floating, expanded]);
  useEffect(() => {
    if (!prepared || !canvas.current) return;
    // Preview never reads pixels. Don't force the export's CPU readback backend here.
    const c = canvas.current.getContext("2d", { alpha: false }); if (!c) return;
    let frame = 0;
    const draw = () => {
      const clock = getCompositionClock();
      if (scrubTime.current === null && clock.ready && clock.fresh !== false && clock.trackId === track.id) cursorRef.current = clock.currentTime;
      drawStudioFrame(c, prepared, scrubTime.current ?? cursorRef.current);
    };
    const tick = () => { draw(); if (playing) frame = requestAnimationFrame(tick); };
    const resume = () => { cancelAnimationFrame(frame); if (!document.hidden) tick(); };
    drawPreview.current = () => { if ((!playing || scrubTime.current !== null) && !document.hidden) draw(); };
    document.addEventListener("visibilitychange", resume); resume();
    return () => { cancelAnimationFrame(frame); drawPreview.current = null; document.removeEventListener("visibilitychange", resume); };
  }, [prepared, playing, floating, expanded]);
  useEffect(() => {
    return () => {
      const snapshot = latestDraft.current;
      if (snapshot) void saveChain.current.catch(() => undefined).then(() => saveVisualizerDraft(snapshot))
        .catch(error => useToastStore.getState().show(`无法记住可视化调整：${message(error)}`));
    };
  }, []);
  useEffect(() => {
    const handler = () => close();
    useVisualizerStudioStore.getState().setBeforeClose(handler);
    return () => { if (useVisualizerStudioStore.getState().beforeClose === handler) useVisualizerStudioStore.getState().setBeforeClose(null); };
  }, [draft, busy]);

  function checkpoint(current: VisualizerDraft, force = false) {
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
  async function saveNow() { if (!draft) return; await saveChain.current.catch(() => undefined); await saveVisualizerDraft(draft); }
  function requestClose() { if (onClose) onClose(); else void close(); }
  async function close(): Promise<boolean> {
    if (closing.current) return false;
    closing.current = true;
    try {
      try { await saveNow(); } catch (e) { if (!window.confirm(`无法记住当前调整：${message(e)}。仍要关闭？`)) return false; }
      if (useVisualizerStudioStore.getState().track?.id !== track.id) return false;
      if (!await applyFullscreen(false)) return false;
      useVisualizerStudioStore.getState().close();
      return true;
    } finally { closing.current = false; }
  }
  async function enqueueExport() {
    if (!draft || !prepared || busy || analyzing) return;
    setBusy(true); setNotice("");
    try {
      await useVisualizerExportStore.getState().enqueue(draft);
      useToastStore.getState().show("已加入工作站的可视化导出队列");
    } catch (error) { setNotice(`加入导出队列失败：${message(error)}`); }
    finally { setBusy(false); }
  }
  function seek(time: number) {
    if (!analysis || busy) return;
    const next = clamp(time, 0, duration);
    scrubTime.current = null;
    const clock = getCompositionClock();
    if (clock.trackId === track.id && clock.ready) requestPlayerCommand({ type: "seek", position: next });
    else playTrack(track, false, "composition", next);
    cursorRef.current = next; setCursor(next); drawPreview.current?.();
  }
  function scrub(event: PointerEvent<HTMLDivElement>, commit = false) {
    const rect = event.currentTarget.getBoundingClientRect(); if (!rect.width) return;
    const next = clamp((event.clientX - rect.left) / rect.width * duration, 0, duration);
    if (commit) seek(next);
    else { scrubTime.current = next; setCursor(next); drawPreview.current?.(); }
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
      if (!hasStudioLyrics(lrc)) { setNotice("未匹配到可用的原文歌词。"); return; }
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
  function toggleMute() {
    const current = useMasterVolume.getState();
    if (current.volume > 0) { previousVolume.current = current.volume; current.setVolume(0); }
    else current.setVolume(previousVolume.current);
  }

  return <section ref={panel} tabIndex={-1} className="kd-viz-panel" aria-label="音频可视化编辑器" onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); if (expanded) void applyFullscreen(false); else requestClose(); return; }
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(e.shiftKey); }
      if (e.key === " " && !target.closest("button, summary, [role=slider]")) { e.preventDefault(); togglePlayback(); }
    }}>
    <div className="kd-viz-export-bar">
      <button type="button" className="kd-viz-export" disabled={!prepared || analyzing || busy} onClick={() => void enqueueExport()}><Film size={17} />{busy ? "正在加入…" : "加入导出队列"}</button>
      <div className="kd-viz-job" aria-live="polite">{analyzing ? "正在分析频谱…" : ""}</div>
    </div>
    <div className="kd-viz-content kd-scroll">
    <div className="kd-viz-preview-column">
    <FloatingPreviewFrame floating={floating} fullscreen={expanded} editing={!floating && !expanded}
      ratio={p ? p.scene.canvas.width / p.scene.canvas.height : 16 / 9}
      onEscape={() => { if (expanded) void applyFullscreen(false); else if (floating) setFloating(false); else requestClose(); }}>
      {prepared && p ? <canvas ref={canvas} width={prepared.project.scene.canvas.width} height={prepared.project.scene.canvas.height} aria-label="音频可视化预览，可拖动左右图片调整位置" onPointerDown={e => {
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
        {!draft || analyzing ? <span role="status">{!draft ? "正在加载…" : "正在分析音频…"}</span> : !draft.images.length ? <button type="button" disabled={busy} aria-label="添加图片" title="添加图片" onClick={() => { imageSlot.current = 0; imageInput.current?.click(); }}><ImagePlus size={20} /></button> : null}
      </div>}
      {prepared && <>
        <FloatingVideoControls title={track.title || track.filename} playing={playing} position={cursor} duration={duration} fullscreen={expanded}
          onToggle={togglePlayback} onFullscreen={() => void applyFullscreen(!expanded)}
          onClose={floating ? () => { void applyFullscreen(false).then(ok => { if (ok) setFloating(false); }); } : undefined} closeLabel="收回预览小窗"
          extra={<>
            {!floating && <button type="button" aria-label="打开预览小窗" title="打开预览小窗" onClick={() => { void applyFullscreen(false).then(ok => { if (ok) setFloating(true); }); }}><PictureInPicture2 size={13} /></button>}
            <button type="button" aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"} aria-pressed={muted} onClick={toggleMute}>{muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
          </>} />
        <FloatingVideoScrub position={cursor} duration={duration} aria-label="预览时间" aria-disabled={busy}
          onPointerDown={e => { if (busy || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
          onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e); }}
          onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { scrub(e, true); e.currentTarget.releasePointerCapture(e.pointerId); } }}
          onPointerCancel={() => { scrubTime.current = null; drawPreview.current?.(); }} onLostPointerCapture={() => { scrubTime.current = null; drawPreview.current?.(); }}
          onKeyDown={e => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return; e.preventDefault(); seek(e.key === "Home" ? 0 : e.key === "End" ? duration : cursor + (e.key === "ArrowRight" ? 5 : -5)); }} />
      </>}
    </FloatingPreviewFrame>
    <div className="kd-viz-song"><strong title={track.title || track.filename}>{track.title || track.filename}</strong>{track.artist && <small title={track.artist}>{track.artist}</small>}</div>
    <div className="kd-viz-toolbar">
      <button type="button" disabled={!history.current.past.length || busy} onClick={() => undo()} title="撤销" aria-label="撤销"><Undo2 size={14} /></button>
      <button type="button" disabled={!history.current.future.length || busy} onClick={() => undo(true)} title="重做" aria-label="重做"><Redo2 size={14} /></button>
      <button type="button" disabled={!p || busy} onClick={refreshAutomaticConfiguration} title="恢复默认布局、字号、特效和歌曲信息；保留图片、歌词与输出设置，可撤销"><RotateCcw size={13} />刷新自动配置</button>
    </div>
    {notice && <div className="kd-viz-notice" role="alert">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}
    </div>
    <fieldset className="kd-viz-settings" disabled={busy}>{p && draft && <>
      <div className="kd-viz-settings-column">
      <div className="kd-viz-fields">
        {hasLyrics ? <Toggle label="显示歌词" checked={p.lyrics.mode !== "off"} onChange={v => edit(n => { n.lyrics.mode = v ? "scroll" : "off"; })} /> : <button type="button" disabled={loadingLyrics} aria-busy={loadingLyrics} onClick={() => void loadSongLyrics()}><Captions size={15} aria-hidden="true" />{loadingLyrics ? "正在匹配歌词…" : "尝试匹配歌词"}</button>}
        {hasLyrics && <Toggle label="显示翻译" checked={p.lyrics.showTranslation !== false} onChange={v => edit(n => { n.lyrics.showTranslation = v; })} />}
        <Range label="整体字号" value={p.text.scale} resetValue={defaults.text.scale} min={.5} max={1.5} onChange={v => edit(n => { n.text.scale = v; })} />
      </div>
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
        <label>分辨率<select value={`${p.scene.canvas.width}x${p.scene.canvas.height}`} onChange={e => { const [width, height] = e.target.value.split("x").map(Number); edit(n => { n.scene.canvas = { width, height, fps: 30 }; }); }}>
          <option value="1920x1080">1080p · 16:9</option><option value="1280x720">720p · 16:9</option><option value="1920x840">1920 × 840 · 超宽</option><option value="2560x1080">2560 × 1080 · 超宽</option>
        </select></label>
        <label>帧率<select value={p.output.fps} onChange={e => edit(n => { n.output.fps = Number(e.target.value) as 30 | 60; })}><option value={30}>30 fps</option><option value={60}>60 fps</option></select></label>
        <label className="kd-viz-wide">文件名<input value={p.output.filename} onChange={e => edit(n => { n.output.filename = e.target.value; })} /></label>
      </Group>
      </div>
    </>}</fieldset>
    </div>
    <input hidden ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" onChange={e => void onImage(e)} />
    <input hidden ref={lyricInput} type="file" accept=".lrc,.txt" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; if (file.size > 250000) { setNotice("歌词文件过大"); return; } void file.text().then(text => edit(n => { n.lyrics.lrc = text; })).catch(error => setNotice(message(error))); }} />
  </section>;
}
