/**
 * The lanes of a project in the editor (LaneEditor.tsx): the ruler with its markers, the titles
 * (when there are any), the branches, the picture and the songs, under one clock. Everything on
 * them is handled directly: a press chooses it, a drag moves it, a drag at either end pulls that
 * end; in a VJ what is dragged lands on the song's beats unless Alt is held. Library rows dropped
 * here go where they belong (LaneEditor's `onDropped`), whether the system carried them (the
 * harmonic list) or the track table followed the pointer by hand (lib/pointerTrackDrop.ts).
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { rulerStep } from "../../lib/aiTimeline";
import { fileLabel, isGap, laneClock, snapToBar, type LaneClip, type LaneOp } from "../../lib/lanes";
import { activeTrackDragIds, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { usePointerTrackDrop } from "../../lib/pointerTrackDrop";
import { useLibraryStore } from "../../stores/libraryStore";
import { isSongTrack, songsOf, type LaneProject } from "../../stores/laneEditorStore";

export const ZOOMS = [1, 2, 4, 8, 16];
const pct = (t: number, span: number) => `${Math.max(0, Math.min(100, (t / span) * 100))}%`;
/** How near an end a press has to be to pull that end, in pixels. */
const EDGE_PX = 7;
/** How far a press has to travel before it is a drag. */
const DRAG_PX = 3;

type Lane = "main" | "song" | "title";
type Grip = "move" | "in" | "out";
interface Drag { lane: Lane; key: string; grip: Grip; x0: number; dt: number; moved: boolean; free: boolean }

/** Every how many seconds the ruler names one, so that about a dozen names fit at this zoom. */
function secondStep(span: number): number {
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120]) if (span / step <= 12) return step;
  return 300;
}

/** What a library drag holds, read while it is still over the lanes: songs, or pictures. */
function draggedKind(ids: readonly number[]): "song" | "picture" | null {
  const byId = useLibraryStore.getState().summaryById;
  const rows = ids.map(id => byId.get(id)).filter(Boolean);
  if (rows.length === 0) return null;
  return rows.some(row => isSongTrack(row!)) ? "song" : "picture";
}

