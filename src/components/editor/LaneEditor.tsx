/**
 * The editor of `.kdjv` 2 projects (docs/kdjv.md, "格式 2"), in the drawer beside the list. Each
 * open project is a page of the drawer's title; a song dropped on the title starts another one.
 * Under a ruler of the songs' bars (a VJ) or of seconds lie three lanes: the branch lane, the
 * picture (主线) and the songs. What is dropped in goes where it belongs — a song into the song
 * lane before or after the song it lands on, a video onto the picture at the bar it lands on — and
 * into an empty editor it starts a project. Below, one row of tools; the chosen tool unfolds its
 * own few controls for what is chosen on the lanes. Every change is a list of operations the server
 * checks and saves (laneEditorStore.ts); the picture is the video window's while the project plays.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Crosshair, Frame, GitBranch, LoaderCircle, Pause, Play, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../../lib/api";
import { rulerStep } from "../../lib/aiTimeline";
import { fileLabel, isGap, laneClock, snapToBar, type BranchSide, type LaneBranch, type LaneClip, type LaneOp } from "../../lib/lanes";
import { getPlayerSession, requestPlayerCommand, subscribePlayerSession } from "../../lib/playerSession";
import { playTrack } from "../../lib/playTrack";
import { activeTrackDragIds, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { requestLocalVideo, useVideoPip } from "../../lib/videoPip";
import { useLibraryStore } from "../../stores/libraryStore";
import { clipOf, isPictureTrack, isSongTrack, songOf, songsOf, useActiveProject, useLaneEditor, type LaneProject } from "../../stores/laneEditorStore";
import type { Track } from "../../types";
import { Segmented, Slider } from "../common";
import "./LaneEditor.css";

const ZOOMS = [1, 2, 4, 8, 16];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const pct = (t: number, span: number) => `${Math.max(0, Math.min(100, (t / span) * 100))}%`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

type Tool = "cut" | "picture" | "sound" | "seam" | "align";
const TOOLS: Array<{ id: Tool; label: string; icon: typeof Scissors }> = [
  { id: "cut", label: "剪切", icon: Scissors },
  { id: "picture", label: "画面", icon: Frame },
  { id: "sound", label: "声音", icon: AudioLines },
  { id: "seam", label: "转场", icon: GitBranch },
  { id: "align", label: "校准", icon: Crosshair },
];

/** Every how many seconds the ruler names one, so that about a dozen names fit at this zoom. */
function secondStep(span: number): number {
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120]) if (span / step <= 12) return step;
  return 300;
}

function usePlayhead(trackId: number | null) {
  const session = useSyncExternalStore(subscribePlayerSession, getPlayerSession);
  const mine = trackId !== null && session.trackId === trackId;
  return { mine, playing: mine && session.playing, position: mine ? session.position : null };
}

/** What a library drag holds, read while it is still over the editor: songs, pictures or both. */
function draggedKind(): "song" | "picture" | null {
  const byId = useLibraryStore.getState().summaryById;
  const rows = activeTrackDragIds().map(id => byId.get(id)).filter(Boolean);
  if (rows.length === 0) return null;
  return rows.some(row => isSongTrack(row!)) ? "song" : "picture";
}

/** The library rows of a drop, read whole (their lengths), in the order they were dragged. */
async function droppedTracks(transfer: DataTransfer): Promise<Track[]> {
  const ids = readTrackDragIds(transfer);
  const list = ids.length ? ids : [...activeTrackDragIds()];
  const tracks = await Promise.all(list.map(id => api.track(id).catch(() => null)));
  return tracks.filter((track): track is Track => Boolean(track && (track.duration ?? 0) > 0));
}

/** A number field that sends its value when it is left or Enter is pressed, not on each key. */
function NumberField({ label, value, step, min, max, onCommit }: {
  label: string; value: number; step: number; min?: number; max?: number; onCommit(value: number): void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number(text);
    if (Number.isFinite(next) && next !== value) onCommit(next);
    else setText(String(value));
  };
  return <label className="kd-lanes-field">
    <span>{label}</span>
    <input type="number" inputMode="decimal" value={text} step={step} min={min} max={max}
      onChange={event => setText(event.target.value)} onBlur={commit}
      onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  </label>;
}

