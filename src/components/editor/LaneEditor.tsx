/**
 * The editor of `.kdjv` 2 projects (docs/kdjv.md, "格式 2"), in the drawer beside the list. Each
 * open project is a page of the drawer's title; a song dropped on the title starts another one.
 * At the top the transport, undo and redo, a marker at the playhead and the zoom; under it the
 * lanes (LaneBoard.tsx), handled directly; below them 字幕 and 导出, and everything that can be
 * done to what is chosen on the lanes, in one place (LanePanels.tsx). Nothing open, the same
 * editor stands empty, ready for what is dropped into it. Every change is a list of operations the
 * server checks and saves (laneEditorStore.ts); the picture is the video window's while the
 * project plays.
 */
import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Download, LoaderCircle, Magnet, MapPin, Maximize2, Pause, Play, Redo2, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../../lib/api";
import { downloadIntoEditor } from "../../lib/editorDownloads";
import { isGap, laneClock, type LaneClip, type LaneOp } from "../../lib/lanes";
import { getPlayerSession, requestPlayerCommand, subscribePlayerSession } from "../../lib/playerSession";
import { playTrack } from "../../lib/playTrack";
import { requestLocalVideo, useVideoPip } from "../../lib/videoPip";
import { songsOf, useActiveProject, useLaneEditor, type LaneProject } from "../../stores/laneEditorStore";
import type { Track } from "../../types";
import { clampZoom, LaneBoard, ZOOM_MAX, ZOOM_MIN } from "./LaneBoard";
import { ToolPanel, type Tool } from "./LanePanels";
import "./LaneEditor.css";



/** What the editor shows with nothing open: the lanes of a project not made yet. */
const NOTHING: LaneProject = {
  path: "", trackId: null, songIds: [], grid: null, analysing: false, lengths: {},
  doc: { kdjv: 2, title: "", main: [], branches: [] },
  layout: { duration: 60, main_end: 0, main: [], branches: [], songs: [] },
};

function usePlayhead(trackId: number | null) {
  const session = useSyncExternalStore(subscribePlayerSession, getPlayerSession);
  const mine = trackId !== null && session.trackId === trackId;
  return { mine, playing: mine && session.playing, position: mine ? session.position : null };
}

/** The library rows of a drop, read whole (their lengths), in the order they were dragged. */
async function droppedTracks(ids: readonly number[]): Promise<Track[]> {
  const tracks = await Promise.all(ids.map(id => api.track(id).catch(() => null)));
  return tracks.filter((track): track is Track => Boolean(track));
}

