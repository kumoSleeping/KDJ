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
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { api } from "../../lib/api";
import { rulerStep } from "../../lib/aiTimeline";
import { isImageTrack, isProjectTrack } from "../../lib/format";
import { branchOps, fileLabel, isGap, LANE_END, laneClock, snapToBar, type BranchSide, type LaneClip, type LaneOp } from "../../lib/lanes";
import { activeTrackDragIds, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { usePointerSearchDrop, usePointerTrackDrop } from "../../lib/pointerTrackDrop";
import { activeSearchDrag, finishSearchDrop, isSearchDownloadDrag, readSearchDrop, type ActiveSearchDrag } from "../../lib/searchDrag";
import { useEditorDownloads } from "../../lib/editorDownloads";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { isSongTrack, songsOf, useLaneEditor, type LaneProject } from "../../stores/laneEditorStore";

/** How far the lanes can be drawn out: 1 is the whole project in view. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 64;
export const clampZoom = (zoom: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
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

/** What a drag holds: how many songs, videos and stills. */
interface Dragged { songs: number; videos: number; stills: number }

/** What a library drag holds, read while it is still over the editor. */
function draggedRows(ids: readonly number[]): Dragged {
  const byId = useLibraryStore.getState().summaryById;
  const rows = ids.map(id => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row) && !isProjectTrack(row!.format));
  const stills = rows.filter(row => isImageTrack(row.format)).length;
  const songs = rows.filter(row => isSongTrack(row)).length;
  return { songs, stills, videos: rows.length - songs - stills };
}

/** An online song or video: one song, or one video (its sound alone when asked for so). */
const draggedSearch = (payload: ActiveSearchDrag): Dragged =>
  payload.kind === "audio" || payload.request.audio_only ? { songs: 1, videos: 0, stills: 0 } : { songs: 0, videos: 1, stills: 0 };

/** Where a drop lands in one lane: the mark drawn there meanwhile and what it says. */
interface DropMark { lane: "song" | "main"; at: number; label: string }

/** Where a drop goes: `at` for the editor (seconds, or LANE_END), `sound` for videos taken for their sound alone. */
interface Landing { at: number; sound: boolean; marks: DropMark[]; label: string }

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
      const t = still ? 0 : Math.max(from, Math.min(clip.out - 0.1, Math.round((from + seconds * ((n + 0.5) * FRAME_W / width)) / step) * step));
      return <img key={n} src={api.kdjvFrameUrl(trackId, clip.src, t, FRAME_PX * 2)} alt="" draggable={false} loading="lazy"
        decoding="async" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />;
    })}
  </span>;
}

/** Where an online song or video dropped on the lanes will go once downloaded, and how far along it is. */
function PendingDownloads({ path, lane, span, end }: { path: string | null; lane: "song" | "main"; span: number; end: number }) {
  const all = useEditorDownloads(state => state.pending);
  const tasks = useDownloadStore(state => state.tasks);
  const pending = all.filter(item => item.path === path && item.lane === lane);
  return <>{pending.map(item => {
    const task = tasks.get(item.task);
    const progress = task ? Math.round(Math.min(1, Math.max(0, task.progress)) * 100) : 0;
    return <span key={item.task} className="kd-lanes-pending"
      style={{ left: pct(Math.min(item.at >= LANE_END ? end : item.at, span), span) }} title={`${item.title} · 下载好就放在这里`}>
      {item.title}{task?.state === "done" ? "" : ` · ${progress}%`}
    </span>;
  })}</>;
}

/** Where what is dragged would land in one lane: a dashed line there, and what goes in. */
function DropMarks({ marks, lane, span }: { marks: DropMark[] | null; lane: "song" | "main"; span: number }) {
  return <>{(marks ?? []).filter(mark => mark.lane === lane).map(mark => {
    // Near the right end the words stand to the left of the line.
    const left = Math.min(mark.at, span) / span > 0.7;
    return <span key={mark.lane} className="kd-lanes-drop" data-left={left || undefined} style={{ left: pct(Math.min(mark.at, span), span) }}>
      <span className="kd-lanes-drop-tag">{mark.label}</span>
    </span>;
  })}</>;
}