/** A slider that shows its value while it moves and sends it once, when it is let go. */
function SettleSlider({ label, value, min, max, step, defaultValue, format, onCommit }: {
  label: string; value: number; min: number; max: number; step: number; defaultValue: number;
  format(value: number): string; onCommit(value: number): void;
}) {
  const [moving, setMoving] = useState<number | null>(null);
  const shown = moving ?? value;
  const settle = useRef<number | null>(null);
  const change = (next: number) => {
    setMoving(next);
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => { settle.current = null; setMoving(null); if (next !== value) onCommit(next); }, 350);
  };
  useEffect(() => () => { if (settle.current !== null) window.clearTimeout(settle.current); }, []);
  return <Slider label={label} value={shown} min={min} max={max} step={step} defaultValue={defaultValue} format={format} onChange={change} />;
}

function Branch({ clip, side, branch, beat, onOps }: {
  clip: LaneClip; side: BranchSide; branch: LaneBranch | undefined; beat: number; onOps(ops: LaneOp[]): void;
}) {
  const name = side === "out" ? "出分叉" : "入分叉";
  const length = branch?.length ?? beat;
  const send = (more: Partial<LaneBranch>) => onOps([{ op: "branch", clip: clip.id, side, length, opacity: branch?.opacity, fade: branch?.fade, ...more }]);
  return <div className="kd-lanes-row" data-on={branch ? "" : undefined}>
    <label className="kd-lanes-check" title={side === "out" ? "这一段的结尾继续放，盖在下一段的开头上" : "这一段提前进来，盖在上一段的结尾上"}>
      <input type="checkbox" checked={Boolean(branch)}
        onChange={event => onOps([event.target.checked
          ? { op: "branch", clip: clip.id, side, length: beat }
          : { op: "unbranch", clip: clip.id, side }])} />
      <span>{name}</span>
    </label>
    {branch && <>
      <NumberField label="秒" value={branch.length} step={0.05} min={0.05} max={30} onCommit={value => send({ length: value })} />
      <SettleSlider label="透明度" value={branch.opacity ?? 1} min={0} max={1} step={0.05} defaultValue={1} format={percent}
        onCommit={value => send({ opacity: value })} />
      <label className="kd-lanes-check">
        <input type="checkbox" checked={branch.fade !== false} onChange={event => send({ fade: event.target.checked })} />
        <span>淡入淡出</span>
      </label>
    </>}
  </div>;
}

