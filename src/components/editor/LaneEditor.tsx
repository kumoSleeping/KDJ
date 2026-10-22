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
import { useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Download, LoaderCircle, MapPin, Pause, Play, Redo2, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../../lib/api";
import { isGap, laneClock, snapToBar, type LaneClip, type LaneOp } from "../../lib/lanes";
import { getPlayerSession, requestPlayerCommand, subscribePlayerSession } from "../../lib/playerSession";
import { playTrack } from "../../lib/playTrack";
import { requestLocalVideo, useVideoPip } from "../../lib/videoPip";
import { clipOf, isPictureTrack, isSongTrack, songOf, songsOf, useActiveProject, useLaneEditor, type LaneProject } from "../../stores/laneEditorStore";
import type { Track } from "../../types";
import { LaneBoard, ZOOMS } from "./LaneBoard";
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
  return tracks.filter((track): track is Track => Boolean(track && (track.duration ?? 0) > 0));
}

export function LaneEditor() {
  const active = useActiveProject();
  const { selected, busy, error, edit, select, createFrom, undo, redo } = useLaneEditor();
  const history = useLaneEditor(state => (active ? state.history[active.path] : undefined));
  const aligning = useLaneEditor(state => state.aligning.length);
  const project = active ?? NOTHING;
  const open = active !== null;
  const playhead = usePlayhead(project.trackId);
  const [zoom, setZoom] = useState(0);
  const [tool, setTool] = useState<Tool | null>(null);

  const send = (ops: LaneOp[]) => { void edit(ops); };
  const { doc, layout, grid, trackId } = project;
  const span = Math.max(1, layout.duration);

  /** What was dropped goes where it belongs: songs into the song lane at the slot, pictures at `at`. */
  const dropInto = async (ids: readonly number[], at: number) => {
    const tracks = await droppedTracks(ids);
    if (tracks.length === 0) return;
    if (!active) { await createFrom(tracks); return; }
    const songs = tracks.filter(isSongTrack), pictures = tracks.filter(isPictureTrack);
    const ops: LaneOp[] = [];
    const placed = layout.songs ?? [];
    let index = placed.filter(s => s.at + s.length / 2 < at).length;
    for (const song of songs) ops.push({ op: "add_song", song: songOf(song), index: index++ });
    if (pictures.length) {
      if (placed.length > 0 || songs.length > 0) {
        // In a VJ a picture goes in at the bar where it is let go, over whatever is there, as far
        // as the songs reach.
        const end = placed.reduce((sum, s) => sum + s.length, 0) + songs.reduce((sum, s) => sum + (s.duration ?? 0), 0);
        let place = Math.min(snapToBar(grid?.downbeats ?? [], at), Math.max(0, end - 0.1));
        for (const picture of pictures) {
          const out = Math.round(Math.min(picture.duration ?? 0, end - place) * 1000) / 1000;
          if (out <= 0.05) break;
          ops.push({ op: "add", clip: { ...clipOf(picture, true), out }, at: Math.round(place * 1000) / 1000, over: true });
          place += out;
        }
      } else {
        let slot = layout.main.filter(item => item.at + item.length / 2 < at).length;
        for (const picture of pictures) ops.push({ op: "add", clip: clipOf(picture, false), index: slot++ });
      }
    }
    if (ops.length === 0) return;
    const before = new Set(doc.main.map(item => ("id" in item ? item.id : "")));
    if (!(await edit(ops)) || !pictures.length) return;
    // Each video dropped into a VJ is looked for in its song and moved there when it is found for sure.
    const now = useLaneEditor.getState().projects.find(p => p.path === active.path);
    if (!now || songsOf(now.doc).length === 0) return;
    for (const item of now.doc.main) {
      if ("id" in item && !before.has(item.id)) void useLaneEditor.getState().calibrate(item.id, true);
    }
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

  /** ⌘Z / ⇧⌘Z undo and redo, M a marker, S a cut at the playhead, Delete what is chosen, Esc lets it go. */
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || (event.target as HTMLElement).closest("input, textarea, select, [role=slider]")) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "z") { event.preventDefault(); void (event.shiftKey ? redo() : undo()); return; }
    if (command && key === "y") { event.preventDefault(); void redo(); return; }
    if (command || event.altKey) return;
    const clip = doc.main.find((item): item is LaneClip => !isGap(item) && item.id === selected);
    const removal: LaneOp | null = clip ? { op: "remove", id: clip.id }
      : selected?.startsWith("title:") ? { op: "remove_title", id: selected.slice(6) }
        : selected?.startsWith("song:") ? { op: "remove_song", index: Number(selected.slice(5)) } : null;
    if (key === "m") { event.preventDefault(); mark(); }
    else if (key === "s" && clip && playhead.position !== null) { event.preventDefault(); send([{ op: "split", id: clip.id, at: playhead.position }]); }
    else if ((event.key === "Delete" || event.key === "Backspace") && removal) { event.preventDefault(); send([removal]); }
    else if (event.key === "Escape" && (selected || tool)) { event.preventDefault(); select(null); setTool(null); }
  };

  const status = busy ? <><LoaderCircle size={12} className="kd-spin" />保存中</>
    : error ? error
      : aligning ? <><LoaderCircle size={12} className="kd-spin" />正在校准</>
        : project.analysing ? <><LoaderCircle size={12} className="kd-spin" />正在分析小节线</> : null;

  return <div className="kd-lanes kd-scroll" data-drawer-scroll data-empty={open ? undefined : ""} onKeyDown={keys}>
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
      <button type="button" className="kd-lanes-key" disabled={zoom === 0} onClick={() => setZoom(z => Math.max(0, z - 1))} aria-label="缩小"><ZoomOut size={14} /></button>
      <button type="button" className="kd-lanes-key" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(z => Math.min(ZOOMS.length - 1, z + 1))} aria-label="放大"><ZoomIn size={14} /></button>
    </div>
    {status && <p className="kd-lanes-status" role={error ? "alert" : undefined} data-error={error ? "" : undefined} title={error ?? undefined}>{status}</p>}

    <LaneBoard project={project} zoom={zoom} selected={selected} select={id => { select(id); setTool(null); }} playhead={playhead.position}
      seek={seek} beatNear={beatNear} edit={send} onDropped={(ids, at) => void dropInto(ids, at)} />

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
