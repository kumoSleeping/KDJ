import { Crop, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import type { ReactNode } from "react";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  adjustClip, clipDuration, clipQuantum, findClip, isImageSource, isVisualSource,
  setClipSpeed, setClipFade, updateClip, visibleFade,
} from "../../lib/workshop";
import type { CompositionProject, WorkshopClip } from "../../types/workshop";
import { NumberField } from "./WorkshopNumberField";
import { WorkshopPictureTools } from "./WorkshopPictureTools";
import { WorkshopCropTools } from "./WorkshopCropTools";

export function WorkshopClipProperties({ close, seek, crop, actions }: {
  close(): void; seek(ms: number): void; crop(id: string): void; actions?: ReactNode;
}) {
  const project = useWorkshopStore(s => s.draft);
  const selected = useWorkshopStore(s => s.selectedId);
  const clip = project && findClip(project, selected);
  const source = clip && project?.sources.find(s => s.id === clip.source_id);
  if (!project || !clip || !source) return null;
  return <ClipProperties key={`${project.id}:${clip.id}`} project={project} clip={clip}
    close={close} seek={seek} crop={crop} actions={actions} />;
}

function ClipProperties({ project, clip, close, seek, crop, actions }: {
  project: CompositionProject; clip: WorkshopClip;
  close(): void; seek(ms: number): void; crop(id: string): void; actions?: ReactNode;
}) {
  const source = project.sources.find(s => s.id === clip.source_id)!;
  const image = isImageSource(source), visual = isVisualSource(source);
  const duration = clipDuration(clip), quantum = clipQuantum(project, clip);
  const maxDuration = image ? 21_600_000 - clip.start_ms
    : Math.min(21_600_000 - clip.start_ms, clipDuration({...clip, source_out_ms: clip.speed.domain_end_ms}));
  const transient = (transform: (p: CompositionProject) => CompositionProject) => {
    const state = useWorkshopStore.getState();
    if (state.draft?.id === project.id && state.selectedId === clip.id) state.transient(transform(state.draft));
  };
  const change = (fn: (c: WorkshopClip) => void) => transient(p => updateClip(p, clip.id, fn));
  const commit = () => useWorkshopStore.getState().commit();
  const action = (fn: (c: WorkshopClip) => void) => { commit(); useWorkshopStore.getState().edit(p => updateClip(p, clip.id, fn)); };
  const speed = (value: number) => change(c => setClipSpeed(c, value));
  const fade = (audio: boolean, end: boolean) => <NumberField
    label={end ? "淡出" : "淡入"} ariaLabel={`${audio ? "声音" : "画面"}${end ? "淡出" : "淡入"}`}
    value={visibleFade(clip, end, audio) / 1000} min={0} max={duration / 2000} step={.01} suffix="秒"
    onChange={n => change(c => setClipFade(c, end, audio, n * 1000))} onCommit={commit} />;
  return <aside className="vj-clip-properties" aria-label="片段属性" onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); commit(); close(); }
  }}>
    <header><strong title={source.title}>{source.title}</strong>
      <button type="button" aria-label="收起片段属性" title="收起片段属性" onClick={() => {commit(); close();}}><X size={15} /></button>
    </header>
    <div className="vj-clip-properties-scroll">
      <section aria-label="片段时间"><h3>时间</h3>
        <NumberField label="开始位置" value={clip.start_ms / 1000} min={0} max={(21_600_000-duration)/1000} step={quantum/1000} suffix="秒"
          onChange={n => transient(p => adjustClip(p, clip.id, "move", n*1000 - findClip(p, clip.id)!.start_ms))} onCommit={commit} />
        <NumberField label="片段时长" value={duration / 1000} min={quantum/1000} max={maxDuration/1000} step={quantum/1000} suffix="秒"
          onChange={n => transient(p => adjustClip(p, clip.id, "out", n*1000 - clipDuration(findClip(p, clip.id)!)))} onCommit={commit} />
        <div className="vj-property-actions">
          <button type="button" onClick={() => seek(clip.start_ms)}>定位开头</button>
          <button type="button" onClick={() => seek(clip.start_ms + duration)}>定位结尾</button>
        </div>
        {actions && <div className="vj-property-actions">{actions}</div>}
      </section>
      {visual && <section aria-label="片段画面"><h3>画面</h3>
        <WorkshopPictureTools />
        <div className="vj-property-actions"><button type="button" onClick={() => {commit(); crop(clip.id);}}><Crop size={14} />裁剪画面</button></div>
        <WorkshopCropTools />
        <details><summary>画面淡入淡出</summary>{fade(false, false)}{fade(false, true)}</details>
        {image && <details><summary>旋转与翻转</summary>
          <NumberField label="旋转" value={clip.picture.rotation ?? 0} min={-360} max={360} step={1} suffix="°"
            onChange={n => change(c => {c.picture.rotation = n;})} onCommit={commit} />
          <div className="vj-property-actions">
            <button type="button" aria-pressed={!!clip.picture.flip_x} onClick={() => action(c => {c.picture.flip_x = !c.picture.flip_x;})}>水平翻转</button>
            <button type="button" aria-pressed={!!clip.picture.flip_y} onClick={() => action(c => {c.picture.flip_y = !c.picture.flip_y;})}>垂直翻转</button>
            <button type="button" aria-label="重置旋转与翻转" title="重置旋转与翻转" onClick={() => action(c => {c.picture.rotation = 0; c.picture.flip_x = false; c.picture.flip_y = false;})}><RotateCcw size={14} /></button>
          </div>
        </details>}
      </section>}
      {source.audio && <section aria-label="片段声音"><h3>声音</h3>
        <NumberField label="音量" value={clip.sound.gain * 100} min={0} max={200} step={1} suffix="%"
          onChange={n => change(c => {c.sound.gain = n/100; c.sound.manual = true;})} onCommit={commit} />
        <div className="vj-property-actions"><button type="button" aria-pressed={clip.sound.muted}
          onClick={() => action(c => {c.sound.muted = !c.sound.muted; c.sound.manual = true;})}>
          {clip.sound.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}{clip.sound.muted ? "取消静音" : "静音"}
        </button></div>
        {fade(true, false)}{fade(true, true)}
      </section>}
      {!image && <section aria-label="片段变速"><h3>变速</h3>
        <div className="vj-property-actions">{[.5,.75,1,1.25,1.5,2].map(n => <button type="button" key={n}
          aria-label={`速度 ${n} 倍`} aria-pressed={clip.speed.preset === "constant" && clip.speed.start === n}
          onClick={() => {speed(n); commit();}}>{n}×</button>)}</div>
        <NumberField label="固定速度" value={clip.speed.start} min={.5} max={2} step={.05} suffix="×" onChange={speed} onCommit={commit} />
        {clip.speed.preset !== "constant" && <span className="vj-property-state">{clip.speed.preset === "ramp" ? "渐变速度" : "脉冲速度"}</span>}
      </section>}
    </div>
  </aside>;
}