/** The chosen tool's controls for what is chosen on the lanes; nothing when they have nothing to act on. */
function ToolPanel({ tool, project, clipId, songIndex, playhead, beatNear, edit }: {
  tool: Tool; project: LaneProject; clipId: string | null; songIndex: number | null; playhead: number | null;
  beatNear(t: number): number; edit(ops: LaneOp[]): void;
}) {
  const { doc, layout, grid } = project;
  const clip = doc.main.find((item): item is LaneClip => !isGap(item) && item.id === clipId) ?? null;
  const placed = layout.main.find(item => item.id === clipId);
  const songs = songsOf(doc);
  const song = songIndex === null ? null : songs[songIndex] ?? null;
  const vj = songs.length > 0;
  const clips = doc.main.filter((item): item is LaneClip => !isGap(item));

  if (tool === "cut") {
    if (clip && placed) {
      // In a VJ the cut lands on the beat nearest the playhead.
      const beats = grid?.beats ?? [];
      const nearest = playhead === null || !vj || beats.length === 0 ? playhead
        : beats.reduce((best, t) => (Math.abs(t - playhead) < Math.abs(best - playhead) ? t : best), beats[0]);
      const inside = nearest !== null && nearest > placed.at + 0.05 && nearest < placed.at + placed.length - 0.05;
      return <div className="kd-lanes-row">
        <button type="button" className="kd-lanes-action" disabled={!inside}
          onClick={() => nearest !== null && edit([{ op: "split", id: clip.id, at: nearest }])}>
          <Scissors size={14} />切开{inside ? ` · ${laneClock(nearest!)}` : ""}
        </button>
        <NumberField label="入点" value={clip.in ?? 0} step={0.1} min={0} onCommit={value => edit([{ op: "trim", id: clip.id, in: value }])} />
        <NumberField label="出点" value={clip.out} step={0.1} min={0} onCommit={value => edit([{ op: "trim", id: clip.id, out: value }])} />
        <button type="button" className="kd-lanes-action" onClick={() => edit([{ op: "remove", id: clip.id }])}><Trash2 size={14} />删掉</button>
      </div>;
    }
    if (song && songIndex !== null) {
      return <div className="kd-lanes-row">
        <button type="button" className="kd-lanes-action" disabled={songIndex === 0}
          onClick={() => edit([{ op: "move_song", from: songIndex, to: songIndex - 1 }])}><ArrowLeft size={14} />往前</button>
        <button type="button" className="kd-lanes-action" disabled={songIndex === songs.length - 1}
          onClick={() => edit([{ op: "move_song", from: songIndex, to: songIndex + 1 }])}><ArrowRight size={14} />往后</button>
        <button type="button" className="kd-lanes-action" onClick={() => edit([{ op: "remove_song", index: songIndex }])}><Trash2 size={14} />删掉这首歌</button>
      </div>;
    }
    return null;
  }

  if (tool === "picture") {
    if (clip) {
      return <div className="kd-lanes-rows">
        <div className="kd-lanes-row">
          <Segmented label="画面大小" value={clip.fill ? "fill" : "fit"}
            options={[{ value: "fill", label: "铺满" }, { value: "fit", label: "完整" }]}
            onChange={value => edit([{ op: "set", id: clip.id, fields: { fill: value === "fill" } }])} />
          <Segmented label="速度" value={clip.speed ?? 1}
            options={SPEEDS.map(speed => ({ value: speed, label: `${speed}×` }))}
            onChange={value => edit([{ op: "set", id: clip.id, fields: { speed: value } }])} />
        </div>
        <div className="kd-lanes-row">
          <SettleSlider label="缩放" value={clip.scale ?? 1} min={0.1} max={2} step={0.05} defaultValue={1} format={percent}
            onCommit={value => edit([{ op: "set", id: clip.id, fields: { scale: value } }])} />
          <SettleSlider label="透明度" value={clip.opacity ?? 1} min={0} max={1} step={0.05} defaultValue={1} format={percent}
            onCommit={value => edit([{ op: "set", id: clip.id, fields: { opacity: value } }])} />
        </div>
      </div>;
    }
    if (clips.length === 0) return null;
    // Nothing chosen: every picture of the project at once.
    return <div className="kd-lanes-row">
      <button type="button" className="kd-lanes-action" onClick={() => edit(clips.map(c => ({ op: "set" as const, id: c.id, fields: { fill: true } })))}>全部铺满</button>
      <button type="button" className="kd-lanes-action" onClick={() => edit(clips.map(c => ({ op: "set" as const, id: c.id, fields: { fill: false } })))}>全部完整</button>
    </div>;
  }

  if (tool === "sound") {
    if (clip) {
      return <div className="kd-lanes-row">
        <label className="kd-lanes-check">
          <input type="checkbox" checked={Boolean(clip.muted)} onChange={event => edit([{ op: "set", id: clip.id, fields: { muted: event.target.checked } }])} />
          <span>静音</span>
        </label>
        <SettleSlider label="音量" value={clip.volume ?? 1} min={0} max={2} step={0.05} defaultValue={1} format={percent}
          onCommit={value => edit([{ op: "set", id: clip.id, fields: { volume: value } }])} />
      </div>;
    }
    if (song && songIndex !== null) {
      return <div className="kd-lanes-row">
        <SettleSlider label="音量" value={song.volume ?? 1} min={0} max={2} step={0.05} defaultValue={1} format={percent}
          onCommit={value => edit([{ op: "set_song", index: songIndex, fields: { volume: value } }])} />
      </div>;
    }
    return null;
  }

  if (tool === "align") {
    if (!clip || !vj) return null;
    return <AlignPanel clipId={clip.id} />;
  }

  if (tool === "seam") {
    if (!clip || !placed) return null;
    const branchOf = (side: BranchSide) => doc.branches?.find(b => b.clip === clip.id && b.side === side);
    return <div className="kd-lanes-rows">
      <Branch clip={clip} side="in" branch={branchOf("in")} beat={beatNear(placed.at)} onOps={edit} />
      <Branch clip={clip} side="out" branch={branchOf("out")} beat={beatNear(placed.at + placed.length)} onOps={edit} />
    </div>;
  }

  return null;
}