export function LaneEditor() {
  const active = useActiveProject();
  const { selected, busy, error, select, placeTracks, undo, redo, snap, toggleSnap, setRange } = useLaneEditor();
  const edit = useLaneEditor(state => state.edit);
  const history = useLaneEditor(state => (active ? state.history[active.path] : undefined));
  const aligning = useLaneEditor(state => state.aligning.length);
  const project = active ?? NOTHING;
  const open = active !== null;
  const playhead = usePlayhead(project.trackId);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool | null>(null);
  const area = useRef<HTMLDivElement>(null);

  const send = (ops: LaneOp[]) => { void edit(ops); };
  const { doc, layout, grid, trackId } = project;
  const span = Math.max(1, layout.duration);
  const vj = songsOf(doc).length > 0;

  /** What was dropped goes where it belongs (laneEditorStore `placeTracks`). */
  const dropInto = async (ids: readonly number[], at: number, sound: boolean) => {
    const tracks = await droppedTracks(ids);
    if (tracks.length) await placeTracks(active?.path ?? null, tracks, at, sound);
  };

  /** One beat at `t` (the song's own beat there, through any tempo change), else half a second. */
  const beatNear = (t: number) => {
    const beats = grid?.beats ?? [];
    const k = beats.findIndex(at => at > t);
    return k > 0 ? Math.round((beats[k] - beats[k - 1]) * 1000) / 1000 : 0.5;
  };
  /** The playhead to `t`: the project playing goes there; one not loaded yet is loaded there, paused. */
  const seek = (t: number) => {
    if (trackId === null) return;
    if (playhead.mine) { requestPlayerCommand({ type: "seek", position: t }); return; }
    void api.track(trackId).then(track => playTrack(track, false, undefined, t)).catch(() => undefined);
  };
  const toggle = () => {
    if (trackId === null) return;
    if (playhead.mine) {
      requestPlayerCommand({ type: "toggle" });
      // Playing again after the picture was put away brings it back.
      const pip = useVideoPip.getState();
      const shown = pip.active && pip.session?.source === "local" && pip.session.trackId === trackId;
      if (!playhead.playing && !shown && layout.main.some(item => !item.gap)) {
        void api.track(trackId).then(track => requestLocalVideo(track, true)).catch(() => undefined);
      }
      return;
    }
    void api.track(trackId).then(track => playTrack(track, true)).catch(() => undefined);
  };
  const mark = () => {
    if (playhead.position === null) return;
    const at = Math.round(playhead.position * 1000) / 1000;
    const markers = doc.markers ?? [];
    if (markers.some(m => Math.abs(m.at - at) < 0.05)) return;
    send([{ op: "markers", markers: [...markers, { at }] }]);
  };

  /** One frame of the project, in seconds. */
  const frame = 1 / ((doc.canvas as { fps?: number } | undefined)?.fps || 30);
  /** Where the playhead stops on ↑ and ↓: both ends, the markers, and where clips, songs and titles begin and end. */
  const editPoints = () => [...new Set([0, span, ...(doc.markers ?? []).map(m => m.at),
    ...layout.main.filter(item => !item.gap).flatMap(item => [item.at, item.at + item.length]),
    ...(layout.songs ?? []).flatMap(song => [song.at, song.at + song.length]),
    ...(doc.titles ?? []).flatMap(title => [title.at, title.at + title.length])].map(t => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
  /**
   * Shift + Delete: the clip goes and what follows closes up behind it. In a VJ the black left in its
   * place (with the black beside it) is shortened by the clip's length; without songs the lane
   * already closes up.
   */
  const rippleOps = (clip: LaneClip): LaneOp[] => {
    const i = layout.main.findIndex(item => item.id === clip.id);
    if (i < 0) return [];
    if (!vj) return [{ op: "remove", id: clip.id }];
    const before = layout.main[i - 1]?.gap ? layout.main[i - 1] : null;
    const after = layout.main[i + 1]?.gap ? layout.main[i + 1] : null;
    const index = before ? i - 1 : i;
    const left = (before?.length ?? 0) + (after?.length ?? 0);
    return [{ op: "remove", id: clip.id }, { op: "gap", index, length: Math.round(left * 1000) / 1000 }];
  };

  /**
   * The editor's keys, as the workshop had them: Space plays; ← → a frame (Shift ten), the chosen
   * clip of a VJ or else the playhead; ↑ ↓ the edit point before or after; N snapping to the beats;
   * I and O the in and out points; M a marker; S a cut at the playhead; Delete what is chosen
   * (Shift + Delete closes up behind it); Esc lets it go; ⌘Z / ⇧⌘Z / ⌘Y undo and redo.
   */
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || event.nativeEvent.isComposing || (event.target as HTMLElement).closest("input, textarea, select, [role=slider], [role=radiogroup]")) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "z") { event.preventDefault(); void (event.shiftKey ? redo() : undo()); return; }
    if (command && key === "y") { event.preventDefault(); void redo(); return; }
    if (command || event.altKey) return;
    const clip = doc.main.find((item): item is LaneClip => !isGap(item) && item.id === selected);
    const removal: LaneOp | null = clip ? { op: "remove", id: clip.id }
      : selected?.startsWith("title:") ? { op: "remove_title", id: selected.slice(6) }
        : selected?.startsWith("song:") ? { op: "remove_song", index: Number(selected.slice(5)) } : null;
    const step = frame * (event.shiftKey ? 10 : 1);
    if (key === " ") {
      // Space on a key presses that key.
      if ((event.target as HTMLElement).closest("button, summary")) return;
      event.preventDefault(); toggle();
    } else if (key === "arrowleft" || key === "arrowright") {
      event.preventDefault();
      const by = key === "arrowleft" ? -step : step;
      const placed = clip && layout.main.find(item => item.id === clip.id);
      if (vj && clip && placed) send([{ op: "move_to", id: clip.id, at: Math.max(0, Math.round((placed.at + by) * 1000) / 1000), over: true }]);
      else seek(Math.max(0, Math.min(span, (playhead.position ?? 0) + by)));
    } else if (key === "arrowup" || key === "arrowdown") {
      event.preventDefault();
      const at = playhead.position ?? 0, points = editPoints();
      const target = key === "arrowup" ? points.filter(t => t < at - 0.01).at(-1) : points.find(t => t > at + 0.01);
      if (target !== undefined) seek(target);
    } else if (key === "n" && !event.shiftKey) { event.preventDefault(); toggleSnap(); }
    else if ((key === "i" || key === "o") && !event.shiftKey && playhead.position !== null) {
      event.preventDefault(); setRange(key === "i" ? "in" : "out", Math.round(playhead.position * 1000) / 1000);
    }
    else if (key === "m") { event.preventDefault(); mark(); }
    else if (key === "s" && clip && playhead.position !== null) { event.preventDefault(); send([{ op: "split", id: clip.id, at: playhead.position }]); }
    else if ((event.key === "Delete" || event.key === "Backspace") && removal) {
      event.preventDefault(); send(event.shiftKey && clip ? rippleOps(clip) : [removal]);
    }
    else if (event.key === "Escape" && (selected || tool)) { event.preventDefault(); select(null); setTool(null); }
  };

  const status = busy ? <><LoaderCircle size={12} className="kd-spin" />保存中</>
    : error ? error
      : aligning ? <><LoaderCircle size={12} className="kd-spin" />正在校准</>
        : project.analysing ? <><LoaderCircle size={12} className="kd-spin" />正在分析小节线</> : null;

  // A press on the lanes or the keys gives the editor the keyboard (WebKit does not focus a pressed button).
  const focusKeys = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) area.current?.focus({ preventScroll: true });
  };
  return <div ref={area} className="kd-lanes kd-scroll" data-drawer-scroll data-empty={open ? undefined : ""} tabIndex={-1}
    onPointerDownCapture={focusKeys} onKeyDown={keys}>
    <div className="kd-lanes-head">
      <button type="button" className="kd-lanes-key" disabled={!open} onClick={toggle} aria-label={playhead.playing ? "暂停" : "播放"}>
        {playhead.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <span className="kd-lanes-time">{laneClock(playhead.position ?? 0)} / {laneClock(open ? span : 0)}</span>
      <button type="button" className="kd-lanes-key" disabled={!history?.past.length || busy} onClick={() => void undo()} aria-label="撤销" title="撤销 · ⌘Z"><Undo2 size={14} /></button>
      <button type="button" className="kd-lanes-key" disabled={!history?.future.length || busy} onClick={() => void redo()} aria-label="重做" title="重做 · ⇧⌘Z"><Redo2 size={14} /></button>
      <button type="button" className="kd-lanes-key" disabled={playhead.position === null} onClick={mark} aria-label="在播放头加标记" title="标记 · M"><MapPin size={14} /></button>
      {open ? <input className="kd-lanes-title" defaultValue={doc.title} key={`${project.path}:${doc.title}`} aria-label="工程名"
        onBlur={event => { const title = event.target.value.trim(); if (title && title !== doc.title) send([{ op: "title", title }]); }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        : <span className="kd-lanes-grow" />}
      {vj && <button type="button" className="kd-lanes-key" aria-pressed={snap} onClick={toggleSnap} aria-label="吸附到拍" title="吸附到拍 · N（拖动时按住 ⌥ 临时不吸附）"><Magnet size={14} /></button>}
      <button type="button" className="kd-lanes-key" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom(z => clampZoom(z / 2))} aria-label="缩小" title="缩小 · 捏合或 ⌥/Ctrl + 滚轮"><ZoomOut size={14} /></button>
      <button type="button" className="kd-lanes-key" disabled={zoom >= ZOOM_MAX} onClick={() => setZoom(z => clampZoom(z * 2))} aria-label="放大" title="放大 · 捏合或 ⌥/Ctrl + 滚轮"><ZoomIn size={14} /></button>
      <button type="button" className="kd-lanes-key" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom(ZOOM_MIN)} aria-label="适合宽度" title="适合宽度"><Maximize2 size={14} /></button>
    </div>
    {status && <p className="kd-lanes-status" role={error ? "alert" : undefined} data-error={error ? "" : undefined} title={error ?? undefined}>{status}</p>}

    <LaneBoard area={area} project={project} zoom={zoom} onZoom={setZoom} selected={selected} select={id => { select(id); setTool(null); }} playhead={playhead.position}
      seek={seek} beatNear={beatNear} edit={send} onDropped={(ids, at, sound) => void dropInto(ids, at, sound)}
      onSearchDropped={(payload, at, sound) => void downloadIntoEditor(payload, active?.path ?? null, at, sound)} />

    <div className="kd-lanes-tools" role="toolbar" aria-label="剪辑工具">
      <span className="kd-lanes-grow" />
      <button type="button" className="kd-lanes-tool" disabled={!open} aria-pressed={tool === "title"}
        onClick={() => { select(null); setTool(now => (now === "title" ? null : "title")); }}>
        <Type size={14} aria-hidden="true" />字幕
      </button>
      <button type="button" className="kd-lanes-tool" disabled={!open} aria-pressed={tool === "export"}
        onClick={() => setTool(now => (now === "export" ? null : "export"))}>
        <Download size={14} aria-hidden="true" />导出
      </button>
    </div>
    {open && <div key={tool ?? selected ?? ""} className="kd-lanes-panel" data-kd-turn="in">
      <ToolPanel tool={tool} project={project} selected={selected} playhead={playhead.position} beatNear={beatNear} edit={send} />
    </div>}
  </div>;
}
