/**
 * The tracks of a project in the editor (LaneEditor.tsx): the ruler with its markers and the in
 * and out points, the titles (when there are any), then every track in its order — picture tracks
 * (the upper covers the lower) and sound tracks — under one clock. A track's name stands at its
 * left with its keys: hidden or muted, fold it with the one below, take it out; the + keys under
 * them add a track. Tracks folded together are one row that shows what is seen (an upper clip
 * covers a lower one; nothing in them changes) until the fold is opened to adjust them.
 *
 * Everything on the tracks is handled directly: a press chooses a clip (the playhead stays where
 * it is), a drag moves it, a drag at either end pulls that end, the dots at its top corners pull
 * its fades. What is dragged lines up: its start or end, near another clip's or title's start or end
 * on any track, a marker, the playhead or the in and out points, lands on it (always, a line shows
 * where); else, in a project with songs, on their beats unless N turned that off. Alt lets it free. A clip dragged up or down out of its own track goes into the track it is held
 * over, if that is a track of its kind; past the edge of a track (or over a track of the other
 * kind) it makes a new track there. A picture never goes into a sound track, nor sound into a
 * picture track. A press anywhere else puts the playhead there, and dragging moves it along.
 * A track's name held and dragged up or down moves the track among those of its kind.
 * Library rows and search results dropped on the editor go where they belong (`landing`): on a
 * track into it, at a track's edge or between two tracks into a new track made there.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Eye, EyeOff, Volume2, VolumeX, X, Plus, ChevronDown, ChevronRight, Combine, Ungroup } from "lucide-react";
import { api } from "../../lib/api";
import { isImageTrack, isProjectTrack } from "../../lib/format";
import { fileLabel, LANE_END, laneClock, rulerStep, snapToBar, trackName, type LaneClip, type LaneOp, type LaneTrack, type TrackKind } from "../../lib/lanes";
import { activeTrackDragIds, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { usePointerSearchDrop, usePointerTrackDrop } from "../../lib/pointerTrackDrop";
import { activeSearchDrag, finishSearchDrop, isSearchDownloadDrag, readSearchDrop, type ActiveSearchDrag } from "../../lib/searchDrag";
import { useEditorDownloads } from "../../lib/editorDownloads";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { isSongTrack, songsOf, tempoMarks, useLaneEditor, type LaneProject, type Placement } from "../../stores/laneEditorStore";

/** How far the tracks can be drawn out: 1 is the whole project in view. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 64;
export const clampZoom = (zoom: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
const pct = (t: number, span: number) => `${Math.max(0, Math.min(100, (t / span) * 100))}%`;
const round = (v: number) => Math.round(v * 1000) / 1000;
/** How near an end a press has to be to pull that end, in pixels. */
const EDGE_PX = 7;
/** How far a press has to travel before it is a drag. */
const DRAG_PX = 3;
/** How near a track's edge (or past it) a clip held makes a new track there, in pixels. */
const NEW_TRACK_PX = 7;
/** How near a row's top or bottom edge (or between two rows) a drop from the library makes a new track there, in pixels. */
const NEW_TRACK_DROP_PX = 10;
/** The room between two rows (`.kd-lanes-board` gap), and how far under the last row a drop still makes a track below it. */
const ROW_GAP_PX = 4;
const BELOW_LAST_PX = 16;
/** A dragged clip's or title's start or end this close to another edge, in pixels, lands on it. */
const SNAP_PX = 8;
/** What is dragged lands on a beat only this near one, in seconds: no songs there, no beats to land on. */
const BEAT_REACH_SEC = 0.75;
/** The picture tracks' frames: drawn this high (twice for sharp screens), 16:9 wide. */
const FRAME_PX = 40;
const FRAME_W = Math.round(FRAME_PX * 16 / 9);