/** 校准: where the chosen clip's sound lies in the song under it, and the ways to place it there. */
function AlignPanel({ clipId }: { clipId: string }) {
  const aligning = useLaneEditor(state => state.aligning.includes(clipId));
  const plans = useLaneEditor(state => state.plans[clipId]);
  const { calibrate, applyPlan } = useLaneEditor.getState();
  return <div className="kd-lanes-rows">
    <div className="kd-lanes-row">
      <button type="button" className="kd-lanes-action" disabled={aligning} onClick={() => void calibrate(clipId)}>
        {aligning ? <LoaderCircle size={14} className="kd-spin" /> : <Crosshair size={14} />}{aligning ? "正在对齐" : "对齐到歌"}
      </button>
      {plans && plans.length === 0 && !aligning && <span className="kd-lanes-note">没有找到对得上的位置</span>}
    </div>
    {plans && plans.length > 0 && <div className="kd-lanes-row">
      {plans.slice(0, 4).map(plan => <button key={plan.id} type="button" className="kd-lanes-action" title={plan.id}
        onClick={() => void applyPlan(clipId, plan)}>
        {plan.label}{plan.similarity !== undefined ? ` · ${Math.round(plan.similarity * 100)}%` : ""}
      </button>)}
    </div>}
  </div>;
}