export function LaneBoard({ project, zoom, selected, select, playhead, seek, edit, onDropped }: {
  project: LaneProject; zoom: number; selected: string | null; select(id: string | null): void;
  playhead: number | null; seek(t: number): void; edit(ops: LaneOp[]): void;
  onDropped(ids: readonly number[], at: number): void;
}) {
  const { doc, layout, grid } = project;
  const board = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ lane: "song" | "main"; at: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const span = Math.max(1, layout.duration);
  const vj = songsOf(doc).length > 0;
  const downbeats = useMemo(() => grid?.downbeats ?? [], [grid]);
  const beats = useMemo(() => grid?.beats ?? [], [grid]);
  const songs = layout.songs ?? [];
  const titles = doc.titles ?? [];
  const markers = doc.markers ?? [];

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
  /** The beat nearest `t` in a VJ (when not let free), else `t`. */
  const snap = (t: number, free: boolean) => {
    if (free || !vj || beats.length === 0) return Math.max(0, t);
    return beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0]);
  };

  // ---- what is dragged, and where it is drawn meanwhile ----
  const clipOf = (id: string) => doc.main.find((item): item is LaneClip => !isGap(item) && item.id === id);
  const placedOf = (lane: Lane, key: string) => {
    if (lane === "main") { const m = layout.main.find(item => item.id === key); return m && { at: m.at, length: m.length }; }
    if (lane === "song") { const s = songs[Number(key)]; return s && { at: s.at, length: s.length }; }
    const t = titles.find(title => title.id === key);
    return t && { at: t.at, length: t.length };
  };
  /** Where an item stands while it is dragged: its start and length after the drag so far. */
  const shown = (lane: Lane, key: string, at: number, length: number) => {
    if (!drag || !drag.moved || drag.lane !== lane || drag.key !== key) return { at, length };
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

  const press = (lane: Lane, key: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const grip: Grip = lane === "song" ? "move"
      : event.clientX - box.left <= EDGE_PX && box.width > EDGE_PX * 3 ? "in"
        : box.right - event.clientX <= EDGE_PX && box.width > EDGE_PX * 3 ? "out" : "move";
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { lane, key, grip, x0: event.clientX, dt: 0, moved: false, free: event.altKey };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const now = dragRef.current;
    if (!now) return;
    const dx = event.clientX - now.x0;
    const next = { ...now, dt: dx / width() * span, moved: now.moved || Math.abs(dx) > DRAG_PX, free: event.altKey };
    dragRef.current = next;
    setDrag(next);
  };
  const release = (id: string) => () => {
    const done = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!done) return;
    if (!done.moved) { select(selected === id ? null : id); return; }
    const placed = placedOf(done.lane, done.key);
    if (!placed) return;
    const after = shown(done.lane, done.key, placed.at, placed.length);
    const ops = commit(done, placed, after);
    if (ops.length) edit(ops);
  };

  /** The operations that make a drag stick. */
  const commit = (done: Drag, before: { at: number; length: number }, after: { at: number; length: number }): LaneOp[] => {
    const round = (v: number) => Math.round(v * 1000) / 1000;
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
      if (vj) return [{ op: "move_to", id: clip.id, at: round(after.at) }];
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
    const place: LaneOp = { op: "move_to", id: clip.id, at: round(after.at) };
    return shift > 0 ? [trim, place] : [place, trim];
  };

  const grip = (lane: Lane, key: string, id: string) => ({
    onPointerDown: press(lane, key), onPointerMove: move, onPointerUp: release(id),
    onPointerCancel: () => { dragRef.current = null; setDrag(null); },
    // The keyboard (and assistive technology) chooses with a click that no pointer pressed.
    onClick: (event: { detail: number }) => { if (event.detail === 0) select(selected === id ? null : id); },
    "data-dragging": drag?.moved && drag.lane === lane && drag.key === key ? "" : undefined,
  });

  /** Where rows let go at `x` land: songs at a slot of the song lane, pictures at a time. */
  const landing = (ids: readonly number[], x: number): { lane: "song" | "main"; at: number } => {
    const t = timeAt(x);
    if (draggedKind(ids) === "song") {
      const index = songs.filter(s => s.at + s.length / 2 < t).length;
      const end = songs.length ? songs[songs.length - 1].at + songs[songs.length - 1].length : 0;
      return { lane: "song", at: songs[index]?.at ?? end };
    }
    return { lane: "main", at: vj ? snapToBar(downbeats, t) : t };
  };
  const hoverRows = (ids: readonly number[], x: number) => setDrop(landing(ids, x));
  const dropRows = (ids: readonly number[], x: number) => {
    setDrop(null);
    if (ids.length) onDropped(ids, landing(ids, x).at);
  };
  usePointerTrackDrop(board, {
    over: (ids, x) => { hoverRows(ids, x); return null; },
    leave: () => setDrop(null),
    drop: (ids, x) => dropRows(ids, x),
  });

  return <div className="kd-lanes-scroll">
    <div ref={board} className="kd-lanes-board" style={{ width: `${ZOOMS[zoom] * 100}%` }}
      onDragOver={event => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        hoverRows(activeTrackDragIds(), event.clientX);
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
      onDrop={event => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const ids = readTrackDragIds(event.dataTransfer);
        dropRows(ids.length ? ids : activeTrackDragIds(), event.clientX);
      }}>
      <div className="kd-lanes-ruler" onPointerDown={event => { if (event.target === event.currentTarget) seek(timeAt(event.clientX)); }}>
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
      <div className="kd-lanes-lane" data-lane="aux" aria-label="辅线">
        {layout.branches.map(b => <button key={`${b.clip}:${b.side}`} type="button" className="kd-lanes-branch-block"
          data-side={b.side} aria-pressed={b.clip === selected}
          style={{ left: pct(b.at, span), width: pct(b.length, span) }}
          title={`${b.side === "out" ? "出" : "入"}分叉 · ${b.length} 秒`} onClick={() => select(b.clip)} />)}
      </div>
      <svg className="kd-lanes-switches" data-titles={titles.length > 0 || undefined} viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
        {layout.branches.map(b => {
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
          return <button key={id} type="button" className="kd-lanes-clip" aria-pressed={id === selected}
            style={{ left: pct(at.at, span), width: pct(at.length, span) }}
            title={`${fileLabel(item.src ?? "")} · ${laneClock(at.at)}–${laneClock(at.at + at.length)}`} {...grip("main", id, id)}>
            {fileLabel(item.src ?? "")}
          </button>;
        })}
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
      </div>
      {playhead !== null && <span className="kd-lanes-playhead" style={{ left: pct(playhead, span) }} />}
      {drop && <span className="kd-lanes-drop" data-lane={drop.lane} style={{ left: pct(drop.at, span) }} />}
    </div>
  </div>;
}
