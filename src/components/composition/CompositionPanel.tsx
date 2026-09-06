import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, Ban, Check, ChevronDown, ChevronRight, Cpu, FolderOpen, GripVertical, Layers2, Music2, Plus, RotateCcw, Trash2, Video, X } from "lucide-react";
import { api } from "../../lib/api";
import { folderName } from "../../lib/format";
import { compositionDifferences, compositionEditable, compositionSegmentTimeline, compositionUsesSections, compositionSectionsTimeline, compositionSectionSummary, moveEntry, offsetLabel, seconds } from "../../lib/composition";
import { useCompositionStore } from "../../stores/compositionStore";
import type { CompositionLane, CompositionOptions, CompositionTask, OverlayOptions } from "../../types/composition";
import { Button, InlineNotice } from "../common";
import { QueueChoice, QueueCover, QueueFrame, QueueList, QueueOverview, QueueStateMark } from "../queue/QueuePrimitives";
import { OverlayPreview } from "./OverlayPreview";
import { CompositionTransport } from "./CompositionTransport";
import { CompositionTimeline } from "./CompositionTimeline";
import { getCompositionPosition, useCompositionClock } from "../../lib/compositionPlayback";
import { useLibraryStore } from "../../stores/libraryStore";

const PHASE_LABEL: Record<CompositionTask["phase"], string> = {
  waiting_pair: "待配对", pending_analysis: "待校准", analyzing: "校准中", ready: "已匹配",
  needs_review: "待确认", queued: "待开始", rendering: "合成中", validating: "校验成品",
  committing: "保存成品", importing: "加入曲库", import_failed: "已输出，入库失败", failed: "失败", canceled: "已取消",
};
const OUTPUTS = [{ value: "new_file", label: "新文件" }, { value: "overwrite", label: "覆盖原视频" }];
const LENGTHS = [{ value: "full_audio", label: "完整音频·补黑" }, { value: "keep_video", label: "保留视频·裁音频" }];
const ACCELERATION = [
  { value: "auto", label: "自动加速" }, { value: "software", label: "软件编码" },
  { value: "video_toolbox", label: "macOS 硬件" }, { value: "nvidia", label: "NVIDIA" },
  { value: "intel", label: "Intel" }, { value: "amd", label: "AMD" },
];

function OptionsControls({ options, disabled, overlay, onChange }: { options: CompositionOptions; disabled: boolean; overlay?: boolean; onChange(options: CompositionOptions): void }) {
  return <>
    <QueueChoice label="输出方式" icon={<Video size={11} />} value={options.output_mode} options={OUTPUTS} disabled={disabled}
      onChange={(value) => onChange({ ...options, output_mode: value as CompositionOptions["output_mode"] })} />
    {!overlay && <QueueChoice label="长度策略" icon={<Music2 size={11} />} value={options.length_policy} options={LENGTHS} disabled={disabled}
      onChange={(value) => onChange({ ...options, length_policy: value as CompositionOptions["length_policy"] })} />}
    {!overlay && <QueueChoice label="对齐方案" icon={<Layers2 size={11} />} value={options.alignment_mode ?? "sections"} options={[{value:"sections",label:"分段对齐"},{value:"single_offset",label:"整段定位"}]} disabled={disabled}
      onChange={(value) => onChange({ ...options, alignment_mode: value as CompositionOptions["alignment_mode"] })} />}
    <QueueChoice label="编码加速" icon={<Cpu size={11} />} value={options.acceleration} options={ACCELERATION} disabled={disabled}
      onChange={(value) => onChange({ ...options, acceleration: value as CompositionOptions["acceleration"] })} />
  </>;
}

