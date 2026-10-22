/**
 * What stands under the editor's lanes (LaneEditor.tsx): everything that can be done to what is
 * chosen on them, in labelled rows, or what 字幕 and 导出 unfold. Values that slide are sent
 * once, when they settle; text is sent when it is left.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Crosshair, Download, LoaderCircle, Plus, RotateCcw, Scissors, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { exportProject, useKdjvLive } from "../../lib/kdjvPlay";
import { branchOps, isGap, laneClock, type BranchSide, type ExportOptions, type LaneBranch, type LaneClip, type LaneOp, type LaneTitle } from "../../lib/lanes";
import { drawTitle, TITLE_DEFAULTS, type TitleLook } from "../../lib/titleImage";
import { songsOf, useLaneEditor, type LaneProject } from "../../stores/laneEditorStore";
import { Segmented, Slider } from "../common";

export type Tool = "title" | "export";
type Crop = [number, number, number, number];

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const percent = (value: number) => `${Math.round(value * 100)}%`;
const round = (value: number) => Math.round(value * 1000) / 1000;

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

/** A slider that shows its value while it moves and sends it once, when it settles. */
function SettleSlider({ label, value, min, max, step, defaultValue, format, onCommit }: {
  label: string; value: number; min: number; max: number; step: number; defaultValue: number;
  format(value: number): string; onCommit(value: number): void;
}) {
  const [moving, setMoving] = useState<number | null>(null);
  const settle = useRef<number | null>(null);
  const change = (next: number) => {
    setMoving(next);
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => { settle.current = null; setMoving(null); if (next !== value) onCommit(next); }, 350);
  };
  useEffect(() => () => { if (settle.current !== null) window.clearTimeout(settle.current); }, []);
  return <Slider label={label} value={moving ?? value} min={min} max={max} step={step} defaultValue={defaultValue} format={format} onChange={change} />;
}

/**
 * The crop: a small frame of the picture with what is kept marked inside it; each side of the
 * kept part is pulled from its edge (or moved with the arrow keys once focused).
 */
function CropBox({ crop, onCommit }: { crop: Crop; onCommit(crop: Crop): void }) {
  const frame = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<Crop | null>(null);
  const c = live ?? crop;
  const SIDES = ["左", "上", "右", "下"] as const;
  // Rounded last: 0.9 - 0.3 is 0.6000000000000001, and with 0.3 that is more than the 0.9 allowed.
  const limit = (side: number, value: number, from: Crop) =>
    Math.round(Math.max(0, Math.min(0.9 - from[(side + 2) % 4], value)) * 100) / 100;
  const pull = (side: number) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || !frame.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = frame.current.getBoundingClientRect();
    let next: Crop = [...c];
    const follow = (move: PointerEvent) => {
      const value = side === 0 ? (move.clientX - box.left) / box.width : side === 1 ? (move.clientY - box.top) / box.height
        : side === 2 ? (box.right - move.clientX) / box.width : (box.bottom - move.clientY) / box.height;
      next = [...next] as Crop;
      next[side] = limit(side, value, next);
      setLive(next);
    };
    const target = event.currentTarget;
    const end = () => {
      target.removeEventListener("pointermove", follow);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      setLive(null);
      if (next.some((v, n) => v !== crop[n])) onCommit(next);
    };
    target.addEventListener("pointermove", follow);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };
  const nudge = (side: number) => (event: KeyboardEvent<HTMLSpanElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const inward = side < 2 ? ["ArrowRight", "ArrowDown"] : ["ArrowLeft", "ArrowUp"];
    const outward = side < 2 ? ["ArrowLeft", "ArrowUp"] : ["ArrowRight", "ArrowDown"];
    const delta = inward.includes(event.key) ? step : outward.includes(event.key) ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    const next = [...crop] as Crop;
    next[side] = limit(side, crop[side] + delta, crop);
    onCommit(next);
  };
  return <div className="kd-crop">
    <div ref={frame} className="kd-crop-frame" role="group" aria-label="裁剪">
      <div className="kd-crop-keep" style={{ left: `${c[0] * 100}%`, top: `${c[1] * 100}%`, right: `${c[2] * 100}%`, bottom: `${c[3] * 100}%` }}>
        {SIDES.map((name, side) => <span key={name} className="kd-crop-edge" data-side={side} role="slider" tabIndex={0}
          aria-label={`${name}边裁掉`} aria-valuemin={0} aria-valuemax={90} aria-valuenow={Math.round(c[side] * 100)}
          aria-valuetext={percent(c[side])} onPointerDown={pull(side)} onKeyDown={nudge(side)} />)}
      </div>
    </div>
    <span className="kd-lanes-note">{c.some(v => v > 0) ? c.map(v => Math.round(v * 100)).join(" · ") : ""}</span>
    {crop.some(v => v > 0) && <button type="button" className="kd-lanes-action" onClick={() => onCommit([0, 0, 0, 0])}>
      <RotateCcw size={13} />不裁</button>}
  </div>;
}

