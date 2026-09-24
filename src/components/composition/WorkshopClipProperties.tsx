import { Crop, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  adjustClip, clipDuration, clipQuantum, findClip, isImageSource, isVisualSource,
  setClipSpeed, setClipFade, updateClip, visibleFade,
} from "../../lib/workshop";
import type { CompositionProject, WorkshopClip } from "../../types/workshop";
import { NumberField } from "./WorkshopNumberField";
import { WorkshopPictureTools } from "./WorkshopPictureTools";
import { WorkshopCropTools } from "./WorkshopCropTools";
import { WorkshopSubtitleEditor } from "./WorkshopSubtitleEditor";

type PropertiesActions = {
  close(): void; seek(ms: number): void; crop(id: string): void; actions?: ReactNode;
};

export function WorkshopClipProperties(props: PropertiesActions) {
  const project = useWorkshopStore(s => s.draft);
  const selected = useWorkshopStore(s => s.selectedId);
  const clip = project ? findClip(project, selected) ?? null : null;
  if (!project || !clip || !project.sources.some(source => source.id === clip.source_id)) return null;
  return <ClipProperties key={`${project?.id}:${clip?.id}`} project={project} clip={clip} {...props} />;
}

function ClipProperties({ project, clip, close, seek, crop, actions }: PropertiesActions & {
  project: CompositionProject | null; clip: WorkshopClip | null;
}) {
  const source = project?.sources.find(s => s.id === clip?.source_id);
  const image = source ? isImageSource(source) : false, visual = isVisualSource(source);
  const available = Boolean(clip && source), audio = available && Boolean(source?.audio);
  const [subtitleEditor, setSubtitleEditor] = useState(false);
  const subtitle = clip?.picture.subtitle;
  const duration = clip ? clipDuration(clip) : 0, quantum = project && clip ? clipQuantum(project, clip) : 1;
  const fadeIn = clip ? visibleFade(clip, false) : 0, fadeOut = clip ? visibleFade(clip, true) : 0;
  const maxDuration = !clip ? 0 : image ? 21_600_000 - clip.start_ms
    : Math.min(21_600_000 - clip.start_ms, clipDuration({...clip, source_out_ms: clip.speed.domain_end_ms}));
  const transient = (transform: (p: CompositionProject) => CompositionProject) => {
    const state = useWorkshopStore.getState();
    if (project && clip && state.draft?.id === project.id && state.selectedId === clip.id) state.transient(transform(state.draft));
  };
  const change = (fn: (c: WorkshopClip) => void) => { if (clip) transient(p => updateClip(p, clip.id, fn)); };
  const commit = () => useWorkshopStore.getState().commit();
  const action = (fn: (c: WorkshopClip) => void) => {
    if (!clip) return;
    commit(); useWorkshopStore.getState().edit(p => updateClip(p, clip.id, fn));
  };
  const speed = (value: number) => change(c => setClipSpeed(c, value));
  const fade = (sound: boolean, end: boolean) => <NumberField
    label={end ? "淡出" : "淡入"} ariaLabel={`${sound ? "声音" : "画面"}${end ? "淡出" : "淡入"}`}
    value={clip && (sound ? audio : visual) ? visibleFade(clip, end, sound) / 1000 : undefined}
    min={0} max={duration / 2000} step={.01} suffix="秒"
    onChange={n => change(c => setClipFade(c, end, sound, n * 1000))} onCommit={commit} />;
  return <aside className="vj-clip-properties" aria-label="片段属性" onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); commit(); close(); }
  }}>
    {subtitleEditor && subtitle && clip && <WorkshopSubtitleEditor clipId={clip.id} initial={subtitle} close={() => setSubtitleEditor(false)} />}
    <header><strong title={source?.title}>{source?.title}</strong></header>
    <div className="vj-clip-properties-scroll">
      <fieldset className="vj-property-group" aria-label="片段时间" disabled={!available}>
        <legend>时间</legend>
        <NumberField label="开始位置" value={clip ? clip.start_ms / 1000 : undefined} min={0} max={(21_600_000-duration)/1000} step={quantum/1000} suffix="秒"
          onChange={n => { if (clip) transient(p => adjustClip(p, clip.id, "move", n*1000 - findClip(p, clip.id)!.start_ms)); }} onCommit={commit} />
        <NumberField label="片段时长" value={clip ? duration / 1000 : undefined} min={quantum/1000} max={maxDuration/1000} step={quantum/1000} suffix="秒"
          onChange={n => { if (clip) transient(p => adjustClip(p, clip.id, "out", n*1000 - clipDuration(findClip(p, clip.id)!))); }} onCommit={commit} />
        <div className="vj-property-actions">
          <button type="button" onClick={() => clip && seek(clip.start_ms)}>定位开头</button>
          <button type="button" onClick={() => clip && seek(clip.start_ms + duration)}>定位结尾</button>
          {actions}
        </div>
      </fieldset>
      <fieldset className="vj-property-group" aria-label="片段画面" disabled={!visual || !clip}>
        <legend>画面</legend>
        <WorkshopPictureTools />
        <button type="button" onClick={() => { if (clip) {commit(); crop(clip.id);} }}><Crop size={14} />定位画面</button>
        <WorkshopCropTools />
        {fade(false, false)}{fade(false, true)}
        <button type="button" aria-pressed={clip?.fades.linear ?? false} onClick={() => action(c => {c.fades.linear = !c.fades.linear;})}>线性淡化</button>
      </fieldset>
      <fieldset className="vj-property-group" aria-label="旋转与翻转" disabled={!image || !clip}>
        <legend>旋转与翻转</legend>
        <NumberField label="旋转" value={image && clip ? clip.picture.rotation ?? 0 : undefined} min={-360} max={360} step={1} suffix="°"
          onChange={n => change(c => {c.picture.rotation = n;})} onCommit={commit} />
        <div className="vj-property-actions">
          <button type="button" aria-pressed={!!clip?.picture.flip_x} onClick={() => action(c => {c.picture.flip_x = !c.picture.flip_x;})}>水平翻转</button>
          <button type="button" aria-pressed={!!clip?.picture.flip_y} onClick={() => action(c => {c.picture.flip_y = !c.picture.flip_y;})}>垂直翻转</button>
          <button type="button" aria-label="重置旋转与翻转" title="重置旋转与翻转" onClick={() => action(c => {c.picture.rotation = 0; c.picture.flip_x = false; c.picture.flip_y = false;})}><RotateCcw size={14} /></button>
        </div>
      </fieldset>
      <fieldset className="vj-property-group" aria-label="片段声音" disabled={!audio}>
        <legend>声音</legend>
        <NumberField label="音量" value={audio && clip ? clip.sound.gain * 100 : undefined} min={0} max={200} step={1} suffix="%"
          onChange={n => change(c => {c.sound.gain = n/100; c.sound.manual = true;})} onCommit={commit} />
        <button type="button" aria-pressed={clip?.sound.muted ?? false}
          onClick={() => action(c => {c.sound.muted = !c.sound.muted; c.sound.manual = true;})}>
          {clip?.sound.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}{clip?.sound.muted ? "取消静音" : "静音"}
        </button>
        {fade(true, false)}{fade(true, true)}
      </fieldset>
      <fieldset className="vj-property-group" aria-label="片段变速" disabled={!available || image}>
        <legend>变速</legend>
        <div className="vj-property-actions">{[.5,.75,1,1.25,1.5,2].map(n => <button type="button" key={n}
          aria-label={`速度 ${n} 倍`} aria-pressed={clip?.speed.preset === "constant" && clip.speed.start === n}
          onClick={() => {speed(n); commit();}}>{n}×</button>)}</div>
        <NumberField label="固定速度" value={available && !image ? clip?.speed.start : undefined} min={.5} max={2} step={.05} suffix="×" onChange={speed} onCommit={commit} />
        {available && !image && clip?.speed.preset !== "constant" && <span className="vj-property-state">{clip?.speed.preset === "ramp" ? "渐变速度" : "脉冲速度"}</span>}
      </fieldset>
      <fieldset className="vj-property-group" aria-label="字幕设置" disabled={!subtitle}>
        <legend>字幕</legend>
        <button type="button" onClick={() => {commit(); setSubtitleEditor(true);}}>文字与字体</button>
        <NumberField label="驻留时长" value={subtitle ? Math.max(0, duration - fadeIn - fadeOut) / 1000 : undefined}
          min={Math.max(0, Math.abs(fadeIn - fadeOut), quantum - fadeIn - fadeOut) / 1000}
          max={(21_600_000 - (clip?.start_ms ?? 0) - fadeIn - fadeOut) / 1000} step={.01} suffix="秒"
          onChange={n => change(c => {
            c.display_duration_ms = n * 1000 + fadeIn + fadeOut;
            c.fades = {...c.fades, offset_ms: 0, span_ms: c.display_duration_ms, video_in_ms: fadeIn, video_out_ms: fadeOut};
          })} onCommit={commit} />
      </fieldset>
    </div>
  </aside>;
}