function PairDetails({ task, markDraft }: { task: CompositionTask; markDraft(id: string, dirty: boolean): void }) {
  const patch = useCompositionStore((s) => s.patch), acting = useCompositionStore((s) => s.acting);
  const clock = useCompositionClock();
  const [options, setOptions] = useState(task.video!.options);
  const sourceDuration = task.audio_duration_ms ?? task.audio?.duration_ms ?? 0;
  const initialRange = () => ({
    position: String(((task.offset_ms ?? 0) + task.video!.options.segment.source_start_ms) / 1000),
    start: String(task.video!.options.segment.source_start_ms / 1000),
    end: String((task.video!.options.segment.source_end_ms ?? sourceDuration) / 1000),
  });
  const [range, setRange] = useState(initialRange);
  const [force, setForce] = useState(task.force_confirmed);
  const start = Math.round(Number(range.start) * 1000), end = Math.round(Number(range.end) * 1000);
  const offset = Math.round(Number(range.position) * 1000) - start;
  const validRange = Object.values(range).every((v) => v.trim() !== "" && Number.isFinite(Number(v))) && [start, end, offset].every(Number.isSafeInteger);
  const segment = { source_start_ms: start, source_end_ms: end === sourceDuration ? null : end };
  const nextOptions = { ...options, segment };
  const offsetChanged = validRange && offset !== (task.offset_ms ?? 0);
  const dirty = JSON.stringify(nextOptions) !== JSON.stringify(task.video!.options) || offsetChanged || force !== task.force_confirmed;
  const overlay = Boolean(task.audio?.is_video);
  const editable = compositionEditable(task) && !task.busy && !acting;
  const mapped = compositionUsesSections(task, options);
  const previewTask = { ...task, video: { ...task.video!, options } };
  const timeline = validRange ? mapped ? compositionSectionsTimeline(task,segment) : compositionSegmentTimeline(task.video_duration_ms ?? 0, sourceDuration, offset, !overlay && options.length_policy === "full_audio", segment) : null;
  const sourceKey = `${task.generation}:${task.offset_ms}:${JSON.stringify(task.video?.options)}:${task.force_confirmed}:${sourceDuration}`;
  const reset = () => { setOptions(task.video!.options); setRange(initialRange()); setForce(task.force_confirmed); };
  useEffect(reset, [sourceKey]);
  useEffect(() => { markDraft(task.id, dirty || !validRange); return () => markDraft(task.id, false); }, [dirty, validRange, task.id, markDraft]);
  const overlayPatch = (update: Partial<OverlayOptions>) => setOptions((old) => ({ ...old, overlay: { ...old.overlay, ...update } }));
  const audioPatch = (update: Partial<CompositionOptions["audio"]>) => setOptions((old) => ({ ...old, audio: { ...old.audio, ...update } }));
  const rangePatch = (key: keyof typeof range, value: string) => { setRange((old) => ({ ...old, [key]: value })); setForce(false); };
  return <form className="kd-composition-details" onSubmit={(event) => {
    event.preventDefault(); if (!editable || !validRange || !timeline) return;
    void patch(task, { options: nextOptions, ...(offsetChanged || task.offset_ms === null ? { offset_ms: offset } : {}), ...(force !== task.force_confirmed || offsetChanged ? { force_confirmed: force } : {}) });
  }}>
    <CompositionTransport task={task} />
    <OverlayPreview task={previewTask} offset={validRange ? offset : task.offset_ms ?? 0} segment={validRange ? segment : task.video!.options.segment} options={options.overlay} disabled={!editable} onPosition={(x, y) => overlayPatch({ x, y })} />
    {timeline && <CompositionTimeline task={previewTask} timeline={timeline} segment={segment} />}
    <fieldset className="kd-composition-section" disabled={!editable || task.video_duration_ms === null}>
      <legend>{overlay ? "叠加区间" : "音频区间"}</legend>
      {([
        ["position", "放入位置", task.video!.track_id],
        ["start", "素材入点", task.audio!.track_id],
        ["end", "素材出点", task.audio!.track_id],
      ] as const).filter(([key]) => !mapped || key !== "position").map(([key, label, trackId]) => <div className="kd-composition-config-row" key={key}>
        <label className="kd-composition-offset">{label}<input aria-label={`${label}秒`} type="number" step="0.001" min={key === "position" ? undefined : 0} value={range[key]} onChange={(e) => rangePatch(key, e.target.value)} />s</label>
        <Button variant="ghost" size="sm" disabled={!clock.ready || clock.trackId !== trackId} title="取主轨道当前播放位置" onClick={() => { const position = getCompositionPosition(trackId); if (position !== null) rangePatch(key, String(position / 1000)); }}>取当前</Button>
      </div>)}
      <div className="kd-composition-config-row">
        <Button variant="ghost" size="sm" onClick={() => { setRange((old) => ({ ...old, start: "0", end: String(sourceDuration / 1000) })); setForce(false); }}>整段素材</Button>
        <Button variant="ghost" size="sm" disabled={dirty} onClick={() => void useCompositionStore.getState().reanalyze(task)}><RotateCcw size={11} />重新校准</Button>
      </div>
      {(!task.matched || offsetChanged) && <label className="kd-composition-force"><input type="checkbox" checked={force} disabled={!timeline} onChange={(e) => setForce(e.target.checked)} />确认此区间</label>}
      {timeline && <div className="kd-composition-differences">{(mapped ? [compositionSectionSummary(task,segment)] : compositionDifferences(timeline, overlay)).map((difference) => <span key={difference}>{difference}</span>)}</div>}
      {validRange && !timeline && task.audio_duration_ms !== null && <span className="kd-composition-error" role="status">区间越界或与主视频没有重叠</span>}
    </fieldset>
    {overlay && <fieldset className="kd-composition-section" disabled={!editable}>
      <legend>画面</legend>
      <div className="kd-composition-config-row">
        <Button variant="ghost" size="sm" onClick={() => overlayPatch({ scale: 0.5, x: 0.5, y: 0.5 })}>居中 50%</Button>
        <Button variant="ghost" size="sm" onClick={() => overlayPatch({ scale: 1, x: 0.5, y: 0.5 })}>居中 100%</Button>
      </div>
      <label className="kd-composition-slider">大小 <input type="range" min={10} max={100} step={1} value={Math.round(options.overlay.scale * 100)} onChange={(e) => overlayPatch({ scale: Number(e.target.value) / 100 })} /><span>{Math.round(options.overlay.scale * 100)}%</span></label>
      <label className="kd-composition-slider">透明度 <input type="range" min={0} max={100} step={1} value={Math.round(options.overlay.opacity * 100)} onChange={(e) => overlayPatch({ opacity: Number(e.target.value) / 100 })} /><span>{Math.round(options.overlay.opacity * 100)}%</span></label>
      <label className="kd-composition-slider">画面淡化 <input type="range" min={0} max={3000} step={50} value={options.overlay.fade_ms} onChange={(e) => overlayPatch({ fade_ms: Number(e.target.value) })} /><span>{seconds(options.overlay.fade_ms)}</span></label>
    </fieldset>}
    <fieldset className="kd-composition-section" disabled={!editable}>
      <legend>输出音频</legend>
      {overlay ? <QueueChoice label="声音" icon={<Music2 size={11} />} value={options.overlay.audio} disabled={!editable} options={[{ value: "main", label: "主视频原声" }, { value: "replace_segment", label: "片段替换" }, { value: "mix", label: "叠加混音" }]} onChange={(value) => overlayPatch({ audio: value as OverlayOptions["audio"] })} />
        : <QueueChoice label="声音" icon={<Music2 size={11} />} value={options.audio.mode} disabled={!editable} options={[{ value: "replace", label: "替换音轨" }, { value: "mix", label: "混合原声" }]} onChange={(value) => audioPatch({ mode: value as CompositionOptions["audio"]["mode"] })} />}
      {(!overlay || options.overlay.audio !== "main") && <>
        <label className="kd-composition-slider">素材音量<input aria-label="素材音量" type="range" min={0} max={200} step={1} value={Math.round(options.audio.gain * 100)} onChange={(e) => audioPatch({ gain: Number(e.target.value) / 100 })} /><span>{Math.round(options.audio.gain * 100)}%</span></label>
        {(["fade_in_ms", "fade_out_ms"] as const).map((key) => <label className="kd-composition-offset" key={key}>{key === "fade_in_ms" ? "声音淡入" : "声音淡出"}<input aria-label={key === "fade_in_ms" ? "声音淡入秒" : "声音淡出秒"} type="number" min={0} max={30} step={0.1} value={options.audio[key] / 1000} onChange={(e) => audioPatch({ [key]: Math.max(0, Math.min(30000, Math.round(Number(e.target.value) * 1000))) })} />s</label>)}
      </>}
      {(overlay || options.audio.mode === "mix") && <label className="kd-composition-slider">原声音量<input aria-label="原声音量" type="range" min={0} max={200} step={1} value={Math.round(options.audio.main_gain * 100)} onChange={(e) => audioPatch({ main_gain: Number(e.target.value) / 100 })} /><span>{Math.round(options.audio.main_gain * 100)}%</span></label>}
    </fieldset>
    <fieldset className="kd-composition-section" disabled={!editable}>
      <legend>输出</legend>
      <div className="kd-composition-config-row"><OptionsControls options={options} disabled={!editable} overlay={overlay} onChange={setOptions} />
        {options.output_mode === "new_file" && <Button variant="ghost" size="sm" title={options.output_dir} onClick={() => {
          void window.kdj?.pickFolder().then((directory) => { if (directory) setOptions((current) => ({ ...current, output_dir: directory })); }).catch((e: unknown) => useCompositionStore.setState({ error: (e as Error).message }));
        }}><FolderOpen size={11} />{folderName(options.output_dir)}</Button>}
      </div>
    </fieldset>
    <div className="kd-composition-config-row kd-composition-apply">
      <Button type="submit" variant="primary" size="sm" disabled={!editable || !dirty || !validRange || !timeline}><Check size={11} />应用</Button>
      <Button variant="ghost" size="sm" disabled={!editable || (!dirty && validRange)} onClick={reset}>还原</Button>
      {(dirty || !validRange) && <span className="kd-muted">未应用</span>}
    </div>
  </form>;
}