/** A branch of the chosen clip on one side: on or off, how long, how opaque, faded or not. */
function Branch({ clip, side, branch, beat, vj, at, sourceLength, onOps }: {
  clip: LaneClip; side: BranchSide; branch: LaneBranch | undefined; beat: number; vj: boolean; at: number;
  sourceLength: number | undefined; onOps(ops: LaneOp[]): void;
}) {
  const keep = { opacity: branch?.opacity, fade: branch?.fade };
  const make = (length: number, more: Partial<LaneBranch> = {}) =>
    onOps(branchOps(clip, side, length, vj, at, sourceLength, { ...keep, ...more }));
  return <div className="kd-lanes-row" data-on={branch ? "" : undefined}>
    <label className="kd-lanes-check" title={side === "out" ? "这一段的结尾继续放，盖在下一段的开头上" : "这一段提前进来，盖在上一段的结尾上"}>
      <input type="checkbox" checked={Boolean(branch)}
        onChange={event => { if (event.target.checked) make(beat); else onOps([{ op: "unbranch", clip: clip.id, side }]); }} />
      <span>{side === "out" ? "出分叉" : "入分叉"}</span>
    </label>
    {branch && <>
      <NumberField label="秒" value={branch.length} step={0.05} min={0.05} max={30} onCommit={value => make(value)} />
      <SettleSlider label="透明度" value={branch.opacity ?? 1} min={0} max={1} step={0.05} defaultValue={1} format={percent}
        onCommit={value => onOps([{ op: "branch", clip: clip.id, side, length: branch.length, ...keep, opacity: value }])} />
      <label className="kd-lanes-check">
        <input type="checkbox" checked={branch.fade !== false}
          onChange={event => onOps([{ op: "branch", clip: clip.id, side, length: branch.length, ...keep, fade: event.target.checked }])} />
        <span>淡入淡出</span>
      </label>
    </>}
  </div>;
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

const TITLE_COLORS = ["#ffffff", "#ffd60a", "#111111"];

/**
 * 字幕: the chosen title's words and look, or a new one's, added at the playhead. Each change is
 * drawn again and saved (titleImage.ts) before the title takes it.
 */
function TitlePanel({ title, playhead, beat, edit }: {
  title: LaneTitle | null; playhead: number | null; beat: number; edit(ops: LaneOp[]): void;
}) {
  const [draft, setDraft] = useState<TitleLook>({ text: "", ...TITLE_DEFAULTS });
  const look: TitleLook = title ?? draft;
  const [text, setText] = useState(look.text);
  // A newly chosen title (or its words changed by undo) shows its own words.
  useEffect(() => setText(title?.text ?? draft.text), [title?.id, title?.text]);
  const [failed, setFailed] = useState("");
  /** The title with `change`: drawn, saved, and set (or only kept, for a title not added yet). */
  const apply = async (change: Partial<TitleLook>) => {
    const next = { ...look, ...change };
    if (!title) { setDraft(next); return; }
    if (!next.text.trim()) return;
    try {
      const { src } = await api.saveTitleImage(drawTitle(next));
      edit([{ op: "set_title", id: title.id, fields: { ...change, src } }]);
      setFailed("");
    } catch (error) { setFailed(error instanceof Error ? error.message : String(error)); }
  };
  const add = async () => {
    const words = text.trim();
    if (!words || playhead === null) return;
    const next = { ...draft, text: words };
    try {
      const { src } = await api.saveTitleImage(drawTitle(next));
      edit([{ op: "add_title", title: { ...next, src, at: round(playhead), length: round(Math.max(1, beat * 8)) } }]);
      setDraft({ ...next, text: "" });
      setText("");
      setFailed("");
    } catch (error) { setFailed(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="kd-lanes-rows">
    <div className="kd-lanes-row">
      <textarea className="kd-lanes-text" rows={2} value={text} aria-label="字幕的字" spellCheck={false}
        onChange={event => setText(event.target.value)}
        onBlur={() => { if (title && text.trim() && text !== title.text) void apply({ text }); else if (!title) setDraft({ ...draft, text }); }} />
    </div>
    <div className="kd-lanes-row">
      <SettleSlider label="字号" value={look.size ?? TITLE_DEFAULTS.size} min={24} max={160} step={2} defaultValue={TITLE_DEFAULTS.size}
        format={value => String(value)} onCommit={value => void apply({ size: value })} />
      <SettleSlider label="高低" value={look.y ?? TITLE_DEFAULTS.y} min={0.08} max={0.95} step={0.01} defaultValue={TITLE_DEFAULTS.y}
        format={percent} onCommit={value => void apply({ y: value })} />
    </div>
    <div className="kd-lanes-row">
      <div className="kd-lanes-swatches" role="radiogroup" aria-label="字的颜色">
        {TITLE_COLORS.map(color => <button key={color} type="button" role="radio" className="kd-lanes-swatch"
          aria-checked={(look.color ?? TITLE_DEFAULTS.color) === color} aria-label={color} style={{ background: color }}
          onClick={() => void apply({ color })} />)}
      </div>
      <label className="kd-lanes-check">
        <input type="checkbox" checked={look.outline ?? TITLE_DEFAULTS.outline} onChange={event => void apply({ outline: event.target.checked })} />
        <span>描边</span>
      </label>
      {title
        ? <>
          <NumberField label="秒" value={title.length} step={0.5} min={0.2} onCommit={value => edit([{ op: "set_title", id: title.id, fields: { length: value } }])} />
          <button type="button" className="kd-lanes-action" onClick={() => edit([{ op: "remove_title", id: title.id }])}><Trash2 size={14} />删掉</button>
        </>
        : <button type="button" className="kd-lanes-action" disabled={!text.trim() || playhead === null} onClick={() => void add()}>
          <Plus size={14} />加在播放头{playhead !== null ? ` · ${laneClock(playhead)}` : ""}
        </button>}
      {failed && <span className="kd-lanes-note" role="alert">{failed}</span>}
    </div>
  </div>;
}

/** The export's short side: the long one follows the project's own shape, upright or wide. */
const SIZES = { project: null, "1080": 1080, "720": 720, "2160": 2160 } as const;
const even = (value: number) => Math.round(value / 2) * 2;
const QUALITY = { high: 16, standard: 20, compact: 26 } as const;

/** 导出: the project written out beside it, as it plays or as set here. */
function ExportPanel({ project }: { project: LaneProject }) {
  const [size, setSize] = useState<keyof typeof SIZES>("project");
  const [fps, setFps] = useState<"project" | 30 | 60>("project");
  const [quality, setQuality] = useState<keyof typeof QUALITY>("standard");
  const [range, setRange] = useState<"all" | "marks">("all");
  const [what, setWhat] = useState<"video" | "sound">("video");
  const markers = project.doc.markers ?? [];
  const marked = markers.length >= 2;
  const go = async () => {
    if (project.trackId === null) return;
    const options: ExportOptions = {};
    const short = SIZES[size];
    if (short) {
      const canvas = project.doc.canvas as { width?: number; height?: number } | undefined;
      const live = project.trackId !== null ? useKdjvLive.getState().live[project.trackId] : undefined;
      const w = canvas?.width ?? live?.width ?? 16, h = canvas?.height ?? live?.height ?? 9;
      if (h > w) { options.width = short; options.height = even(short * h / w); }
      else { options.height = short; options.width = even(short * w / h); }
    }
    if (fps !== "project") options.fps = fps;
    if (quality !== "standard") options.quality = QUALITY[quality];
    if (range === "marks" && marked) { options.from = markers[0].at; options.to = markers[markers.length - 1].at; }
    if (what === "sound") options.audio_only = true;
    const track = await api.track(project.trackId).catch(() => null);
    if (track) exportProject(track, Object.keys(options).length ? options : undefined);
  };
  const sound = what === "sound";
  return <div className="kd-lanes-rows">
    <div className="kd-lanes-row">
      <Segmented<"video" | "sound"> label="导出什么" value={what} onChange={setWhat}
        options={[{ value: "video", label: "视频" }, { value: "sound", label: "只要声音" }]} />
      <Segmented<"all" | "marks"> label="范围" value={range} onChange={setRange}
        options={[{ value: "all", label: "全部" }, ...(marked ? [{ value: "marks" as const, label: "标记之间" }] : [])]} />
    </div>
    {!sound && <div className="kd-lanes-row">
      <Segmented<keyof typeof SIZES> label="尺寸" value={size} onChange={setSize}
        options={[{ value: "project", label: "原样" }, { value: "720", label: "720p" }, { value: "1080", label: "1080p" }, { value: "2160", label: "4K" }]} />
      <Segmented<"project" | 30 | 60> label="帧率" value={fps} onChange={setFps}
        options={[{ value: "project", label: "原样" }, { value: 30, label: "30" }, { value: 60, label: "60" }]} />
      <Segmented<keyof typeof QUALITY> label="画质" value={quality} onChange={setQuality}
        options={[{ value: "high", label: "高" }, { value: "standard", label: "标准" }, { value: "compact", label: "小" }]} />
    </div>}
    <div className="kd-lanes-row">
      <button type="button" className="kd-lanes-action" disabled={project.trackId === null} onClick={() => void go()}>
        <Download size={14} />导出{sound ? " WAV" : " MP4"}
      </button>
    </div>
  </div>;
}

/** A labelled row of the inspector: a quiet word, then its controls. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return <div className="kd-lanes-section">
    <span className="kd-lanes-section-label">{label}</span>
    <div className="kd-lanes-rows">{children}</div>
  </div>;
}

/**
 * Under the lanes: what is chosen, with everything that can be done to it in one place — a clip's
 * cut, picture, sound, branches and (in a VJ) its place in the song; a song's place and volume; a
 * title's words and look. `tool` (字幕, 导出) shows that instead; nothing chosen, the whole picture.
 */
export function ToolPanel({ tool, project, selected, playhead, beatNear, edit }: {
  tool: Tool | null; project: LaneProject; selected: string | null; playhead: number | null;
  beatNear(t: number): number; edit(ops: LaneOp[]): void;
}) {
  const { doc, layout, grid } = project;
  const clipId = selected && !selected.includes(":") ? selected : null;
  const songIndex = selected?.startsWith("song:") ? Number(selected.slice(5)) : null;
  const titleId = selected?.startsWith("title:") ? selected.slice(6) : null;
  const clip = doc.main.find((item): item is LaneClip => !isGap(item) && item.id === clipId) ?? null;
  const placed = layout.main.find(item => item.id === clipId);
  const songs = songsOf(doc);
  const song = songIndex === null ? null : songs[songIndex] ?? null;
  const title = doc.titles?.find(t => t.id === titleId) ?? null;
  const vj = songs.length > 0;
  const clips = doc.main.filter((item): item is LaneClip => !isGap(item));

  if (tool === "export") return <ExportPanel project={project} />;
  if (tool === "title" || title) return <TitlePanel key={title?.id ?? "new"} title={title} playhead={playhead} beat={beatNear(playhead ?? 0)} edit={edit} />;

  if (clip && placed) {
    // In a VJ the cut lands on the beat nearest the playhead.
    const beats = grid?.beats ?? [];
    const at = playhead === null || !vj || beats.length === 0 ? playhead
      : beats.reduce((best, t) => (Math.abs(t - playhead) < Math.abs(best - playhead) ? t : best), beats[0]);
    const inside = at !== null && at > placed.at + 0.05 && at < placed.at + placed.length - 0.05;
    const branchOf = (side: BranchSide) => doc.branches?.find(b => b.clip === clip.id && b.side === side);
    return <div className="kd-lanes-rows">
      <Section label="剪">
        <div className="kd-lanes-row">
          <button type="button" className="kd-lanes-action" disabled={!inside} title="在播放头切开 · S"
            onClick={() => at !== null && edit([{ op: "split", id: clip.id, at }])}>
            <Scissors size={14} />切开{inside ? ` · ${laneClock(at!)}` : ""}
          </button>
          <NumberField label="入点" value={clip.in ?? 0} step={0.1} min={0} onCommit={value => edit([{ op: "trim", id: clip.id, in: value }])} />
          <NumberField label="出点" value={clip.out} step={0.1} min={0} onCommit={value => edit([{ op: "trim", id: clip.id, out: value }])} />
          <button type="button" className="kd-lanes-action" title="Delete" onClick={() => edit([{ op: "remove", id: clip.id }])}><Trash2 size={14} />删掉</button>
        </div>
      </Section>
      <Section label="画面">
        <div className="kd-lanes-row">
          <Segmented label="画面大小" value={clip.fill ? "fill" : "fit"}
            options={[{ value: "fill", label: "铺满" }, { value: "fit", label: "完整" }]}
            onChange={value => edit([{ op: "set", id: clip.id, fields: { fill: value === "fill" } }])} />
          <Segmented label="速度" value={clip.speed ?? 1}
            options={SPEEDS.map(speed => ({ value: speed, label: `${speed}×` }))}
            onChange={value => edit([{ op: "set", id: clip.id, fields: { speed: value } }])} />
        </div>
        <div className="kd-lanes-row">
          <CropBox crop={clip.crop ?? [0, 0, 0, 0]} onCommit={crop => edit([{ op: "set", id: clip.id, fields: { crop } }])} />
          <div className="kd-lanes-rows kd-lanes-grow">
            <SettleSlider label="缩放" value={clip.scale ?? 1} min={0.1} max={2} step={0.05} defaultValue={1} format={percent}
              onCommit={value => edit([{ op: "set", id: clip.id, fields: { scale: value } }])} />
            <SettleSlider label="透明度" value={clip.opacity ?? 1} min={0} max={1} step={0.05} defaultValue={1} format={percent}
              onCommit={value => edit([{ op: "set", id: clip.id, fields: { opacity: value } }])} />
          </div>
        </div>
      </Section>
      <Section label="声音">
        <div className="kd-lanes-row">
          <label className="kd-lanes-check">
            <input type="checkbox" checked={Boolean(clip.muted)} onChange={event => edit([{ op: "set", id: clip.id, fields: { muted: event.target.checked } }])} />
            <span>静音</span>
          </label>
          <SettleSlider label="音量" value={clip.volume ?? 1} min={0} max={2} step={0.05} defaultValue={1} format={percent}
            onCommit={value => edit([{ op: "set", id: clip.id, fields: { volume: value } }])} />
        </div>
      </Section>
      <Section label="转场">
        <Branch clip={clip} side="in" branch={branchOf("in")} beat={beatNear(placed.at)} vj={vj} at={placed.at}
          sourceLength={project.lengths[clip.src]} onOps={edit} />
        <Branch clip={clip} side="out" branch={branchOf("out")} beat={beatNear(placed.at + placed.length)} vj={vj} at={placed.at}
          sourceLength={project.lengths[clip.src]} onOps={edit} />
      </Section>
      {vj && <Section label="校准"><AlignPanel clipId={clip.id} /></Section>}
    </div>;
  }

  if (song && songIndex !== null) {
    return <div className="kd-lanes-rows">
      <Section label="歌">
        <div className="kd-lanes-row">
          <button type="button" className="kd-lanes-action" disabled={songIndex === 0}
            onClick={() => edit([{ op: "move_song", from: songIndex, to: songIndex - 1 }])}><ArrowLeft size={14} />往前</button>
          <button type="button" className="kd-lanes-action" disabled={songIndex === songs.length - 1}
            onClick={() => edit([{ op: "move_song", from: songIndex, to: songIndex + 1 }])}><ArrowRight size={14} />往后</button>
          <button type="button" className="kd-lanes-action" onClick={() => edit([{ op: "remove_song", index: songIndex }])}><Trash2 size={14} />删掉这首歌</button>
        </div>
      </Section>
      <Section label="声音">
        <div className="kd-lanes-row">
          <SettleSlider label="音量" value={song.volume ?? 1} min={0} max={2} step={0.05} defaultValue={1} format={percent}
            onCommit={value => edit([{ op: "set_song", index: songIndex, fields: { volume: value } }])} />
        </div>
      </Section>
    </div>;
  }

  if (clips.length === 0) return null;
  // Nothing chosen: every picture of the project at once.
  return <Section label="画面">
    <div className="kd-lanes-row">
      <button type="button" className="kd-lanes-action" onClick={() => edit(clips.map(c => ({ op: "set" as const, id: c.id, fields: { fill: true } })))}>全部铺满</button>
      <button type="button" className="kd-lanes-action" onClick={() => edit(clips.map(c => ({ op: "set" as const, id: c.id, fields: { fill: false } })))}>全部完整</button>
    </div>
  </Section>;
}