function Board({ project, zoom, selected, select, playhead, onDropped }: {
  project: LaneProject; zoom: number; selected: string | null; select(id: string | null): void;
  playhead: number | null; onDropped(transfer: DataTransfer, at: number): void;
}) {
  const { doc, layout, grid } = project;
  const board = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ lane: "song" | "main"; at: number } | null>(null);
  const span = Math.max(1, layout.duration);
  const vj = songsOf(doc).length > 0;
  const downbeats = useMemo(() => grid?.downbeats ?? [], [grid]);
  const songs = layout.songs ?? [];

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
    return (grid?.beats ?? []).filter(at => at >= 0 && at <= span);
  }, [vj, downbeats, grid, span, zoom]);

  const timeAt = (clientX: number) => {
    const node = board.current;
    if (!node) return 0;
    const box = node.getBoundingClientRect();
    return Math.max(0, Math.min(span, ((clientX - box.left) / box.width) * span));
  };
  /** Where a song dropped at `t` goes: before the song it lands on in its first half, else after it. */
  const songSlot = (t: number) => {
    const index = songs.filter(s => s.at + s.length / 2 < t).length;
    return { index, at: songs[index]?.at ?? (songs.length ? songs[songs.length - 1].at + songs[songs.length - 1].length : 0) };
  };
  const seek = (t: number) => {
    if (project.trackId === null) return;
    if (playhead !== null) { requestPlayerCommand({ type: "seek", position: t }); return; }
    void api.track(project.trackId).then(track => playTrack(track, true, undefined, t)).catch(() => undefined);
  };

  return <div className="kd-lanes-scroll">
    <div ref={board} className="kd-lanes-board" style={{ width: `${ZOOMS[zoom] * 100}%` }}
      onDragOver={event => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const t = timeAt(event.clientX);
        setDrop(draggedKind() === "song" ? { lane: "song", at: songSlot(t).at } : { lane: "main", at: vj ? snapToBar(downbeats, t) : t });
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
      onDrop={event => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const at = drop?.at ?? timeAt(event.clientX);
        setDrop(null);
        onDropped(event.dataTransfer, at);
      }}>
      <div className="kd-lanes-ruler" onPointerDown={event => seek(timeAt(event.clientX))} title="点一下跳到这里">
        {beatTicks.map(at => <span key={`b${at}`} className="kd-lanes-beat" style={{ left: pct(at, span) }} />)}
        {ruler.map(mark => <span key={mark.at} className="kd-lanes-mark" style={{ left: pct(mark.at, span) }}>{mark.label}</span>)}
      </div>
      <div className="kd-lanes-lane" data-lane="aux" aria-label="辅线">
        {layout.branches.map(b => <button key={`${b.clip}:${b.side}`} type="button" className="kd-lanes-branch-block"
          data-side={b.side} aria-pressed={b.clip === selected}
          style={{ left: pct(b.at, span), width: pct(b.length, span) }}
          title={`${b.side === "out" ? "出" : "入"}分叉 · ${b.length} 秒`} onClick={() => select(b.clip)} />)}
      </div>
      <svg className="kd-lanes-switches" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
        {layout.branches.map(b => {
          // The points: from the clip on the main lane up onto the branch, like railway points.
          const edge = (b.side === "out" ? b.at : b.at + b.length) / span * 1000;
          const far = (b.side === "out" ? b.at + Math.min(b.length, span / 50) : b.at + b.length - Math.min(b.length, span / 50)) / span * 1000;
          return <path key={`${b.clip}:${b.side}`} d={`M ${edge} 40 L ${far} 0`} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <div className="kd-lanes-lane" data-lane="main" aria-label="画面" data-drop={drop?.lane === "main" || undefined}>
        {layout.main.map(item => item.gap
          ? <span key={`gap-${item.index}`} className="kd-lanes-gap" style={{ left: pct(item.at, span), width: pct(item.length, span) }}
            title={`黑 · ${laneClock(item.at)}–${laneClock(item.at + item.length)}`} />
          : <button key={item.id} type="button" className="kd-lanes-clip" aria-pressed={item.id === selected}
            style={{ left: pct(item.at, span), width: pct(item.length, span) }}
            title={`${fileLabel(item.src ?? "")} · ${laneClock(item.at)}–${laneClock(item.at + item.length)}`}
            onClick={() => select(item.id === selected ? null : item.id ?? null)}>
            {fileLabel(item.src ?? "")}
          </button>)}
      </div>
      <div className="kd-lanes-lane" data-lane="song" aria-label="歌" data-drop={drop?.lane === "song" || undefined}>
        {songs.map(song => {
          const id = `song:${song.index}`;
          return <button key={`${song.index}:${song.src}`} type="button" className="kd-lanes-song" aria-pressed={id === selected}
            style={{ left: pct(song.at, span), width: pct(song.length, span) }}
            title={`${fileLabel(song.src)} · ${laneClock(song.at)}–${laneClock(song.at + song.length)}`}
            onClick={() => select(id === selected ? null : id)}>
            {fileLabel(song.src)}
          </button>;
        })}
      </div>
      {playhead !== null && <span className="kd-lanes-playhead" style={{ left: pct(playhead, span) }} />}
      {drop && <span className="kd-lanes-drop" data-lane={drop.lane} style={{ left: pct(drop.at, span) }} />}
    </div>
  </div>;
}

export function LaneEditor() {
  const project = useActiveProject();
  const { selected, busy, error, edit, select, createFrom } = useLaneEditor();
  const playhead = usePlayhead(project?.trackId ?? null);
  const [zoom, setZoom] = useState(0);
  const [tool, setTool] = useState<Tool | null>(null);
  const [empty, setEmpty] = useState(false);

  const send = (ops: LaneOp[]) => { void edit(ops); };

  /** What was dropped goes where it belongs: songs into the song lane at the slot, pictures at `at`. */
  const dropInto = async (transfer: DataTransfer, at: number) => {
    const tracks = await droppedTracks(transfer);
    if (tracks.length === 0) return;
    if (!project) { await createFrom(tracks); return; }
    const { layout, grid } = project;
    const songs = tracks.filter(isSongTrack), pictures = tracks.filter(isPictureTrack);
    const ops: LaneOp[] = [];
    const placed = layout.songs ?? [];
    let index = placed.filter(s => s.at + s.length / 2 < at).length;
    for (const song of songs) ops.push({ op: "add_song", song: songOf(song), index: index++ });
    if (pictures.length) {
      const vj = placed.length > 0 || songs.length > 0;
      if (vj) {
        const span = placed.reduce((sum, s) => sum + s.length, 0) + songs.reduce((sum, s) => sum + (s.duration ?? 0), 0);
        let place = snapToBar(grid?.downbeats ?? [], at);
        for (const picture of pictures) {
          const out = Math.min(picture.duration ?? 0, span - place);
          if (out <= 0.05) break;
          ops.push({ op: "add", clip: { ...clipOf(picture, true), out }, at: place });
          place += out;
        }
      } else {
        let slot = layout.main.filter(item => item.at + item.length / 2 < at).length;
        for (const picture of pictures) ops.push({ op: "add", clip: clipOf(picture, false), index: slot++ });
      }
    }
    if (ops.length === 0) return;
    const before = new Set(project.doc.main.map(item => ("id" in item ? item.id : "")));
    if (!(await edit(ops)) || !pictures.length) return;
    // Each video dropped into a VJ is looked for in its song and moved there when it is found for sure.
    const now = useLaneEditor.getState().projects.find(p => p.path === project.path);
    if (!now || songsOf(now.doc).length === 0) return;
    for (const item of now.doc.main) {
      if ("id" in item && !before.has(item.id)) void useLaneEditor.getState().calibrate(item.id, true);
    }
  };

  const aligning = useLaneEditor(state => state.aligning.length);
  const status = busy ? <><LoaderCircle size={12} className="kd-spin" />保存中</>
    : error ? error
      : aligning ? <><LoaderCircle size={12} className="kd-spin" />正在校准</>
        : project?.analysing ? <><LoaderCircle size={12} className="kd-spin" />正在分析小节线</> : null;

  if (!project) {
    // Nothing open: the editor is a place to drop songs and videos into, which starts a project.
    return <div className="kd-lanes kd-lanes-empty" data-drawer-pending={busy || undefined} data-drop={empty || undefined}
      onDragOver={event => { if (!isTrackDrag(event)) return; event.preventDefault(); setEmpty(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEmpty(false); }}
      onDrop={event => { if (!isTrackDrag(event)) return; event.preventDefault(); setEmpty(false); void dropInto(event.dataTransfer, 0); }}>
      {status && <p className="kd-lanes-status" role={error ? "alert" : undefined} data-error={error ? "" : undefined}>{status}</p>}
    </div>;
  }

  const { doc, layout, grid, trackId } = project;
  const span = Math.max(1, layout.duration);
  const clipId = selected && !selected.startsWith("song:") ? selected : null;
  const songIndex = selected?.startsWith("song:") ? Number(selected.slice(5)) : null;
  /** One beat at `t` (the song's own beat there, through any tempo change), else half a second. */
  const beatNear = (t: number) => {
    const beats = grid?.beats ?? [];
    const k = beats.findIndex(at => at > t);
    return k > 0 ? Math.round((beats[k] - beats[k - 1]) * 1000) / 1000 : 0.5;
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

  return <div className="kd-lanes kd-scroll" data-drawer-scroll>
    <div className="kd-lanes-head">
      <button type="button" className="kd-lanes-key" onClick={toggle} aria-label={playhead.playing ? "暂停" : "播放"}>
        {playhead.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <span className="kd-lanes-time">{laneClock(playhead.position ?? 0)} / {laneClock(span)}</span>
      <input className="kd-lanes-title" defaultValue={doc.title} key={`${project.path}:${doc.title}`} aria-label="工程名"
        onBlur={event => { const title = event.target.value.trim(); if (title && title !== doc.title) send([{ op: "title", title }]); }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      <button type="button" className="kd-lanes-key" disabled={zoom === 0} onClick={() => setZoom(z => Math.max(0, z - 1))} aria-label="缩小"><ZoomOut size={14} /></button>
      <button type="button" className="kd-lanes-key" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(z => Math.min(ZOOMS.length - 1, z + 1))} aria-label="放大"><ZoomIn size={14} /></button>
    </div>
    {status && <p className="kd-lanes-status" role={error ? "alert" : undefined} data-error={error ? "" : undefined} title={error ?? undefined}>{status}</p>}

    <Board project={project} zoom={zoom} selected={selected} select={select} playhead={playhead.position}
      onDropped={(transfer, at) => void dropInto(transfer, at)} />

    <div className="kd-lanes-tools" role="toolbar" aria-label="剪辑工具">
      {TOOLS.map(({ id, label, icon: Icon }) => <button key={id} type="button" className="kd-lanes-tool"
        aria-pressed={tool === id} onClick={() => setTool(now => (now === id ? null : id))}>
        <Icon size={14} aria-hidden="true" />{label}
      </button>)}
    </div>
    {tool && <div key={tool} className="kd-lanes-panel" data-kd-turn="in">
      <ToolPanel tool={tool} project={project} clipId={clipId} songIndex={songIndex} playhead={playhead.position}
        beatNear={beatNear} edit={send} />
    </div>}
  </div>;
}