type Drag = { lane: CompositionLane; entryId: string; x: number; y: number; moved: boolean };
export function CompositionPanel() {
  const store = useCompositionStore();
  const selectedIds = useLibraryStore((s) => s.selectedIds);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Set<string>>(() => new Set());
  const seenDetails = useRef(new Map<string, string>());
  useEffect(() => {
    // Open ordinary audio just like an overlay, including restored analysis results.
    // Defer a new result while another pair has unapplied edits. Progress updates and
    // manual collapses must not repeatedly reopen the same result.
    if (drafts.size > 0) return;
    const details = new Map(store.tasks.map((task) => [task.id,
      `${task.video?.id ?? ""}:${task.audio?.id ?? ""}:${task.offset_ms !== null}`]));
    const changed = store.tasks.filter((task) => seenDetails.current.get(task.id) !== details.get(task.id));
    const target = changed.find((task) => task.phase === "needs_review")
      ?? changed.find((task) => task.video && task.audio) ?? changed[0];
    seenDetails.current = details;
    if (target) setExpanded(target.id);
    else if (expanded && !details.has(expanded)) setExpanded(null);
  }, [store.tasks, drafts.size, expanded]);
  const markDraft = useRef((id: string, dirty: boolean) => setDrafts((previous) => {
    if (previous.has(id) === dirty) return previous;
    const next = new Set(previous); if (dirty) next.add(id); else next.delete(id); return next;
  })).current;
  const drag = useRef<Drag | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const busy = store.tasks.filter((t) => t.busy || t.released).length;
  const review = store.tasks.filter((t) => !t.busy && !t.released && t.phase === "needs_review").length;
  const pending = store.tasks.length - busy - review;
  const canStart = store.tasks.some((t) => t.video && t.audio && !t.released && (t.phase !== "needs_review" || t.force_confirmed));
  const facts = [
    { count: busy, label: "进行中", tone: "running" },
    { count: pending, label: "待开始", tone: "queued" },
    { count: review, label: "待确认", tone: "failed" },
  ].filter((f) => f.count > 0);
  const laneIds = (lane: CompositionLane) => store.tasks.filter(compositionEditable).flatMap((t) => t[lane] ? [t[lane]!.id] : []);
  const move = (lane: CompositionLane, id: string, direction: number) => {
    const ids = laneIds(lane), index = ids.indexOf(id), target = ids[index + direction];
    if (target) void store.reorder(lane, moveEntry(ids, id, target));
  };
  const dropSlot = (event: ReactPointerEvent) => document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-composition-slot]");
  const pointerMove = (event: ReactPointerEvent) => {
    const current = drag.current; if (!current) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6) current.moved = true;
    if (current.moved) { const slot = dropSlot(event); setDrop(slot?.dataset.compositionSlot ?? null); }
  };
  const pointerUp = (event: ReactPointerEvent) => {
    const current = drag.current; drag.current = null; setDrop(null); if (!current?.moved) return;
    const slot = dropSlot(event); if (!slot || slot.dataset.editable !== "true") return;
    const targetLane = slot.dataset.lane as CompositionLane;
    const targetEntry = slot.dataset.entry, taskId = slot.dataset.task!;
    if (current.lane === targetLane) {
      const ids = laneIds(targetLane);
      const next = targetEntry ? moveEntry(ids, current.entryId, targetEntry) : [...ids.filter((id) => id !== current.entryId), current.entryId];
      void store.reorder(targetLane, next);
    } else if (current.lane === "video" && targetLane === "audio") {
      setExpanded(taskId); void store.stack(current.entryId, taskId);
    }
  };
  return <QueueFrame className="kd-composition-panel">
    <section className="kd-download-prefs" aria-label="合成队列概览">
      <QueueOverview facts={facts} total={store.tasks.length} canStart={canStart && !store.acting && drafts.size === 0}
        canSecondary={!store.acting && store.tasks.length > 0} secondaryKind={busy ? "cancel" : "clear"} secondaryLabel={busy ? "取消" : "清记录"}
        startTitle={drafts.size ? "请先应用当前修改" : "开始当前完整配对；新入队项目仍等待"}
        secondaryTitle={busy ? "取消校准与当前整批合成，保留配对以便重试" : "只移除队列记录，不删除媒体"}
        onStart={() => void store.start()} onSecondary={() => void (busy ? store.cancel() : store.remove())} />
      <div className="kd-download-defaults">
        <Button variant="ghost" size="sm" disabled={store.acting || !selectedIds.length} aria-label="添加所选曲目" title="添加曲库中选中的视频或音频" onClick={() => void store.enqueue(selectedIds)}><Plus size={12} /></Button>
        <span className="kd-download-defaults-label">默认</span>
        <OptionsControls options={store.defaults} disabled={store.acting} onChange={(options) => void store.setDefaults(options)} />
        <button type="button" className="kd-download-destination" title={store.defaults.output_dir} aria-label="合成输出目录" disabled={store.acting} onClick={() => {
          void window.kdj?.pickFolder().then((dir) => { if (dir) void store.setDefaults({ ...store.defaults, output_dir: dir }); }).catch((e: unknown) => useCompositionStore.setState({ error: (e as Error).message }));
        }}><FolderOpen size={11} /><span className="kd-truncate">{folderName(store.defaults.output_dir)}</span></button>
      </div>
    </section>
    <InlineNotice text={store.error} onDismiss={store.clearError} block />
    {store.tasks.length > 0 && <div className="kd-composition-columns"><span>视频</span><span>音频 / 叠加视频</span></div>}
    <QueueList>
      {store.tasks.map((task, index) => {
        const editable = compositionEditable(task) && !store.acting;
        const active = task.busy || task.released;
        const overlay = Boolean(task.audio?.is_video);
        const state = active ? "processing" : ["failed", "import_failed", "needs_review"].includes(task.phase) ? "failed" : task.phase === "canceled" ? "canceled" : "queued";
        const open = expanded === task.id;
        return <article key={task.id} className="kd-composition-pair" data-state={state}>
          <div className="kd-composition-slots">
            {(["video", "audio"] as const).map((lane) => {
              const entry = task[lane], key = `${task.id}:${lane}`;
              const ids = laneIds(lane), position = entry ? ids.indexOf(entry.id) : -1;
              return <div key={lane} className="kd-composition-slot" data-composition-slot={key} data-lane={lane} data-task={task.id} data-entry={entry?.id} data-editable={editable}
                data-drop={drop === key || undefined}>
                {entry && <>
                  <button type="button" className="kd-composition-grip" disabled={!editable} aria-label={`拖动${lane === "video" ? "视频" : entry.is_video ? "叠加视频" : "音频"}：${entry.title}`} title="拖动排序；视频可拖到另一组右侧空槽位叠加"
                    onPointerDown={(event) => { drag.current = { lane, entryId: entry.id, x: event.clientX, y: event.clientY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
                    onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setDrop(null); }}
                    onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); move(lane, entry.id, event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical size={12} /></button>
                  <QueueCover artwork={api.coverUrl(entry.track_id)} video={entry.is_video} />
                  <div className="kd-composition-file"><span title={entry.path}>{entry.title || entry.path.split(/[\\/]/).pop()}</span><small title={entry.artist}>{entry.artist || entry.format.toUpperCase()}</small></div>
                  <div className="kd-composition-file-actions">
                    <button type="button" disabled={!editable || position <= 0} aria-label={`上移${entry.title}`} onClick={() => move(lane, entry.id, -1)}><ArrowUp size={10} /></button>
                    <button type="button" disabled={!editable || position < 0 || position === ids.length - 1} aria-label={`下移${entry.title}`} onClick={() => move(lane, entry.id, 1)}><ArrowDown size={10} /></button>
                    <button type="button" disabled={!editable || task.busy} aria-label={`移除${entry.title}`} onClick={() => void store.remove(task.id, lane)}><X size={10} /></button>
                  </div>
                </>}
              </div>;
            })}
          </div>
          <div className="kd-composition-pair-meta">
            <span className="kd-mono kd-muted">{index + 1}</span><QueueStateMark state={state} />
            <span>{task.phase === "ready" && task.force_confirmed ? "人工确认" : PHASE_LABEL[task.phase]}</span>
            {overlay && <Layers2 size={11} aria-label="视频叠加" />}
            {task.progress !== null && active && <span className="kd-mono">{Math.floor(task.progress * 100)}%</span>}
            <span className="kd-toolbar-gap" />
            {task.output_path && <Button variant="ghost" size="sm" iconOnly aria-label="定位成品" onClick={() => void window.kdj?.revealPath(task.output_path)}><FolderOpen size={11} /></Button>}
            {!active && task.video && task.audio && ["failed", "canceled", "import_failed"].includes(task.phase) && <Button variant="ghost" size="sm" iconOnly aria-label={task.phase === "import_failed" ? "重试入库" : "重试合成"} disabled={store.acting || drafts.has(task.id)} onClick={() => void store.start([task.id])}><RotateCcw size={11} /></Button>}
            <Button variant="ghost" size="sm" iconOnly aria-label={active ? "取消本组" : "移除本组"} disabled={store.acting || ["committing", "importing"].includes(task.phase)} onClick={() => void (active ? store.cancel([task.id]) : store.remove(task.id))}>{active ? <Ban size={11} /> : <Trash2 size={11} />}</Button>
            <Button variant="ghost" size="sm" className="kd-composition-details-toggle" aria-expanded={open} aria-label={open ? "收起操作面板" : "展开操作面板"} disabled={drafts.size > 0} title={drafts.size > 0 ? "先应用或还原当前修改" : undefined} onClick={() => setExpanded(open ? null : task.id)}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}操作</Button>
          </div>
          {task.video && <div className="kd-composition-output-label">{task.video.options.output_mode === "overwrite" ? "覆盖原视频" : "新文件"} · {overlay ? ({ main: "主视频原声", replace_segment: "片段替换", mix: "叠加混音" }[task.video.options.overlay.audio]) : LENGTHS.find((choice) => choice.value === task.video!.options.length_policy)?.label}{task.offset_ms !== null ? ` · ${offsetLabel(task.offset_ms)}` : ""}</div>}
          {!open && task.timeline && <div className="kd-composition-differences">{(compositionUsesSections(task) ? [compositionSectionSummary(task)] : compositionDifferences(task.timeline, overlay)).map((difference) => <span key={difference}>{difference}</span>)}</div>}
          {task.error && <div className="kd-composition-error" role="status">{task.error}</div>}
          {open && task.video && task.audio && <PairDetails task={task} markDraft={markDraft} />}
          {open && !(task.video && task.audio) && <><CompositionTransport task={task} />{task.video && <OverlayPreview task={task} offset={0} options={task.video.options.overlay} disabled onPosition={() => {}} />}</>}
        </article>;
      })}
    </QueueList>
  </QueueFrame>;
}