export function LaneBoard({ area, project, zoom, onZoom, selected, select, playhead, seek, beatNear, edit, onDropped, onSearchDropped }: {
  /** The whole editor: what is let go anywhere on it is taken (on a lane, there; elsewhere, each to its own lane's end). */
  area: RefObject<HTMLElement | null>;
  project: LaneProject; selected: string | null; select(id: string | null): void;
  /** How far the lanes are drawn out (1: the whole project in view); a pinch or ⌥/Ctrl + wheel asks for another. */
  zoom: number; onZoom(zoom: number): void;
  /** Where the project is playing, or null when it is not the one loaded. */
  playhead: number | null; seek(t: number): void;
  /** One beat's length near `t`: how long a branch is when only pulled up. */
  beatNear(t: number): number;
  edit(ops: LaneOp[]): void;
  /** Library rows let go at `at`; `sound`: on the sound lane, where a video gives only its sound. */
  onDropped(ids: readonly number[], at: number, sound: boolean): void;
  /** An online song or video let go at `at`: downloaded, then put there. */
  onSearchDropped(payload: ActiveSearchDrag, at: number, sound: boolean): void;
}) {
  const { doc, layout, grid } = project;
  const snapOn = useLaneEditor(state => state.snap);
  const range = useLaneEditor(state => state.ranges[project.path]);
  const board = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const aux = useRef<HTMLDivElement>(null);
  const mainLane = useRef<HTMLDivElement>(null);
  const soundLane = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  const [drop, setDrop] = useState<DropMark[] | null>(null);
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
      const step = rulerStep(bars.length / zoom);
      return bars.filter(bar => (bar.n - 1) % step === 0).map(bar => ({ at: bar.at, label: String(bar.n) }));
    }
    const step = secondStep(span / zoom);
    return Array.from({ length: Math.floor(span / step) + 1 }, (_, n) => ({ at: n * step, label: laneClock(n * step).replace(/\.0$/, "") }));
  }, [vj, downbeats, span, zoom]);
  const beatTicks = useMemo(() => {
    if (!vj || downbeats.length < 2 || downbeats.length / zoom > 24) return [];
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
  // ---- zoom: a pinch, ⌥ or Ctrl + wheel about the pointer; Shift + wheel along the lanes ----
  /** The second at the pointer, where it stood when the zoom began, until the new zoom is drawn. */
  const anchor = useRef<{ time: number; x: number } | null>(null);
  const shownZoom = useRef(zoom);
  const pendingZoom = useRef(zoom);
  const pinchFrom = useRef<{ zoom: number; clientX: number } | null>(null);
  const zoomAt = (next: number, clientX: number) => {
    const node = scroller.current;
    const bounded = clampZoom(next);
    if (!node || dragRef.current || !Number.isFinite(bounded) || bounded === pendingZoom.current) return;
    const x = Math.max(0, Math.min(node.clientWidth, clientX - node.getBoundingClientRect().left));
    anchor.current ??= { time: (node.scrollLeft + x) / (node.clientWidth * shownZoom.current) * span, x };
    pendingZoom.current = bounded;
    onZoom(bounded);
  };
  // A zoom from the keys keeps the playhead where it is on screen, else the middle of the view.
  useLayoutEffect(() => {
    const node = scroller.current;
    const before = shownZoom.current;
    shownZoom.current = pendingZoom.current = zoom;
    if (!node || before === zoom) return;
    const width = node.clientWidth;
    let at = anchor.current;
    anchor.current = null;
    if (!at) {
      const head = playhead !== null ? playhead / span * width * before - node.scrollLeft : -1;
      const x = head >= 0 && head <= width ? head : width / 2;
      at = { time: (node.scrollLeft + x) / (width * before) * span, x };
    }
    node.scrollLeft = Math.max(0, at.time / span * width * zoom - at.x);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const gesture = useRef({ zoomAt, width: () => scroller.current?.clientWidth ?? 0 });
  gesture.current = { zoomAt, width: () => scroller.current?.clientWidth ?? 0 };
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.altKey && !event.ctrlKey && !event.shiftKey) return;
      event.preventDefault();
      const page = node.clientWidth || 200;
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? page : 1;
      const dx = event.deltaX * unit, dy = event.deltaY * unit;
      // A touchpad pinch reaches WebView2 and Chromium as Ctrl + wheel.
      if (event.altKey || event.ctrlKey) {
        gesture.current.zoomAt(pendingZoom.current * Math.exp(-(dy || dx) * (event.ctrlKey ? 0.012 : 0.003)), event.clientX);
        return;
      }
      node.scrollLeft += dx || dy;
    };
    // WebKit (the Mac) reports a pinch as gesture events, with the scale since it began.
    const pinch = (event: Event) => {
      const e = event as Event & { scale: number; clientX?: number };
      e.preventDefault();
      if (e.type === "gesturestart") {
        const box = node.getBoundingClientRect();
        pinchFrom.current = { zoom: pendingZoom.current, clientX: e.clientX ?? box.left + box.width / 2 };
        return;
      }
      const from = pinchFrom.current;
      if (from && Number.isFinite(e.scale) && e.scale > 0) gesture.current.zoomAt(from.zoom * e.scale, from.clientX);
      if (e.type === "gestureend") pinchFrom.current = null;
    };
    node.addEventListener("wheel", wheel, { passive: false });
    for (const name of ["gesturestart", "gesturechange", "gestureend"]) node.addEventListener(name, pinch, { passive: false });
    return () => {
      node.removeEventListener("wheel", wheel);
      for (const name of ["gesturestart", "gesturechange", "gestureend"]) node.removeEventListener(name, pinch);
    };
  }, []);

  /** The beat nearest `t` in a VJ (when not let free, and N has not turned it off), else `t`. */
  const snap = (t: number, free: boolean) => {
    if (free || !snapOn || !vj || beats.length === 0) return Math.max(0, t);
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
  // Only the line follows the pointer; the player is sent there once, where it is let go: each
  // seek makes the engine start its decks anew, and a seek on every move choked the app.
  const scrubRef = useRef<{ pointer: number } | null>(null);
  const scrubDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, input, textarea, [role=slider]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubRef.current = { pointer: event.pointerId };
    setScrub(timeAt(event.clientX));
  };
  const scrubMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = scrubRef.current;
    if (!now || now.pointer !== event.pointerId) return;
    setScrub(timeAt(event.clientX));
  };
  const scrubUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = scrubRef.current;
    if (!now || now.pointer !== event.pointerId) return;
    scrubRef.current = null;
    setScrub(null);
    seek(timeAt(event.clientX));
  };

  /** The lane under (x, y): the picture (or the branch lane above it), the sound, or none. */
  const laneAt = (x: number, y: number): "song" | "main" | null => {
    const inside = (node: HTMLElement | null) => {
      const box = node?.getBoundingClientRect();
      return !!box && x >= box.left && x <= box.right && y >= box.top - 2 && y <= box.bottom + 2;
    };
    if (inside(soundLane.current)) return "song";
    if (inside(mainLane.current) || inside(aux.current)) return "main";
    return null;
  };
  const songsEnd = songs.length ? songs[songs.length - 1].at + songs[songs.length - 1].length : 0;

  /**
   * Where what is dragged lands when let go at (x, y). Songs and pictures each go to their own lane:
   * let go on a lane, at that time (a song between songs, in a VJ a picture at the bar); anywhere
   * else on the editor, after the last thing in their lane. Only videos alone, let go on the sound
   * lane on purpose, go there, for their sound; a song let go on the picture goes to the sound all
   * the same, and a still never to the sound.
   */
  const landing = (what: Dragged, x: number, y: number): Landing | null => {
    const pictures = what.videos + what.stills;
    if (what.songs + pictures === 0) return null;
    const lane = laneAt(x, y);
    const t = timeAt(x);
    const sound = lane === "song" && what.songs === 0 && what.videos > 0 && what.stills === 0;
    const at = lane === null ? LANE_END : t;
    const marks: DropMark[] = [];
    const songCount = what.songs + (sound ? what.videos : 0);
    if (songCount) {
      const index = songs.filter(s => s.at + s.length / 2 < at).length;
      const count = songCount > 1 ? ` ×${songCount}` : "";
      marks.push({ lane: "song", at: at >= LANE_END ? songsEnd : (songs[index]?.at ?? songsEnd), label: sound ? `只要声音${count}` : `音频${count}` });
    }
    if (pictures && !sound) {
      const placeAt = at >= LANE_END ? layout.main_end : vj ? snapToBar(downbeats, t) : t;
      const kind = what.stills === 0 ? "视频" : what.videos === 0 ? "图片" : "画面";
      marks.push({ lane: "main", at: placeAt, label: `${kind}${pictures > 1 ? ` ×${pictures}` : ""}` });
    }
    const label = songCount && pictures && !sound ? "音频放声音，画面放画面"
      : sound ? "只要声音"
        : lane === null ? (songCount ? "接在声音最后" : "接在画面最后")
          : songCount ? "放进声音" : "放进画面";
    return { at, sound, marks, label };
  };
  const dropRows = (ids: readonly number[], x: number, y: number) => {
    setDrop(null);
    const where = landing(draggedRows(ids), x, y);
    // Projects alone open as pages of their own (the editor does that with whatever is dropped).
    if (ids.length) onDropped(ids, where?.at ?? LANE_END, where?.sound ?? false);
  };
  const overRows = (ids: readonly number[], x: number, y: number) => {
    // Projects open as pages of their own; they do not go into this one.
    if (onlyProjects(ids)) { setDrop(null); return "打开工程"; }
    const where = landing(draggedRows(ids), x, y);
    setDrop(where?.marks ?? null);
    return where?.label ?? null;
  };
  const dropSearch = (payload: ActiveSearchDrag, x: number, y: number) => {
    setDrop(null);
    const where = landing(draggedSearch(payload), x, y);
    if (where) onSearchDropped(payload, where.at, where.sound || draggedSearch(payload).songs > 0);
  };
  const overSearch = (payload: ActiveSearchDrag, x: number, y: number) => {
    const where = landing(draggedSearch(payload), x, y);
    setDrop(where?.marks ?? null);
    return where ? `下载后${where.label}` : null;
  };
  usePointerTrackDrop(area, { over: overRows, leave: () => setDrop(null), drop: dropRows });
  usePointerSearchDrop(area, { over: overSearch, leave: () => setDrop(null), drop: dropSearch });

  // What the system carries (the harmonic list, a search result) is taken by the whole editor too.
  const native = useRef({ overRows, dropRows, overSearch, dropSearch });
  native.current = { overRows, dropRows, overSearch, dropSearch };
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    const over = (event: DragEvent) => {
      if (isTrackDrag(event)) {
        event.preventDefault();
        native.current.overRows(activeTrackDragIds(), event.clientX, event.clientY);
        return;
      }
      if (!isSearchDownloadDrag(event)) return;
      event.preventDefault();
      const payload = activeSearchDrag();
      if (payload) native.current.overSearch(payload, event.clientX, event.clientY);
    };
    const leave = (event: DragEvent) => { if (!node.contains(event.relatedTarget as Node | null)) setDrop(null); };
    const dropped = (event: DragEvent) => {
      if (isTrackDrag(event)) {
        event.preventDefault();
        const ids = event.dataTransfer ? readTrackDragIds(event.dataTransfer) : [];
        native.current.dropRows(ids.length ? ids : activeTrackDragIds(), event.clientX, event.clientY);
        return;
      }
      if (!isSearchDownloadDrag(event)) return;
      event.preventDefault();
      const payload = event.dataTransfer ? readSearchDrop(event.dataTransfer) : null;
      finishSearchDrop();
      if (payload) native.current.dropSearch(payload, event.clientX, event.clientY);
      else setDrop(null);
    };
    node.addEventListener("dragover", over);
    node.addEventListener("dragleave", leave);
    node.addEventListener("drop", dropped);
    return () => {
      node.removeEventListener("dragover", over);
      node.removeEventListener("dragleave", leave);
      node.removeEventListener("drop", dropped);
    };
  }, [area]);

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

  return <div className="kd-lanes-frame">
   {/* The lanes' names, level with them: the picture, its branches above it, the sound below. */}
   <div className="kd-lanes-names" aria-hidden="true">
    <span className="kd-lanes-name" data-lane="ruler" />
    {titles.length > 0 && <span className="kd-lanes-name" data-lane="title">字幕</span>}
    <span className="kd-lanes-name" data-lane="aux">辅线</span>
    <span className="kd-lanes-name" data-lane="main">画面</span>
    <span className="kd-lanes-name" data-lane="song">声音</span>
   </div>
   <div ref={scroller} className="kd-lanes-scroll">
    <div ref={board} className="kd-lanes-board" style={{ width: `${zoom * 100}%` }}
      onPointerDown={scrubDown} onPointerMove={scrubMove} onPointerUp={scrubUp}
      onPointerCancel={() => { scrubRef.current = null; setScrub(null); }}>
      <div className="kd-lanes-ruler">
        {range && (range.in !== undefined || range.out !== undefined) && <span className="kd-lanes-range"
          style={{ left: pct(range.in ?? 0, span), width: pct((range.out ?? span) - (range.in ?? 0), span) }}
          title={`入点 ${laneClock(range.in ?? 0)} · 出点 ${laneClock(range.out ?? span)}`} />}
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
      <div ref={mainLane} className="kd-lanes-lane" data-lane="main" aria-label="画面" data-drop={drop?.some(mark => mark.lane === "main") || undefined}>
        {layout.main.map(item => {
          // Where there is no picture the lane stays empty.
          if (item.gap) return null;
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
        <PendingDownloads path={project.path || null} lane="main" span={span} end={layout.main_end} />
        <DropMarks marks={drop} lane="main" span={span} />
      </div>
      <div ref={soundLane} className="kd-lanes-lane" data-lane="song" aria-label="声音" data-drop={drop?.some(mark => mark.lane === "song") || undefined}>
        {songs.map(song => {
          const id = `song:${song.index}`;
          const at = shown("song", String(song.index), song.at, song.length);
          return <button key={`${song.index}:${song.src}`} type="button" className="kd-lanes-song" aria-pressed={id === selected}
            style={{ left: pct(at.at, span), width: pct(at.length, span) }}
            title={`${fileLabel(song.src)} · ${laneClock(song.at)}–${laneClock(song.at + song.length)}`} {...grip("song", String(song.index), id)}>
            {fileLabel(song.src)}
          </button>;
        })}
        <PendingDownloads path={project.path || null} lane="song" span={span} end={songsEnd} />
        <DropMarks marks={drop} lane="song" span={span} />
      </div>
      {head !== null && <span className="kd-lanes-playhead" style={{ left: pct(head, span) }} />}
    </div>
   </div>
  </div>;
}