type Grip = "move" | "in" | "out" | "fade_in" | "fade_out";
/** Where a clip held would go: a track, or a new track made at an index of the track list. */
type Destination = { track: string } | { newTrack: number };
interface Drag {
  kind: "clip" | "title"; key: string; grip: Grip; x0: number; dt: number; moved: boolean; free: boolean;
  /** Where the pointer is now, for the clip's destination and the fade it pulls; where it was pressed. */
  x: number; y: number; y0: number;
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

/** Where a drop lands in one track (a fold's row shows it too): the mark drawn there meanwhile and what it says. */
interface DropMark { track: string; at: number; label: string }

/** A line between rows where a new track would be made (`index` in the track list), with what it says, at `at`. */
interface TrackLine { index: number; label: string; at: number }

/** Where a drop goes, for the editor (`Placement`), with its marks and the words on the drag's card. */
interface Landing { place: Placement; marks: DropMark[]; label: string; line?: TrackLine }

/** One row of the board: a track, or tracks folded together (top first). */
interface Row { key: string; kind: TrackKind; tracks: LaneTrack[]; fold: string | null; opened: boolean }

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

/** Where an online song or video dropped on the tracks will go once downloaded, and how far along it is. */
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

/** Where what is dragged would land in one row: a dashed line there, and what goes in. */
function DropMarks({ marks, tracks, span }: { marks: DropMark[] | null; tracks: LaneTrack[]; span: number }) {
  return <>{(marks ?? []).filter(mark => tracks.some(track => track.id === mark.track)).map(mark => {
    // Near the right end the words stand to the left of the line.
    const left = Math.min(mark.at, span) / span > 0.7;
    return <span key={mark.track} className="kd-lanes-drop" data-left={left || undefined} style={{ left: pct(Math.min(mark.at, span), span) }}>
      <span className="kd-lanes-drop-tag">{mark.label}</span>
    </span>;
  })}</>;
}

/**
 * The fade's curve over a clip: the opacity it has at each moment (kdjvLive.ts `clipAlpha`, a
 * smoothstep), drawn as a line, with what has faded away shaded above it.
 */
const FADE_STEPS = 24;
const FADE_PATH = Array.from({ length: FADE_STEPS + 1 }, (_, n) => {
  const x = n / FADE_STEPS;
  return `${(x * 100).toFixed(2)},${(100 - x * x * (3 - 2 * x) * 100).toFixed(2)}`;
}).join(" ");
function FadeCurve({ side, width }: { side: "in" | "out"; width: string }) {
  return <svg className="kd-lanes-fade" data-side={side} style={{ width }} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <polygon className="kd-lanes-fade-away" points={`0,0 ${FADE_PATH}`} />
    <polyline className="kd-lanes-fade-line" points={FADE_PATH} />
  </svg>;
}

export function LaneBoard({ area, project, zoom, onZoom, selected, select, playhead, seek, edit, onDropped, onSearchDropped }: {
  /** The whole editor: what is let go anywhere on it is taken (on a track, there; elsewhere, each to the end of its kind of track). */
  area: RefObject<HTMLElement | null>;
  project: LaneProject; selected: string | null; select(id: string | null): void;
  /** How far the tracks are drawn out (1: the whole project in view); a pinch or ⌥/Ctrl + wheel asks for another. */
  zoom: number; onZoom(zoom: number): void;
  /** Where the project is playing, or null when it is not the one loaded. */
  playhead: number | null; seek(t: number): void;
  edit(ops: LaneOp[]): void;
  /** Library rows let go: where they go (laneEditorStore `placeTracks`). */
  onDropped(ids: readonly number[], place: Placement): void;
  /** An online song or video let go: downloaded, then put there. */
  onSearchDropped(payload: ActiveSearchDrag, place: Placement): void;
}) {
  const { doc, layout, grid } = project;
  const snapOn = useLaneEditor(state => state.snap);
  const range = useLaneEditor(state => state.ranges[project.path]);
  const board = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Each row's element, by its key, for where a pointer is. */
  const rowNodes = useRef(new Map<string, HTMLDivElement>());
  const [boardWidth, setBoardWidth] = useState(0);
  const [drop, setDrop] = useState<DropMark[] | null>(null);
  /** The new track a drop would make, drawn as a line between the rows. */
  const [dropLine, setDropLine] = useState<TrackLine | null>(null);
  /** A track's name held to move it: the row and where it would go. */
  const [reorder, setReorder] = useState<{ row: string; pointer: number; y0: number; moved: boolean; to: number | null } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  /** Folds opened for a moment, to adjust what is in them (the fold stays). */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const span = Math.max(1, layout.duration);
  const vj = songsOf(doc).length > 0;
  const downbeats = useMemo(() => grid?.downbeats ?? [], [grid]);
  const beats = useMemo(() => grid?.beats ?? [], [grid]);
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

  /** The rows: each track, or the tracks of a fold as one row while it is not opened. */
  const rows = useMemo(() => {
    const out: Row[] = [];
    const folds = doc.folds ?? [];
    for (const track of doc.tracks) {
      const fold = folds.find(f => f.tracks.includes(track.id)) ?? null;
      if (fold && !opened.has(fold.id)) {
        const row = out.find(r => r.fold === fold.id);
        if (row) { row.tracks.push(track); continue; }
        out.push({ key: `fold:${fold.id}`, kind: track.kind, tracks: [track], fold: fold.id, opened: false });
        continue;
      }
      out.push({ key: track.id, kind: track.kind, tracks: [track], fold: fold?.id ?? null, opened: Boolean(fold) });
    }
    return out;
  }, [doc.tracks, doc.folds, opened]);

  const ruler = useMemo(() => {
    if (vj && downbeats.length > 1) {
      const bars = downbeats.map((at, n) => ({ n: n + 1, at })).filter(bar => bar.at >= 0 && bar.at <= span);
      const step = rulerStep(bars.length / zoom);
      return bars.filter(bar => (bar.n - 1) % step === 0).map(bar => ({ at: bar.at, label: String(bar.n) }));
    }
    const step = secondStep(span / zoom);
    return Array.from({ length: Math.floor(span / step) + 1 }, (_, n) => ({ at: n * step, label: laneClock(n * step).replace(/\.0$/, "") }));
  }, [vj, downbeats, span, zoom]);
  const tempo = useMemo(() => tempoMarks(grid).filter(mark => mark.at <= span), [grid, span]);
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

  // ---- zoom: a pinch, ⌥ or Ctrl + wheel about the pointer; Shift + wheel along the tracks ----
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
    const view = node.clientWidth;
    let at = anchor.current;
    anchor.current = null;
    if (!at) {
      const head = playhead !== null ? playhead / span * view * before - node.scrollLeft : -1;
      const x = head >= 0 && head <= view ? head : view / 2;
      at = { time: (node.scrollLeft + x) / (view * before) * span, x };
    }
    node.scrollLeft = Math.max(0, at.time / span * view * zoom - at.x);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const gesture = useRef({ zoomAt });
  gesture.current = { zoomAt };
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

  /**
   * The beat nearest `t` in a project with songs (when not let free, and N has not turned it off),
   * else `t`. A song moved lines up with the other songs only: its own beats move with it, and
   * snapping to them held it where it was. A song's end pulled lands on its own beats, also on the
   * part trimmed off, so a trim can be undone by pulling it out again.
   */
  const snap = (t: number, free: boolean, kind: Drag["kind"] = "clip", key = "", grip: Grip = "move") => {
    if (free || !snapOn || !vj) return Math.max(0, t);
    const songs = grid?.songs ?? [];
    const song = kind === "clip" ? songs.find(s => s.clip === key) : undefined;
    const pool = !song ? beats : songs.flatMap(s => s === song
      ? (grip === "move" ? [] : s.beats)
      : s.beats.filter(b => b >= s.from - 1e-3 && b < s.to - 1e-3));
    if (pool.length === 0) return Math.max(0, t);
    const best = pool.reduce((near, b) => (Math.abs(b - t) < Math.abs(near - t) ? b : near), pool[0]);
    // Far from every beat (before the songs, after them, between two): where it was let go.
    return Math.abs(best - t) <= BEAT_REACH_SEC ? best : Math.max(0, t);
  };

  // ---- where the pointer is among the rows ----
  const trackIndex = (id: string) => doc.tracks.findIndex(track => track.id === id);
  /** The row level with a point (its name beside it counts too), or null. */
  const rowAt = (_x: number, y: number): { row: Row; box: DOMRect } | null => {
    for (const row of rows) {
      const box = rowNodes.current.get(row.key)?.getBoundingClientRect();
      if (box && y >= box.top && y <= box.bottom) return { row, box };
    }
    return null;
  };
  /**
   * Where the clip `id` held at (x, y) would go. In its own row it stays in its track. Over a row of
   * its kind it goes into that row's track (a fold's top track). Near a row's top or bottom edge,
   * between rows, over a row of the other kind or past every row, it makes a new track there: over
   * or under the row held at, or above or below its own track when that row is of the other kind.
   */
  const destination = (id: string, x: number, y: number): Destination | null => {
    const own = doc.tracks.find(track => track.clips.some(clip => clip.id === id));
    if (!own) return null;
    const ownRow = rows.find(row => row.tracks.includes(own));
    const ownBox = ownRow ? rowNodes.current.get(ownRow.key)?.getBoundingClientRect() : undefined;
    if (ownBox && y >= ownBox.top && y <= ownBox.bottom) return { track: own.id };
    const below = ownBox ? y > ownBox.bottom : false;
    const beside = { newTrack: trackIndex(own.id) + (below ? 1 : 0) };
    const hit = rowAt(x, y);
    if (!hit) {
      // Past every row: a new track above the first, or below the last, row of its kind's side.
      const first = rows[0] ? rowNodes.current.get(rows[0].key)?.getBoundingClientRect() : undefined;
      if (first && y < first.top) return { newTrack: own.kind === "picture" ? 0 : beside.newTrack };
      const last = rows.at(-1);
      const lastBox = last ? rowNodes.current.get(last.key)?.getBoundingClientRect() : undefined;
      if (lastBox && y > lastBox.bottom && own.kind === "sound") return { newTrack: doc.tracks.length };
      return beside;
    }
    if (hit.row.kind !== own.kind) return beside;
    const top = trackIndex(hit.row.tracks[0].id), bottom = trackIndex(hit.row.tracks.at(-1)!.id);
    if (y - hit.box.top <= NEW_TRACK_PX) return { newTrack: top };
    if (hit.box.bottom - y <= NEW_TRACK_PX) return { newTrack: bottom + 1 };
    return { track: hit.row.tracks[0].id };
  };

  // ---- what is dragged, and where it is drawn meanwhile ----
  const clipById = (id: string) => {
    for (const track of doc.tracks) {
      const clip = track.clips.find(c => c.id === id);
      if (clip) return { clip, track };
    }
    return null;
  };
  const lengthOf = (clip: LaneClip) => (clip.out - (clip.in ?? 0)) / (clip.speed ?? 1);
  /**
   * The edge within SNAP_PX of one of `points` that a dragged clip or title meets: another clip's
   * or title's start or end on any track, a marker, the playhead, the in and out points, 0. Always
   * on (Alt lets it free); `by` is the shift that lands on it.
   */
  const meet = (points: number[], kind: Drag["kind"], key: string, free: boolean): { by: number; at: number } | null => {
    if (free) return null;
    const edges = [0, ...markers.map(m => m.at)];
    for (const track of doc.tracks) for (const c of track.clips) {
      if (kind !== "clip" || c.id !== key) edges.push(c.at, c.at + lengthOf(c));
    }
    for (const t of titles) if (kind !== "title" || t.id !== key) edges.push(t.at, t.at + t.length);
    if (playhead !== null) edges.push(playhead);
    if (range?.in !== undefined) edges.push(range.in);
    if (range?.out !== undefined) edges.push(range.out);
    const reach = SNAP_PX / width() * span;
    let best: { by: number; at: number } | null = null;
    for (const edge of edges) for (const point of points) {
      const by = edge - point;
      if (Math.abs(by) <= reach && (!best || Math.abs(by) < Math.abs(best.by))) best = { by, at: edge };
    }
    return best;
  };
  /**
   * Where a clip or title stands after `drag` so far: its start and length, and the edge it is
   * aligned to, if any. An edge in reach comes first, else the beat.
   */
  const shownBy = (now: Drag | null, kind: Drag["kind"], key: string, at: number, length: number): { at: number; length: number; edge?: number } => {
    if (!now || !now.moved || now.kind !== kind || now.key !== key || now.grip === "fade_in" || now.grip === "fade_out") return { at, length };
    if (now.grip === "move") {
      // Held straight up or down it keeps its time; moved along, its start or its end meets an edge, else the beat.
      if (Math.abs(now.x - now.x0) <= DRAG_PX) return { at, length };
      const moved = at + now.dt, edge = meet([moved, moved + length], kind, key, now.free);
      return edge ? { at: Math.max(0, moved + edge.by), length, edge: edge.at } : { at: snap(moved, now.free, kind, key, now.grip), length };
    }
    if (now.grip === "in") {
      const pulled = at + now.dt, edge = meet([pulled], kind, key, now.free);
      const start = Math.min(at + length - 0.1, edge ? edge.at : snap(pulled, now.free, kind, key, now.grip));
      return { at: start, length: at + length - start, ...(edge ? { edge: edge.at } : {}) };
    }
    const pulled = at + length + now.dt, edge = meet([pulled], kind, key, now.free);
    const end = Math.max(at + 0.1, edge ? edge.at : snap(pulled, now.free, kind, key, now.grip));
    return { at, length: end - at, ...(edge ? { edge: edge.at } : {}) };
  };
  /** The fade a corner dot pulled so far, in seconds of the project. */
  const fadeBy = (now: Drag, clip: LaneClip) => {
    const length = lengthOf(clip);
    const t = timeAt(now.x);
    const fade = now.grip === "fade_in" ? t - clip.at : clip.at + length - t;
    return round(Math.max(0, Math.min(length, fade)));
  };

  const press = (kind: Drag["kind"], key: string, grip?: Grip) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const chosen: Grip = grip ?? (event.clientX - box.left <= EDGE_PX && box.width > EDGE_PX * 3 ? "in"
      : box.right - event.clientX <= EDGE_PX && box.width > EDGE_PX * 3 ? "out" : "move");
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: Drag = { kind, key, grip: chosen, x0: event.clientX, dt: 0, moved: false, free: event.altKey, x: event.clientX, y: event.clientY, y0: event.clientY };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const now = dragRef.current;
    if (!now) return;
    const dx = event.clientX - now.x0;
    const dy = event.clientY - now.y0;
    const next = { ...now, dt: dx / width() * span, moved: now.moved || Math.abs(dx) > DRAG_PX || Math.abs(dy) > DRAG_PX * 4,
      free: event.altKey, x: event.clientX, y: event.clientY };
    dragRef.current = next;
    setDrag(next);
  };
  const release = (id: string) => () => {
    const done = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!done) return;
    if (!done.moved) {
      // A press only chooses it (pressed again it stays chosen; Esc lets it go): the playhead stays where it plays.
      select(id);
      return;
    }
    const ops = commit(done);
    if (ops.length) edit(ops);
  };

  /** The operations that make a drag stick. */
  const commit = (done: Drag): LaneOp[] => {
    if (done.kind === "title") {
      const title = titles.find(t => t.id === done.key);
      if (!title) return [];
      const after = shownBy(done, "title", done.key, title.at, title.length);
      return [{ op: "set_title", id: done.key, fields: { at: round(after.at), length: round(after.length) } }];
    }
    const found = clipById(done.key);
    if (!found) return [];
    const { clip, track } = found;
    const length = lengthOf(clip);
    if (done.grip === "fade_in" || done.grip === "fade_out") {
      const fade = fadeBy(done, clip);
      return Math.abs(fade - (clip[done.grip] ?? 0)) < 0.01 ? [] : [{ op: "set", id: clip.id, fields: { [done.grip]: fade } }];
    }
    const after = shownBy(done, "clip", done.key, clip.at, length);
    const speed = clip.speed ?? 1;
    if (done.grip === "move") {
      const to = destination(clip.id, done.x, done.y) ?? { track: track.id };
      const at = round(Math.max(0, after.at));
      if ("track" in to) {
        if (to.track === track.id && Math.abs(at - clip.at) < 0.001) return [];
        return [{ op: "move", id: clip.id, at, ...(to.track === track.id ? {} : { track: to.track }) }];
      }
      return [{ op: "move", id: clip.id, at, new_track: to.newTrack }];
    }
    if (done.grip === "out") {
      return [{ op: "trim", id: clip.id, out: round(clip.out + (after.length - length) * speed) }];
    }
    // The start pulled: the source starts later (or earlier) by as much; the end stays put.
    return [{ op: "trim", id: clip.id, in: round(Math.max(0, (clip.in ?? 0) + (after.at - clip.at) * speed)) }];
  };

  const grip = (kind: Drag["kind"], key: string, id: string, chosen?: Grip) => ({
    onPointerDown: press(kind, key, chosen), onPointerMove: move, onPointerUp: release(id),
    onPointerCancel: () => { dragRef.current = null; setDrag(null); },
    // A key (Enter on a focused clip) chooses it too.
    onClick: (event: { detail: number }) => { if (event.detail === 0) select(id); },
  });
  /** The edge what is dragged is aligned to, drawn across the tracks while it is. */
  const guide = (() => {
    if (!drag?.moved) return undefined;
    if (drag.kind === "title") {
      const title = titles.find(t => t.id === drag.key);
      return title ? shownBy(drag, "title", drag.key, title.at, title.length).edge : undefined;
    }
    const found = clipById(drag.key);
    return found ? shownBy(drag, "clip", drag.key, found.clip.at, lengthOf(found.clip)).edge : undefined;
  })();
  /** The clip being moved, where it would go (for the ghost drawn there). */
  const held = drag?.moved && drag.kind === "clip" && drag.grip === "move" ? clipById(drag.key) : null;
  const heldTo = held && drag ? destination(held.clip.id, drag.x, drag.y) : null;

  // ---- the playhead: a press anywhere else puts it there, a drag moves it along ----
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

  // ---- drops from the library and from search ----
  const firstOf = (kind: TrackKind) => doc.tracks.find(track => track.kind === kind) ?? null;
  const endOf = (track: LaneTrack | null) => track ? track.clips.reduce((end, c) => Math.max(end, c.at + lengthOf(c)), 0) : 0;
  /** Whether place `g` of the track list lies inside a fold (between two of its tracks): no track goes in there. */
  const insideFold = (g: number) => g > 0 && (doc.folds ?? []).some(f => f.tracks.includes(doc.tracks[g - 1]?.id) && f.tracks.includes(doc.tracks[g]?.id));
  /**
   * Where between the rows a drop at `y` makes a new track: near a row's top or bottom edge, in the
   * room between two rows, or just under the last one. The index it would have in the track list,
   * and the kinds of the rows beside it (a new track takes a kind of its neighbours).
   */
  const newTrackAt = (y: number): { index: number; kinds: TrackKind[] } | null => {
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n];
      const box = rowNodes.current.get(row.key)?.getBoundingClientRect();
      if (!box) continue;
      const edge = Math.min(NEW_TRACK_DROP_PX, box.height / 4);
      const before = rows[n - 1], after = rows[n + 1];
      const top = trackIndex(row.tracks[0].id), bottom = trackIndex(row.tracks.at(-1)!.id) + 1;
      if (y >= box.top - ROW_GAP_PX && y < box.top + edge && !insideFold(top)) {
        return { index: top, kinds: [...new Set([row.kind, ...(before ? [before.kind] : [])])] };
      }
      if (y > box.bottom - edge && y <= box.bottom + (after ? ROW_GAP_PX : BELOW_LAST_PX) && !insideFold(bottom)) {
        return { index: bottom, kinds: [...new Set([row.kind, ...(after ? [after.kind] : [])])] };
      }
    }
    return null;
  };
  /**
   * Where what is dragged lands when let go at (x, y). Songs and pictures each go to a track of
   * their own kind: let go on a track, at that time (in a project with songs a picture at the
   * bar), over what is there; let go at a track's top or bottom edge or between two tracks, into a
   * new track made there (`fresh`; search results, placed only once downloaded, do not); anywhere
   * else on the editor, after the last clip of the first track of their kind (one is made when
   * there is none). Only videos alone, let go on a sound track (or a new one among sound tracks)
   * on purpose, go there, for their sound; a song let go on a picture track goes to a sound track
   * all the same, and a still never to sound.
   */
  const landing = (what: Dragged, x: number, y: number, fresh = true): Landing | null => {
    const pictures = what.videos + what.stills;
    if (what.songs + pictures === 0) return null;
    const made = fresh ? newTrackAt(y) : null;
    const hit = made ? null : rowAt(x, y);
    const on = hit ? hit.row.tracks[0] : null;
    const t = timeAt(x);
    const onlyVideos = what.songs === 0 && what.videos > 0 && what.stills === 0;
    const sound = onlyVideos && (on?.kind === "sound" || Boolean(made?.kinds.includes("sound") && !made.kinds.includes("picture")));
    const at = on || made ? t : LANE_END;
    const songCount = what.songs + (sound ? what.videos : 0);
    const newSong = made?.kinds.includes("sound") && songCount ? made.index : undefined;
    const newPicture = made?.kinds.includes("picture") && pictures && !sound ? made.index : undefined;
    const songTrack = on?.kind === "sound" ? on : firstOf("sound");
    const pictureTrack = on?.kind === "picture" ? on : firstOf("picture");
    const marks: DropMark[] = [];
    const count = (n: number) => (n > 1 ? ` ×${n}` : "");
    const songWord = sound ? `只要声音${count(songCount)}` : `音频${count(songCount)}`;
    const pictureWord = `${what.stills === 0 ? "视频" : what.videos === 0 ? "图片" : "画面"}${count(pictures)}`;
    const pictureAt = at >= LANE_END ? endOf(pictureTrack) : vj ? snapToBar(downbeats, t) : t;
    if (songCount && songTrack && newSong === undefined) {
      marks.push({ track: songTrack.id, at: at >= LANE_END ? endOf(songTrack) : t, label: songWord });
    }
    if (pictures && !sound && pictureTrack && newPicture === undefined) {
      marks.push({ track: pictureTrack.id, at: pictureAt, label: pictureWord });
    }
    const madeWords = [newPicture !== undefined ? pictureWord : "", newSong !== undefined ? songWord : ""].filter(Boolean);
    const line = made && madeWords.length ? { index: made.index, at: newPicture !== undefined ? pictureAt : t, label: `${madeWords.join("、")} · 新轨道` } : undefined;
    const label = line ? (marks.length ? `${line.label}，其余放进原来的轨道` : `放进新轨道`)
      : songCount && pictures && !sound ? "音频放声音轨，画面放画面轨"
        : sound ? "只要声音"
          : !on ? (songCount ? "接在声音轨最后" : "接在画面轨最后")
            : songCount ? "放进声音轨" : "放进画面轨";
    return {
      place: { at, sound, picture: pictureTrack?.id, song: songTrack?.id, newPicture, newSong },
      marks, label, line,
    };
  };
  const dropRows = (ids: readonly number[], x: number, y: number) => {
    setDrop(null);
    setDropLine(null);
    const where = landing(draggedRows(ids), x, y);
    // Projects alone open as pages of their own (the editor does that with whatever is dropped).
    if (ids.length) onDropped(ids, where?.place ?? { at: LANE_END });
  };
  const overRows = (ids: readonly number[], x: number, y: number) => {
    // Projects open as pages of their own; they do not go into this one.
    if (onlyProjects(ids)) { setDrop(null); setDropLine(null); return "打开工程"; }
    const where = landing(draggedRows(ids), x, y);
    setDrop(where?.marks ?? null);
    setDropLine(where?.line ?? null);
    return where?.label ?? null;
  };
  const dropSearch = (payload: ActiveSearchDrag, x: number, y: number) => {
    setDrop(null);
    const what = draggedSearch(payload);
    const where = landing(what, x, y, false);
    if (where) onSearchDropped(payload, { ...where.place, sound: where.place.sound || what.songs > 0 });
  };
  const overSearch = (payload: ActiveSearchDrag, x: number, y: number) => {
    const where = landing(draggedSearch(payload), x, y, false);
    setDrop(where?.marks ?? null);
    return where ? `下载后${where.label}` : null;
  };
  const leaveDrop = () => { setDrop(null); setDropLine(null); };
  usePointerTrackDrop(area, { over: overRows, leave: leaveDrop, drop: dropRows });
  usePointerSearchDrop(area, { over: overSearch, leave: leaveDrop, drop: dropSearch });

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
    const leave = (event: DragEvent) => { if (!node.contains(event.relatedTarget as Node | null)) { setDrop(null); setDropLine(null); } };
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
      else { setDrop(null); setDropLine(null); }
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

  // ---- the tracks' own keys ----
  /** Folds `row`'s tracks with the row below it (into one fold with whatever either was folded with). */
  const foldDown = (index: number) => {
    const row = rows[index], next = rows[index + 1];
    if (!row || !next || next.kind !== row.kind) return;
    const ids = [...row.tracks, ...next.tracks].map(track => track.id);
    const folds = doc.folds ?? [];
    const members = new Set(ids);
    for (const fold of folds) if (fold.tracks.some(id => members.has(id))) fold.tracks.forEach(id => members.add(id));
    edit([{ op: "fold", tracks: doc.tracks.filter(track => members.has(track.id)).map(track => track.id) }]);
  };
  const toggleOpened = (fold: string) => setOpened(now => {
    const next = new Set(now);
    if (next.has(fold)) next.delete(fold); else next.add(fold);
    return next;
  });

  const pixels = (seconds: number) => (boardWidth / span) * seconds;
  const head = scrub ?? playhead;
  const pictureEnd = endOf(firstOf("picture")), soundEnd = endOf(firstOf("sound"));

  /** One clip on its row. In a fold's row the upper track's clips are drawn over the lower's. */
  const clipBlock = (clip: LaneClip, track: LaneTrack, depth: number) => {
    const length = lengthOf(clip);
    const at = shownBy(drag, "clip", clip.id, clip.at, length);
    const fading = drag?.moved && drag.kind === "clip" && drag.key === clip.id && (drag.grip === "fade_in" || drag.grip === "fade_out") ? drag : null;
    const fadeIn = fading?.grip === "fade_in" ? fadeBy(fading, clip) : clip.fade_in ?? 0;
    const fadeOut = fading?.grip === "fade_out" ? fadeBy(fading, clip) : clip.fade_out ?? 0;
    const away = held?.clip.id === clip.id && heldTo !== null && !("track" in heldTo && heldTo.track === track.id);
    const picture = track.kind === "picture";
    return <button key={clip.id} type="button" className="kd-lanes-clip" data-kind={track.kind} aria-pressed={clip.id === selected}
      data-away={away || undefined} data-hidden={track.hidden || undefined}
      style={{ left: pct(at.at, span), width: pct(at.length, span), zIndex: 10 - depth }}
      title={`${trackName(doc, track)} · ${fileLabel(clip.src)} · ${laneClock(at.at)}–${laneClock(at.at + at.length)}`} {...grip("clip", clip.id, clip.id)}>
      {picture && project.trackId !== null && <ClipFrames trackId={project.trackId} clip={clip} width={pixels(at.length)} />}
      {fadeIn > 0 && <FadeCurve side="in" width={pct(fadeIn, at.length)} />}
      {fadeOut > 0 && <FadeCurve side="out" width={pct(fadeOut, at.length)} />}
      <span className="kd-lanes-clip-name">{fileLabel(clip.src)}</span>
      <span className="kd-lanes-fade-dot" data-side="in" style={{ left: pct(fadeIn, at.length) }} title={`淡入 ${fadeIn.toFixed(2)} 秒`}
        {...grip("clip", clip.id, clip.id, "fade_in")} />
      <span className="kd-lanes-fade-dot" data-side="out" style={{ right: pct(fadeOut, at.length) }} title={`淡出 ${fadeOut.toFixed(2)} 秒`}
        {...grip("clip", clip.id, clip.id, "fade_out")} />
    </button>;
  };

  /** The clip held, drawn where it would land: in another row, or on the line of a new track. */
  const ghost = (row: Row) => {
    if (!held || !heldTo || !drag) return null;
    const into = "track" in heldTo ? row.tracks.some(track => track.id === heldTo.track) && heldTo.track !== held.track.id : false;
    if (!into) return null;
    const length = lengthOf(held.clip);
    const at = shownBy(drag, "clip", held.clip.id, held.clip.at, length);
    return <span className="kd-lanes-ghost" style={{ left: pct(at.at, span), width: pct(at.length, span) }} aria-hidden="true">{fileLabel(held.clip.src)}</span>;
  };
  /**
   * The line between rows above track `index` (or under the last, at the track count): where a
   * clip held or a drop would make a new track, or where a track whose name is held would go.
   */
  const newTrackLine = (index: number) => {
    if (heldTo && !("track" in heldTo) && heldTo.newTrack === index) return <div className="kd-lanes-new-track" aria-hidden="true"><span>新轨道</span></div>;
    if (dropLine?.index === index) {
      // The words stand at the time it goes in; near the right end, to the left of it.
      const far = Math.min(dropLine.at, span) / span > 0.7;
      return <div className="kd-lanes-new-track" aria-hidden="true">
        <span style={far ? { left: "auto", right: pct(span - Math.min(dropLine.at, span), span) } : { left: pct(dropLine.at, span) }}>{dropLine.label}</span>
      </div>;
    }
    if (reorder?.moved && reorder.to === index) return <div className="kd-lanes-new-track" aria-hidden="true" />;
    return null;
  };

  // ---- a track's name held and dragged up or down: the track (with its fold) to another place ----
  /** The tracks a row moves as one: its own, or every track of its fold, in their order. */
  const blockOf = (row: Row) => {
    const fold = row.fold ? (doc.folds ?? []).find(f => f.id === row.fold) : undefined;
    const ids = fold ? fold.tracks : row.tracks.map(track => track.id);
    return doc.tracks.filter(track => ids.includes(track.id)).map(track => track.id);
  };
  /**
   * Where `row` held at `y` would go: the place in the track list it is put before, the gap nearest
   * the pointer among the rows of its kind. Never inside another fold; null where it already is.
   */
  const reorderTo = (row: Row, y: number): number | null => {
    const block = blockOf(row);
    const from = trackIndex(block[0]), to = from + block.length;
    let best: number | null = null, distance = Infinity;
    for (const other of rows.filter(r => r.kind === row.kind)) {
      const box = rowNodes.current.get(other.key)?.getBoundingClientRect();
      if (!box) continue;
      for (const [edge, g] of [[box.top, trackIndex(other.tracks[0].id)], [box.bottom, trackIndex(other.tracks.at(-1)!.id) + 1]]) {
        if (insideFold(g) || Math.abs(y - edge) >= distance) continue;
        distance = Math.abs(y - edge);
        best = g;
      }
    }
    return best === null || (best >= from && best <= to) ? null : best;
  };
  /** The move_track operations that put `row`'s tracks before track place `g`. */
  const reorderOps = (row: Row, g: number): LaneOp[] => {
    const block = blockOf(row);
    const ids = doc.tracks.map(track => track.id);
    const rest = ids.filter(id => !block.includes(id));
    const at = g - ids.slice(0, g).filter(id => block.includes(id)).length;
    const wanted = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    const now = [...ids], ops: LaneOp[] = [];
    wanted.forEach((id, n) => {
      if (now[n] === id) return;
      now.splice(now.indexOf(id), 1);
      now.splice(n, 0, id);
      ops.push({ op: "move_track", id, index: n });
    });
    return ops;
  };
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;
  const nameGrip = (row: Row) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setReorder({ row: row.key, pointer: event.pointerId, y0: event.clientY, moved: false, to: null });
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const now = reorderRef.current;
      if (!now || now.pointer !== event.pointerId) return;
      const moved = now.moved || Math.abs(event.clientY - now.y0) > DRAG_PX;
      setReorder({ ...now, moved, to: moved ? reorderTo(row, event.clientY) : null });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const now = reorderRef.current;
      if (!now || now.pointer !== event.pointerId) return;
      setReorder(null);
      if (now.moved && now.to !== null) {
        const ops = reorderOps(row, now.to);
        if (ops.length) edit(ops);
      }
    },
    onPointerCancel: () => setReorder(null),
  });
  const rowLines = rows.map(row => trackIndex(row.tracks[0].id));

  return <div className="kd-lanes-frame">
   {/* The tracks' names and keys, level with their rows. */}
   <div className="kd-lanes-names">
    {vj && tempo.length > 0 && <span className="kd-lanes-name" data-lane="tempo" />}
    <span className="kd-lanes-name" data-lane="ruler" />
    {titles.length > 0 && <span className="kd-lanes-name" data-lane="title">字幕</span>}
    {rows.map((row, n) => {
      const track = row.tracks[0];
      const folded = row.fold !== null && !row.opened;
      const next = rows[n + 1];
      return <div key={row.key} className="kd-lanes-name" data-lane={row.kind} data-folded={row.fold ? "" : undefined}
        data-moving={reorder?.moved && reorder.row === row.key ? "" : undefined} {...nameGrip(row)}>
        {row.fold && <button type="button" className="kd-lanes-name-key" onClick={() => toggleOpened(row.fold!)}
          aria-label={folded ? "展开合并的轨道" : "收起"} title={folded ? "展开来调整（合并不变）" : "收起"}>
          {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>}
        <span className="kd-lanes-name-text" title="上下拖动换位置">{folded ? row.tracks.map(t => trackName(doc, t)).join(" + ") : trackName(doc, track)}</span>
        {!folded && track.kind === "picture" && <button type="button" className="kd-lanes-name-key" aria-pressed={!track.hidden}
          onClick={() => edit([{ op: "set_track", id: track.id, fields: { hidden: !track.hidden } }])}
          aria-label={track.hidden ? "显示这条轨道" : "隐藏这条轨道"}>{track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>}
        {!folded && <button type="button" className="kd-lanes-name-key" aria-pressed={!track.muted}
          onClick={() => edit([{ op: "set_track", id: track.id, fields: { muted: !track.muted } }])}
          aria-label={track.muted ? "打开这条轨道的声音" : "这条轨道静音"}>{track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>}
        {next && next.kind === row.kind && (!row.fold || row.fold !== next.fold) && <button type="button" className="kd-lanes-name-key"
          onClick={() => foldDown(n)} aria-label="和下面一条合并" title="和下面一条合并（被盖住的都留着，随时展开）"><Combine size={12} /></button>}
        {row.fold && <button type="button" className="kd-lanes-name-key" onClick={() => edit([{ op: "unfold", id: row.fold! }])}
          aria-label="拆开合并" title="拆开合并"><Ungroup size={12} /></button>}
        {!folded && <button type="button" className="kd-lanes-name-key" onClick={() => edit([{ op: "remove_track", id: track.id }])}
          aria-label="删掉这条轨道" title={track.clips.length ? "删掉这条轨道和上面的片段（可撤销）" : "删掉这条轨道"}><X size={12} /></button>}
      </div>;
    })}
    <div className="kd-lanes-add">
      <button type="button" className="kd-lanes-name-key" onClick={() => edit([{ op: "add_track", kind: "picture" }])} aria-label="加一条画面轨"><Plus size={12} />画面</button>
      <button type="button" className="kd-lanes-name-key" onClick={() => edit([{ op: "add_track", kind: "sound" }])} aria-label="加一条声音轨"><Plus size={12} />声音</button>
    </div>
   </div>
   <div ref={scroller} className="kd-lanes-scroll">
    <div ref={board} className="kd-lanes-board" style={{ width: `${zoom * 100}%` }}
      onPointerDown={scrubDown} onPointerMove={scrubMove} onPointerUp={scrubUp}
      onPointerCancel={() => { scrubRef.current = null; setScrub(null); }}>
      {vj && tempo.length > 0 && <div className="kd-lanes-tempo-row" aria-label="速度">
        {tempo.map(mark => <span key={mark.at} className="kd-lanes-tempo" style={{ left: pct(mark.at, span) }}
          title={`${laneClock(mark.at)} 起 ${mark.bpm} BPM`}>{mark.bpm} BPM</span>)}
      </div>}
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
          const at = shownBy(drag, "title", title.id, title.at, title.length);
          return <button key={title.id} type="button" className="kd-lanes-title-block" aria-pressed={id === selected}
            style={{ left: pct(at.at, span), width: pct(at.length, span) }}
            title={`${title.text} · ${laneClock(at.at)}–${laneClock(at.at + at.length)}`} {...grip("title", title.id, id)}>
            {title.text}
          </button>;
        })}
      </div>}
      {rows.map(row => <div key={row.key} className="kd-lanes-row-wrap">
        {newTrackLine(rowLines[rows.indexOf(row)])}
        <div ref={node => { if (node) rowNodes.current.set(row.key, node); else rowNodes.current.delete(row.key); }}
          className="kd-lanes-lane" data-lane={row.kind} data-folded={row.fold && !row.opened ? "" : undefined}
          aria-label={row.tracks.map(t => trackName(doc, t)).join(" + ")}
          data-drop={drop?.some(mark => row.tracks.some(t => t.id === mark.track)) || (heldTo && "track" in heldTo && held && heldTo.track !== held.track.id && row.tracks.some(t => t.id === heldTo.track)) || undefined}>
          {row.tracks.flatMap((track, depth) => track.clips.map(clip => clipBlock(clip, track, depth)))}
          {ghost(row)}
          {row.tracks[0] === firstOf("picture") && <PendingDownloads path={project.path || null} lane="main" span={span} end={pictureEnd} />}
          {row.tracks[0] === firstOf("sound") && <PendingDownloads path={project.path || null} lane="song" span={span} end={soundEnd} />}
          <DropMarks marks={drop} tracks={row.tracks} span={span} />
        </div>
      </div>)}
      <div className="kd-lanes-row-wrap" data-end="">{newTrackLine(doc.tracks.length)}</div>
      {head !== null && <span className="kd-lanes-playhead" style={{ left: pct(head, span) }} />}
      {guide !== undefined && <span className="kd-lanes-guide" style={{ left: pct(guide, span) }} />}
    </div>
   </div>
  </div>;
}
