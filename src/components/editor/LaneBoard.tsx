/**
 * The lanes of a project in the editor (LaneEditor.tsx): the ruler with its markers, the titles
 * (when there are any), the branches, the picture and the songs, under one clock. Everything on
 * them is handled directly: a press chooses it (and puts the playhead there), a drag moves it, a
 * drag at either end pulls that end; in a VJ what is dragged lands on the song's beats unless Alt
 * is held. A clip pulled up into the branch lane branches there: let go past its end, its tail
 * carries on over the next clip (`out`); before its start, it comes in early over the one before
 * (`in`). A branch is pulled longer or shorter by its far end and dragged back down to go away.
 * A press anywhere else puts the playhead there, and dragging moves it along. The picture lane
 * shows each clip's frames. Library rows dropped here go where they belong (LaneEditor's
 * `onDropped`), whether the system carried them (the harmonic list) or the track table followed
 * the pointer by hand (lib/pointerTrackDrop.ts).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../../lib/api";
import { rulerStep } from "../../lib/aiTimeline";
import { isImageTrack, isProjectTrack } from "../../lib/format";
import { branchOps, fileLabel, isGap, laneClock, snapToBar, type BranchSide, type LaneClip, type LaneOp } from "../../lib/lanes";
import { activeTrackDragIds, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { usePointerSearchDrop, usePointerTrackDrop } from "../../lib/pointerTrackDrop";
import { activeSearchDrag, finishSearchDrop, isSearchDownloadDrag, readSearchDrop, type ActiveSearchDrag } from "../../lib/searchDrag";
import { useEditorDownloads } from "../../lib/editorDownloads";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { isSongTrack, songsOf, type LaneProject } from "../../stores/laneEditorStore";

export const ZOOMS = [1, 2, 4, 8, 16];
const pct = (t: number, span: number) => `${Math.max(0, Math.min(100, (t / span) * 100))}%`;
const round = (v: number) => Math.round(v * 1000) / 1000;
/** How near an end a press has to be to pull that end, in pixels. */
const EDGE_PX = 7;
/** How far a press has to travel before it is a drag. */
const DRAG_PX = 3;
/** The picture lane's frames: drawn this high (twice for sharp screens), 16:9 wide. */
const FRAME_PX = 40;
const FRAME_W = Math.round(FRAME_PX * 16 / 9);
/** The shortest branch a pull makes. */
const MIN_BRANCH = 0.1;
/** How often the playhead follows a drag along the lanes, in milliseconds. */
const SCRUB_MS = 80;

type Lane = "main" | "song" | "title" | "branch";
type Grip = "move" | "in" | "out";
interface Drag {
  lane: Lane; key: string; grip: Grip; x0: number; dt: number; moved: boolean; free: boolean;
  /** A clip held over the branch lane, or a branch held off it: where it would branch, if anywhere. */
  up: boolean; t: number;
}

/** Every how many seconds the ruler names one, so that about a dozen names fit at this zoom. */
function secondStep(span: number): number {
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120]) if (span / step <= 12) return step;
  return 300;
}

/** A round number of seconds near `seconds`, so that frames are asked for at the same times at every zoom. */
function frameStep(seconds: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60]) if (seconds <= step) return step;
  return 120;
}

/** Whether a library drag holds nothing but projects. */
function onlyProjects(ids: readonly number[]): boolean {
  const byId = useLibraryStore.getState().summaryById;
  return ids.length > 0 && ids.every(id => isProjectTrack(byId.get(id)?.format ?? ""));
}

/** What a library drag holds, read while it is still over the lanes: songs, or pictures. */
function draggedKind(ids: readonly number[]): "song" | "picture" | null {
  const byId = useLibraryStore.getState().summaryById;
  const rows = ids.map(id => byId.get(id)).filter(Boolean);
  if (rows.length === 0) return null;
  return rows.some(row => isSongTrack(row!)) ? "song" : "picture";
}

/** A clip's frames along it, one every frame's width, each at the moment of its source it starts on. */
function ClipFrames({ trackId, clip, width }: { trackId: number; clip: LaneClip; width: number }) {
  if (width < FRAME_W / 3) return null;
  const extension = clip.src.split(".").pop() ?? "";
  const still = isImageTrack(extension);
  const count = Math.max(1, Math.ceil(width / FRAME_W));
  const from = clip.in ?? 0;
  const seconds = Math.max(0, clip.out - from);
  const step = frameStep(seconds * FRAME_W / width);
  return <span className="kd-lanes-frames" aria-hidden="true">
    {Array.from({ length: Math.min(count, 400) }, (_, n) => {
      const t = still ? 0 : Math.max(from, Math.min(clip.out - 0.1, Math.round((from + seconds * (n * FRAME_W / width)) / step) * step));
      return <img key={n} src={api.kdjvFrameUrl(trackId, clip.src, t, FRAME_PX * 2)} alt="" draggable={false} loading="lazy"
        decoding="async" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />;
    })}
  </span>;
}

