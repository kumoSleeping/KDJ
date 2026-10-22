/**
 * The editor of a `.kdjv` 2 project (docs/kdjv.md, "格式 2"), in the drawer beside the list: a
 * main lane of clips end to end and the branch lane above it, under a ruler of the song's bars (a
 * VJ) or of seconds. Library videos are dropped on the main lane; a clip is chosen to trim it,
 * change its speed, split it at the playhead or let it branch over its neighbour. Every change is
 * a list of operations the server checks and saves (laneEditorStore.ts); the picture is the video
 * window's while the project plays.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { LoaderCircle, Pause, Play, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../../lib/api";
import { rulerStep } from "../../lib/aiTimeline";
import { isImageTrack, isVideoTrack } from "../../lib/format";
import { fileLabel, isGap, laneClock, snapToBar, type BranchSide, type LaneBranch, type LaneClip, type LaneOp } from "../../lib/lanes";
import { getPlayerSession, requestPlayerCommand, subscribePlayerSession } from "../../lib/playerSession";
import { playTrack } from "../../lib/playTrack";
import { readTrackDragIds, TRACK_DND_TYPE } from "../../lib/trackDrag";
import { useLaneEditor } from "../../stores/laneEditorStore";
import "./LaneEditor.css";

const ZOOMS = [1, 2, 4, 8, 16];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const pct = (t: number, span: number) => `${Math.max(0, Math.min(100, (t / span) * 100))}%`;

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

function BranchControls({ clip, side, branch, beat, onOps }: {
  clip: LaneClip; side: BranchSide; branch: LaneBranch | undefined; beat: number; onOps(ops: LaneOp[]): void;
}) {
  const name = side === "out" ? "出分叉" : "入分叉";
  const length = branch?.length ?? beat;
  const send = (more: Partial<LaneBranch>) => onOps([{ op: "branch", clip: clip.id, side, length, opacity: branch?.opacity, fade: branch?.fade, ...more }]);
  return <div className="kd-lanes-branch" data-on={branch ? "" : undefined}>
    <label className="kd-lanes-check">
      <input type="checkbox" checked={Boolean(branch)}
        onChange={event => onOps([event.target.checked
          ? { op: "branch", clip: clip.id, side, length: beat }
          : { op: "unbranch", clip: clip.id, side }])} />
      <span title={side === "out" ? "这一段的结尾继续放，盖在下一段的开头上" : "这一段提前进来，盖在上一段的结尾上"}>{name}</span>
    </label>
    {branch && <>
      <NumberField label="长度（秒）" value={branch.length} step={0.05} min={0.05} max={30} onCommit={value => send({ length: value })} />
      <label className="kd-lanes-field">
        <span>透明度</span>
        <input type="range" min={0} max={1} step={0.05} defaultValue={branch.opacity ?? 1}
          onPointerUp={event => send({ opacity: Number(event.currentTarget.value) })}
          onKeyUp={event => send({ opacity: Number(event.currentTarget.value) })} />
      </label>
      <label className="kd-lanes-check">
        <input type="checkbox" checked={branch.fade !== false} onChange={event => send({ fade: event.target.checked })} />
        <span>淡入淡出</span>
      </label>
    </>}
  </div>;
}

export function LaneEditor() {
  const { doc, layout, grid, selected, analysing, busy, error, trackId, edit, select } = useLaneEditor();
  const playhead = usePlayhead(trackId);
  const [zoom, setZoom] = useState(0);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const span = Math.max(1, layout?.duration ?? 1);
  const vj = Boolean(doc?.song);
  const downbeats = useMemo(() => grid?.downbeats ?? [], [grid]);
  const songIn = grid?.songIn ?? 0;

  const ruler = useMemo(() => {
    if (vj && downbeats.length > 1) {
      const bars = downbeats.map((beat, n) => ({ n: n + 1, at: beat - songIn })).filter(bar => bar.at >= 0 && bar.at <= span);
      const step = rulerStep(bars.length / ZOOMS[zoom]);
      return bars.filter(bar => (bar.n - 1) % step === 0).map(bar => ({ at: bar.at, label: String(bar.n) }));
    }
    const step = secondStep(span / ZOOMS[zoom]);
    return Array.from({ length: Math.floor(span / step) + 1 }, (_, n) => ({ at: n * step, label: laneClock(n * step).replace(/\.0$/, "") }));
  }, [vj, downbeats, songIn, span, zoom]);

  /** One beat at `t` (the song's own beat there, through any tempo change), else half a second. */
  const beatNear = (t: number) => {
    const beats = (grid?.beats ?? []).map(beat => beat - songIn);
    const k = beats.findIndex(at => at > t);
    if (k > 0) return Math.round((beats[k] - beats[k - 1]) * 1000) / 1000;
    return 0.5;
  };
  /** The beats between the bar lines, drawn once a bar is wide enough to show them. */
  const beatTicks = useMemo(() => {
    const bars = downbeats.length;
    if (!vj || bars < 2 || bars / ZOOMS[zoom] > 24) return [];
    return (grid?.beats ?? []).map(beat => beat - songIn).filter(at => at >= 0 && at <= span);
  }, [vj, downbeats, grid, songIn, span, zoom]);

  const timeAt = (clientX: number) => {
    const node = board.current;
    if (!node) return 0;
    const box = node.getBoundingClientRect();
    return Math.max(0, Math.min(span, ((clientX - box.left) / box.width) * span));
  };

  const seek = (t: number) => {
    if (trackId === null) return;
    if (playhead.mine) { requestPlayerCommand({ type: "seek", position: t }); return; }
    void api.track(trackId).then(track => playTrack(track, true, undefined, t)).catch(() => undefined);
  };
  const toggle = () => {
    if (trackId === null) return;
    if (playhead.mine) { requestPlayerCommand({ type: "toggle" }); return; }
    void api.track(trackId).then(track => playTrack(track, true)).catch(() => undefined);
  };

  const accepts = (event: DragEvent) => {
    const types = Array.from(event.dataTransfer.types);
    return types.includes(TRACK_DND_TYPE) || types.includes("text/plain");
  };
  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const at = dropAt ?? timeAt(event.clientX);
    setDropAt(null);
    const ids = readTrackDragIds(event.dataTransfer);
    if (ids.length === 0) return;
    const tracks = (await Promise.all(ids.map(id => api.track(id).catch(() => null))))
      .filter(track => track && (isVideoTrack(track.format) || isImageTrack(track.format)) && (track.duration ?? 0) > 0);
    if (tracks.length === 0 || !layout) return;
    const ops: LaneOp[] = [];
    if (vj) {
      let place = snapToBar(downbeats, at, songIn);
      for (const track of tracks) {
        const out = Math.min(track!.duration ?? 0, span - place);
        if (out <= 0.05) break;
        ops.push({ op: "add", clip: { src: track!.path, in: 0, out, muted: true, fill: true }, at: place });
        place += out;
      }
    } else {
      let index = layout.main.filter(item => item.at + item.length / 2 < at).length;
      for (const track of tracks) ops.push({ op: "add", clip: { src: track!.path, in: 0, out: track!.duration ?? 0, fill: true }, index: index++ });
    }
    if (ops.length) await edit(ops);
  };

  if (!doc || !layout) {
    return <div className="kd-lanes" data-drawer-pending={busy || undefined}>
      <p className="kd-lanes-status" role={error ? "alert" : undefined}>{error ?? (busy ? "正在打开工程…" : "")}</p>
    </div>;
  }

  const clip = doc.main.find((item): item is LaneClip => !isGap(item) && item.id === selected) ?? null;
  const placed = layout.main.find(item => item.id === selected);
  const branchOf = (side: BranchSide) => doc.branches?.find(b => b.clip === selected && b.side === side);
  const insideClip = placed && playhead.position !== null && playhead.position > placed.at + 0.05 && playhead.position < placed.at + placed.length - 0.05;

  return <div className="kd-lanes kd-scroll" data-drawer-scroll>
    <div className="kd-lanes-head">
      <input className="kd-lanes-title" defaultValue={doc.title} key={doc.title} aria-label="工程名"
        onBlur={event => { const title = event.target.value.trim(); if (title && title !== doc.title) void edit([{ op: "title", title }]); }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      <button type="button" className="kd-lanes-key" onClick={toggle} aria-label={playhead.playing ? "暂停" : "播放"}>
        {playhead.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <span className="kd-lanes-time">{laneClock(playhead.position ?? 0)} / {laneClock(span)}</span>
      <button type="button" className="kd-lanes-key" disabled={zoom === 0} onClick={() => setZoom(z => Math.max(0, z - 1))} aria-label="缩小"><ZoomOut size={14} /></button>
      <button type="button" className="kd-lanes-key" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(z => Math.min(ZOOMS.length - 1, z + 1))} aria-label="放大"><ZoomIn size={14} /></button>
    </div>
    <p className="kd-lanes-status" role={error ? "alert" : undefined} data-error={error ? "" : undefined} title={error ?? undefined}>
      {busy ? <><LoaderCircle size={12} className="kd-spin" />保存中</>
        : error ?? (analysing ? <><LoaderCircle size={12} className="kd-spin" />正在分析这首歌的小节线</>
          : vj ? (downbeats.length ? "把曲库里的视频拖到主线上，会落在最近的小节线" : "这首歌没有分析出小节线，按秒放")
            : "把曲库里的视频拖到主线上")}
    </p>

    <div className="kd-lanes-scroll">
      <div ref={board} className="kd-lanes-board" style={{ width: `${ZOOMS[zoom] * 100}%` }}
        onDragOver={event => { if (!accepts(event)) return; event.preventDefault(); const t = timeAt(event.clientX); setDropAt(vj ? snapToBar(downbeats, t, songIn) : t); }}
        onDragLeave={() => setDropAt(null)}
        onDrop={event => void onDrop(event)}>
        <div className="kd-lanes-ruler" onPointerDown={event => seek(timeAt(event.clientX))} title="点一下跳到这里">
          {beatTicks.map(at => <span key={`b${at}`} className="kd-lanes-beat" style={{ left: pct(at, span) }} />)}
          {ruler.map(mark => <span key={mark.at} className="kd-lanes-mark" style={{ left: pct(mark.at, span) }}>{mark.label}</span>)}
        </div>
        <div className="kd-lanes-lane" data-lane="aux" aria-label="辅线">
          {layout.branches.map(b => <button key={`${b.clip}:${b.side}`} type="button" className="kd-lanes-branch-block"
            data-side={b.side} aria-pressed={b.clip === selected}
            style={{ left: pct(b.at, span), width: pct(b.length, span) }}
            title={`${b.clip} 的${b.side === "out" ? "出" : "入"}分叉 · ${b.length} 秒`} onClick={() => select(b.clip)} />)}
        </div>
        <svg className="kd-lanes-switches" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
          {layout.branches.map(b => {
            // The points: from the clip on the main lane up onto the branch, like railway points.
            const edge = (b.side === "out" ? b.at : b.at + b.length) / span * 1000;
            const far = (b.side === "out" ? b.at + Math.min(b.length, span / 50) : b.at + b.length - Math.min(b.length, span / 50)) / span * 1000;
            return <path key={`${b.clip}:${b.side}`} d={`M ${edge} 40 L ${far} 0`} vectorEffect="non-scaling-stroke" />;
          })}
        </svg>
        <div className="kd-lanes-lane" data-lane="main" aria-label="主线">
          {layout.main.map(item => item.gap
            ? <span key={`gap-${item.index}`} className="kd-lanes-gap" style={{ left: pct(item.at, span), width: pct(item.length, span) }}
              title={`黑 · ${laneClock(item.at)}–${laneClock(item.at + item.length)}`} />
            : <button key={item.id} type="button" className="kd-lanes-clip" aria-pressed={item.id === selected}
              style={{ left: pct(item.at, span), width: pct(item.length, span) }}
              title={`${fileLabel(item.src ?? "")} · ${laneClock(item.at)}–${laneClock(item.at + item.length)}`}
              onClick={() => select(item.id === selected ? null : item.id ?? null)}
              onKeyDown={event => { if ((event.key === "Delete" || event.key === "Backspace") && item.id) void edit([{ op: "remove", id: item.id }]); }}>
              {fileLabel(item.src ?? "")}
            </button>)}
        </div>
        {doc.song && <div className="kd-lanes-lane" data-lane="song" aria-label="歌">
          <span className="kd-lanes-song" style={{ left: 0, width: "100%" }}>{fileLabel(doc.song.src)}</span>
        </div>}
        {playhead.position !== null && <span className="kd-lanes-playhead" style={{ left: pct(playhead.position, span) }} />}
        {dropAt !== null && <span className="kd-lanes-drop" style={{ left: pct(dropAt, span) }} />}
      </div>
    </div>

    {clip && placed && <div className="kd-lanes-inspector">
      <div className="kd-lanes-row">
        <strong className="kd-lanes-name" title={clip.src}>{fileLabel(clip.src)}</strong>
        <span className="kd-lanes-time">{laneClock(placed.at)}–{laneClock(placed.at + placed.length)}</span>
        <button type="button" className="kd-lanes-key" disabled={!insideClip} title="在播放头处拆成两段"
          onClick={() => playhead.position !== null && void edit([{ op: "split", id: clip.id, at: playhead.position }])}><Scissors size={14} /></button>
        <button type="button" className="kd-lanes-key" title="删掉这一段" onClick={() => void edit([{ op: "remove", id: clip.id }])}><Trash2 size={14} /></button>
      </div>
      <div className="kd-lanes-row">
        <NumberField label="入点" value={clip.in ?? 0} step={0.1} min={0} onCommit={value => void edit([{ op: "trim", id: clip.id, in: value }])} />
        <NumberField label="出点" value={clip.out} step={0.1} min={0} onCommit={value => void edit([{ op: "trim", id: clip.id, out: value }])} />
        <label className="kd-lanes-field">
          <span>速度</span>
          <select value={clip.speed ?? 1} onChange={event => void edit([{ op: "set", id: clip.id, fields: { speed: Number(event.target.value) } }])}>
            {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
          </select>
        </label>
        <label className="kd-lanes-check">
          <input type="checkbox" checked={Boolean(clip.muted)} onChange={event => void edit([{ op: "set", id: clip.id, fields: { muted: event.target.checked } }])} />
          <span>静音</span>
        </label>
        <label className="kd-lanes-check">
          <input type="checkbox" checked={Boolean(clip.fill)} onChange={event => void edit([{ op: "set", id: clip.id, fields: { fill: event.target.checked } }])} />
          <span>铺满</span>
        </label>
      </div>
      <BranchControls clip={clip} side="in" branch={branchOf("in")} beat={beatNear(placed.at)} onOps={ops => void edit(ops)} />
      <BranchControls clip={clip} side="out" branch={branchOf("out")} beat={beatNear(placed.at + placed.length)} onOps={ops => void edit(ops)} />
    </div>}
  </div>;
}