/** Where an online song or video dropped on the lanes will go once downloaded, and how far along it is. */
function PendingDownloads({ path, lane, span }: { path: string | null; lane: "song" | "main"; span: number }) {
  const all = useEditorDownloads(state => state.pending);
  const tasks = useDownloadStore(state => state.tasks);
  const pending = all.filter(item => item.path === path && item.lane === lane);
  return <>{pending.map(item => {
    const task = tasks.get(item.task);
    const progress = task ? Math.round(Math.min(1, Math.max(0, task.progress)) * 100) : 0;
    return <span key={item.task} className="kd-lanes-pending"
      style={{ left: pct(Math.min(item.at, span), span) }} title={`${item.title} · 下载好就放在这里`}>
      {item.title}{task?.state === "done" ? "" : ` · ${progress}%`}
    </span>;
  })}</>;
}

export function LaneBoard({ project, zoom, selected, select, playhead, seek, beatNear, edit, onDropped, onSearchDropped }: {
  project: LaneProject; zoom: number; selected: string | null; select(id: string | null): void;
  /** Where the project is playing, or null when it is not the one loaded. */
  playhead: number | null; seek(t: number): void;
  /** One beat's length near `t`: how long a branch is when only pulled up. */
  beatNear(t: number): number;
  edit(ops: LaneOp[]): void;
  onDropped(ids: readonly number[], at: number): void;
  /** An online song or video let go at `at`: downloaded, then put there. */
  onSearchDropped(payload: ActiveSearchDrag, at: number): void;
}) {
  const { doc, layout, grid } = project;
  const board = useRef<HTMLDivElement>(null);
  const aux = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  const [drop, setDrop] = useState<{ lane: "song" | "main"; at: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const span = Math.max(1, layout.duration);
  const vj = songsOf(doc).length > 0;
  const downbeats = useMemo(() => grid?.downbeats ?? [], [grid]);
  const beats = useMemo(() => grid?.beats ?? [], [grid]);
  const songs = layout.songs ?? [];
  const titles = doc.titles ?? [];
  const markers = doc.markers ?? [];

  useEffect(() => {
    const node = board.current;
    if (!node) return;
    const measure = () => setBoardWidth(node.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);

  const ruler = useMemo(() => {
    if (vj && downbeats.length > 1) {
      const bars = downbeats.map((at, n) => ({ n: n + 1, at })).filter(bar => bar.at >= 0 && bar.at <= span);
      const step = rulerStep(bars.length / ZOOMS[zoom]);
      return bars.filter(bar => (bar.n - 1) % step === 0).map(bar => ({ at: bar.at, label: String(bar.n) }));
    }
    const step = secondStep(span / ZOOMS[zoom]);
    return Array.from({ length: Math.floor(span / step) + 1 }, (_, n) => ({ at: n * step, label: laneClock(n * step).replace(/\.0$/, "") }));
  }, [vj, downbeats, span, zoom]);
  const beatTicks = useMemo(() => {
    if (!vj || downbeats.length < 2 || downbeats.length / ZOOMS[zoom] > 24) return [];
    return beats.filter(at => at >= 0 && at <= span);
  }, [vj, downbeats, beats, span, zoom]);

  const width = () => board.current?.getBoundingClientRect().width || 1;
  const timeAt = (clientX: number) => {
    const node = board.current;
    if (!node) return 0;
    const box = node.getBoundingClientRect();
    return Math.max(0, Math.min(span, ((clientX - box.left) / box.width) * span));
  };
  /** Whether a point is up in the branch lane (or above it). */
  const overAux = (clientY: number) => {
    const box = aux.current?.getBoundingClientRect();
    return box ? clientY <= box.bottom + 2 : false;
  };
  /** The beat nearest `t` in a VJ (when not let free), else `t`. */
  const snap = (t: number, free: boolean) => {
    if (free || !vj || beats.length === 0) return Math.max(0, t);
    return beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0]);
  };

  // ---- what is dragged, and where it is drawn meanwhile ----
  const clipOf = (id: string) => doc.main.find((item): item is LaneClip => !isGap(item) && item.id === id);
  const placedClip = (id: string) => layout.main.find(item => item.id === id);
  const placedOf = (lane: Lane, key: string) => {
    if (lane === "main") { const m = placedClip(key); return m && { at: m.at, length: m.length }; }
    if (lane === "song") { const s = songs[Number(key)]; return s && { at: s.at, length: s.length }; }
    if (lane === "branch") { const b = layout.branches.find(x => `${x.clip}:${x.side}` === key); return b && { at: b.at, length: b.length }; }
    const t = titles.find(title => title.id === key);
    return t && { at: t.at, length: t.length };
  };
  /** Where an item stands after `drag` so far: its start and length. */
  const shownBy = (drag: Drag | null, lane: Lane, key: string, at: number, length: number) => {
    if (!drag || !drag.moved || drag.lane !== lane || drag.key !== key || (lane === "main" && drag.up)) return { at, length };
    if (drag.grip === "move") {
      const start = lane === "song" ? at + drag.dt : snap(at + drag.dt, drag.free);
      return { at: start, length };
    }
    if (drag.grip === "in") {
      const start = Math.min(at + length - 0.1, snap(at + drag.dt, drag.free));
      return { at: start, length: at + length - start };
    }
    const end = Math.max(at + 0.1, snap(at + length + drag.dt, drag.free));
    return { at, length: end - at };
  };
  /** Where an item stands while it is dragged. */
  const shown = (lane: Lane, key: string, at: number, length: number) => shownBy(drag, lane, key, at, length);
  /** The branch a clip held up over the branch lane at `t` would make. */
  const branchFrom = (id: string, t: number, free: boolean): { side: BranchSide; at: number; length: number } | null => {
    const placed = placedClip(id);
    if (!placed) return null;
    const end = placed.at + placed.length;
    const at = snap(t, free);
    if (t >= placed.at + placed.length / 2) {
      const length = round(Math.max(MIN_BRANCH, at - end > MIN_BRANCH / 2 ? at - end : beatNear(end)));
      return { side: "out", at: end, length };
    }
    const length = round(Math.max(MIN_BRANCH, placed.at - at > MIN_BRANCH / 2 ? placed.at - at : beatNear(placed.at)));
    return { side: "in", at: placed.at - length, length };
  };

  const press = (lane: Lane, key: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const grip: Grip = lane === "song" ? "move"
      : lane === "branch" ? "out"
        : event.clientX - box.left <= EDGE_PX && box.width > EDGE_PX * 3 ? "in"
          : box.right - event.clientX <= EDGE_PX && box.width > EDGE_PX * 3 ? "out" : "move";
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: Drag = { lane, key, grip, x0: event.clientX, dt: 0, moved: false, free: event.altKey, up: lane === "branch", t: timeAt(event.clientX) };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const now = dragRef.current;
    if (!now) return;
    const dx = event.clientX - now.x0;
    const up = now.lane === "main" ? overAux(event.clientY) : now.lane === "branch" ? overAux(event.clientY) : false;
    const next = { ...now, dt: dx / width() * span, moved: now.moved || Math.abs(dx) > DRAG_PX || up !== now.up, free: event.altKey, up, t: timeAt(event.clientX) };
    dragRef.current = next;
    setDrag(next);
  };
  const release = (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
    const done = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!done) return;
    if (!done.moved) {
      // A press chooses it and puts the playhead where it was pressed.
      select(selected === id ? null : id);
      seek(timeAt(event.clientX));
      return;
    }
    const ops = commit(done);
    if (ops.length) edit(ops);
  };

  /** The operations that make a drag stick. */
  const commit = (done: Drag): LaneOp[] => {
    if (done.lane === "branch") {
      const [clip, side] = done.key.split(":") as [string, BranchSide];
      const branch = doc.branches?.find(b => b.clip === clip && b.side === side);
      if (!done.up || !branch) return [{ op: "unbranch", clip, side }];
      const placed = placedClip(clip);
      if (!placed) return [];
      const at = snap(done.t, done.free);
      const length = round(Math.max(MIN_BRANCH, side === "out" ? at - (placed.at + placed.length) : placed.at - at));
      const owner = clipOf(clip);
      return Math.abs(length - branch.length) < 0.01 || !owner ? []
        : branchOps(owner, side, length, vj, placed.at, project.lengths[owner.src], { opacity: branch.opacity, fade: branch.fade });
    }
    if (done.lane === "main" && done.up) {
      const made = branchFrom(done.key, done.t, done.free);
      const owner = clipOf(done.key);
      const placed = placedClip(done.key);
      if (!made || !owner || !placed) return [];
      const kept = doc.branches?.find(b => b.clip === done.key && b.side === made.side);
      return branchOps(owner, made.side, made.length, vj, placed.at, project.lengths[owner.src], { opacity: kept?.opacity, fade: kept?.fade });
    }
    const before = placedOf(done.lane, done.key);
    if (!before) return [];
    const after = shownBy(done, done.lane, done.key, before.at, before.length);
    if (done.lane === "title") {
      return [{ op: "set_title", id: done.key, fields: { at: round(after.at), length: round(after.length) } }];
    }
    if (done.lane === "song") {
      const from = Number(done.key);
      const middle = after.at + after.length / 2;
      const to = songs.filter(s => s.index !== from && s.at + s.length / 2 < middle).length;
      return to === from ? [] : [{ op: "move_song", from, to }];
    }
    const clip = clipOf(done.key);
    if (!clip) return [];
    const speed = clip.speed ?? 1;
    if (done.grip === "move") {
      // In a VJ it goes where it is let go, over whatever is there.
      if (vj) return [{ op: "move_to", id: clip.id, at: round(after.at), over: true }];
      const middle = after.at + after.length / 2;
      const index = layout.main.filter(item => item.id !== clip.id && item.at + item.length / 2 < middle).length;
      const now = layout.main.findIndex(item => item.id === clip.id);
      return index === now ? [] : [{ op: "move", id: clip.id, index }];
    }
    if (done.grip === "out") {
      return [{ op: "trim", id: clip.id, out: round((clip.out ?? 0) + (after.length - before.length) * speed) }];
    }
    // The start pulled: the source starts later (or earlier) by as much; in a VJ the end stays put.
    const shift = after.at - before.at;
    const trim: LaneOp = { op: "trim", id: clip.id, in: round(Math.max(0, (clip.in ?? 0) + shift * speed)) };
    if (!vj) return [trim];
    // Pulled earlier it goes over the end of what was before it.
    const place: LaneOp = { op: "move_to", id: clip.id, at: round(after.at), over: true };
    return shift > 0 ? [trim, place] : [place, trim];
  };

  const grip = (lane: Lane, key: string, id: string) => ({
    onPointerDown: press(lane, key), onPointerMove: move, onPointerUp: release(id),
    onPointerCancel: () => { dragRef.current = null; setDrag(null); },
    // The keyboard (and assistive technology) chooses with a click that no pointer pressed.
    onClick: (event: { detail: number }) => { if (event.detail === 0) select(selected === id ? null : id); },
    "data-dragging": drag?.moved && drag.lane === lane && drag.key === key ? "" : undefined,
  });

  // ---- a press anywhere else: the playhead goes there and follows the pointer ----
  const scrubRef = useRef<{ pointer: number; last: number } | null>(null);
  const scrubDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, input, textarea, [role=slider]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const t = timeAt(event.clientX);
    scrubRef.current = { pointer: event.pointerId, last: performance.now() };
    setScrub(t);
    // A project not loaded yet is loaded once, where the pointer is let go.
    if (playhead !== null) seek(t);
  };
  const scrubMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = scrubRef.current;
    if (!now || now.pointer !== event.pointerId) return;
    const t = timeAt(event.clientX);
    setScrub(t);
    if (playhead !== null && performance.now() - now.last >= SCRUB_MS) { now.last = performance.now(); seek(t); }
  };
  const scrubUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = scrubRef.current;
    if (!now || now.pointer !== event.pointerId) return;
    scrubRef.current = null;
    setScrub(null);
    seek(timeAt(event.clientX));
  };

  /** Where what is let go at `x` lands: songs at a slot of the song lane, pictures at a time. */
  const landing = (ids: readonly number[], x: number, kind = draggedKind(ids)): { lane: "song" | "main"; at: number } => {
    const t = timeAt(x);
    if (kind === "song") {
      const index = songs.filter(s => s.at + s.length / 2 < t).length;
      const end = songs.length ? songs[songs.length - 1].at + songs[songs.length - 1].length : 0;
      return { lane: "song", at: songs[index]?.at ?? end };
    }
    return { lane: "main", at: vj ? snapToBar(downbeats, t) : t };
  };
  const hoverRows = (ids: readonly number[], x: number) => setDrop(onlyProjects(ids) ? null : landing(ids, x));
  const dropRows = (ids: readonly number[], x: number) => {
    setDrop(null);
    if (ids.length) onDropped(ids, landing(ids, x).at);
  };
  usePointerTrackDrop(board, {
    over: (ids, x) => {
      // Projects open as pages of their own; they do not go into this one.
      if (onlyProjects(ids)) { setDrop(null); return "打开工程"; }
      hoverRows(ids, x);
      return null;
    },
    leave: () => setDrop(null),
    drop: (ids, x) => dropRows(ids, x),
  });
  // Online songs and videos: a song goes to the song lane, a video (its sound alone: a song) to the picture.
  const searchKind = (payload: ActiveSearchDrag) => (payload.kind === "audio" || payload.request.audio_only ? "song" : "picture");
  const dropSearch = (payload: ActiveSearchDrag, x: number) => {
    setDrop(null);
    const kind = searchKind(payload);
    onSearchDropped(payload, landing([], x, kind).at);
  };
  usePointerSearchDrop(board, {
    over: (payload, x) => { setDrop(landing([], x, searchKind(payload))); return "下载后放在这里"; },
    leave: () => setDrop(null),
    drop: (payload, x) => dropSearch(payload, x),
  });

  // The branch a drag is making or changing, drawn in the branch lane meanwhile.
  const pending = (() => {
    if (!drag?.moved || !drag.up) return null;
    if (drag.lane === "main") {
      const made = branchFrom(drag.key, drag.t, drag.free);
      return made && { key: `${drag.key}:${made.side}`, ...made };
    }
    if (drag.lane !== "branch") return null;
    const [clip, side] = drag.key.split(":") as [string, BranchSide];
    const placed = placedClip(clip);
    if (!placed) return null;
    const at = snap(drag.t, drag.free);
    const length = Math.max(MIN_BRANCH, side === "out" ? at - (placed.at + placed.length) : placed.at - at);
    return { key: drag.key, side, at: side === "out" ? placed.at + placed.length : placed.at - length, length };
  })();
  const branchBlocks = [
    ...layout.branches.filter(b => `${b.clip}:${b.side}` !== pending?.key && !(drag?.moved && drag.lane === "branch" && drag.key === `${b.clip}:${b.side}`)),
    ...(pending ? [{ clip: pending.key.split(":")[0], side: pending.side, at: pending.at, length: pending.length, pending: true }] : []),
  ];
  const pixels = (seconds: number) => (boardWidth / span) * seconds;
  const head = scrub ?? playhead;

  return <div className="kd-lanes-scroll">
    <div ref={board} className="kd-lanes-board" style={{ width: `${ZOOMS[zoom] * 100}%` }}
      onPointerDown={scrubDown} onPointerMove={scrubMove} onPointerUp={scrubUp}
      onPointerCancel={() => { scrubRef.current = null; setScrub(null); }}
      onDragOver={event => {
        if (isTrackDrag(event)) {
          event.preventDefault();
          event.stopPropagation();
          hoverRows(activeTrackDragIds(), event.clientX);
          return;
        }
        if (!isSearchDownloadDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const payload = activeSearchDrag();
        setDrop(landing([], event.clientX, payload ? searchKind(payload) : "picture"));
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
      onDrop={event => {
        if (isTrackDrag(event)) {
          event.preventDefault();
          event.stopPropagation();
          const ids = readTrackDragIds(event.dataTransfer);
          dropRows(ids.length ? ids : activeTrackDragIds(), event.clientX);
          return;
        }
        if (!isSearchDownloadDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const payload = readSearchDrop(event.dataTransfer);
        finishSearchDrop();
        if (payload) dropSearch(payload, event.clientX);
        else setDrop(null);
      }}>
      <div className="kd-lanes-ruler">
        {beatTicks.map(at => <span key={`b${at}`} className="kd-lanes-beat" style={{ left: pct(at, span) }} />)}
        {ruler.map(mark => <span key={mark.at} className="kd-lanes-mark" style={{ left: pct(mark.at, span) }}>{mark.label}</span>)}
        {markers.map((marker, n) => <button key={`${n}:${marker.at}`} type="button" className="kd-lanes-marker"
          style={{ left: pct(marker.at, span) }} aria-label={`标记 ${n + 1}${marker.name ? ` ${marker.name}` : ""} · ${laneClock(marker.at)}`}
          title={`${marker.name ?? `标记 ${n + 1}`} · ${laneClock(marker.at)} · 双击去掉`}
          onClick={() => seek(marker.at)}
          onDoubleClick={() => edit([{ op: "markers", markers: markers.filter((_, k) => k !== n) }])} />)}
      </div>
      {titles.length > 0 && <div className="kd-lanes-lane" data-lane="title" aria-label="字幕">
        {titles.map(title => {
          const id = `title:${title.id}`;
          const at = shown("title", title.id, title.at, title.length);
          return <button key={title.id} type="button" className="kd-lanes-title-block" aria-pressed={id === selected}
            style={{ left: pct(at.at, span), width: pct(at.length, span) }}
            title={`${title.text} · ${laneClock(at.at)}–${laneClock(at.at + at.length)}`} {...grip("title", title.id, id)}>
            {title.text}
          </button>;
        })}
      </div>}
      <div ref={aux} className="kd-lanes-lane" data-lane="aux" aria-label="辅线" data-drop={drag?.moved && drag.lane === "main" && drag.up || undefined}>
        {branchBlocks.map(b => {
          const key = `${b.clip}:${b.side}`;
          const pendingBlock = "pending" in b;
          return <button key={key} type="button" className="kd-lanes-branch-block"
            data-side={b.side} data-pending={pendingBlock || undefined} aria-pressed={b.clip === selected}
            style={{ left: pct(b.at, span), width: pct(b.length, span) }}
            title={`${b.side === "out" ? "出分叉" : "入分叉"} · ${round(b.length)} 秒 · 拉它的头改长短，拖下去去掉`}
            {...(pendingBlock ? {} : grip("branch", key, b.clip))} />;
        })}
      </div>
      <svg className="kd-lanes-switches" data-titles={titles.length > 0 || undefined} viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
        {branchBlocks.map(b => {
          // The points: from the clip on the picture up onto the branch, like railway points.
          const edge = (b.side === "out" ? b.at : b.at + b.length) / span * 1000;
          const far = (b.side === "out" ? b.at + Math.min(b.length, span / 50) : b.at + b.length - Math.min(b.length, span / 50)) / span * 1000;
          return <path key={`${b.clip}:${b.side}`} d={`M ${edge} 40 L ${far} 0`} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <div className="kd-lanes-lane" data-lane="main" aria-label="画面" data-drop={drop?.lane === "main" || undefined}>
        {layout.main.map(item => {
          if (item.gap) {
            return <span key={`gap-${item.index}`} className="kd-lanes-gap" style={{ left: pct(item.at, span), width: pct(item.length, span) }}
              title={`黑 · ${laneClock(item.at)}–${laneClock(item.at + item.length)}`} />;
          }
          const id = item.id ?? "";
          const at = shown("main", id, item.at, item.length);
          const clip = clipOf(id);
          return <button key={id} type="button" className="kd-lanes-clip" aria-pressed={id === selected}
            data-up={drag?.moved && drag.lane === "main" && drag.key === id && drag.up || undefined}
            style={{ left: pct(at.at, span), width: pct(at.length, span) }}
            title={`${fileLabel(item.src ?? "")} · ${laneClock(at.at)}–${laneClock(at.at + at.length)} · 往上拉进辅线做分叉`} {...grip("main", id, id)}>
            {clip && project.trackId !== null && <ClipFrames trackId={project.trackId} clip={clip} width={pixels(at.length)} />}
            <span className="kd-lanes-clip-name">{fileLabel(item.src ?? "")}</span>
          </button>;
        })}
        <PendingDownloads path={project.path || null} lane="main" span={span} />
      </div>
      <div className="kd-lanes-lane" data-lane="song" aria-label="歌" data-drop={drop?.lane === "song" || undefined}>
        {songs.map(song => {
          const id = `song:${song.index}`;
          const at = shown("song", String(song.index), song.at, song.length);
          return <button key={`${song.index}:${song.src}`} type="button" className="kd-lanes-song" aria-pressed={id === selected}
            style={{ left: pct(at.at, span), width: pct(at.length, span) }}
            title={`${fileLabel(song.src)} · ${laneClock(song.at)}–${laneClock(song.at + song.length)}`} {...grip("song", String(song.index), id)}>
            {fileLabel(song.src)}
          </button>;
        })}
        <PendingDownloads path={project.path || null} lane="song" span={span} />
      </div>
      {head !== null && <span className="kd-lanes-playhead" style={{ left: pct(head, span) }} />}
      {drop && <span className="kd-lanes-drop" data-lane={drop.lane} style={{ left: pct(drop.at, span) }} />}
    </div>
  </div>;
}
