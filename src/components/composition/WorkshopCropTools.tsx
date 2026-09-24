import { RotateCcw, Square, SquareCheck } from "lucide-react";
import { findClip, isVisualSource, updateClip } from "../../lib/workshop";
import { useWorkshopStore } from "../../stores/workshopStore";
import type { ClipPicture } from "../../types/workshop";
import { NumberField } from "./WorkshopNumberField";

export function WorkshopCropTools() {
  const project = useWorkshopStore(s => s.draft);
  const selected = useWorkshopStore(s => s.selectedId);
  const candidate = project && findClip(project, selected);
  const clip = candidate && isVisualSource(project?.sources.find(s => s.id === candidate.source_id)) ? candidate : null;
  const enabled = Boolean(clip);
  const crop = clip?.picture.crop ?? [0, 0, 0, 0];
  const autoFit = Boolean(clip?.picture.crop_auto_fit);
  const keepPosition = Boolean(clip) && !autoFit && clip?.picture.crop_keep_position !== false;
  const commit = () => useWorkshopStore.getState().commit();
  const change = (index: number, value: number) => {
    const state = useWorkshopStore.getState();
    if (!enabled || !project || !clip || state.draft?.id !== project.id || state.selectedId !== clip.id) return;
    state.transient(updateClip(state.draft, clip.id, current => {
      const next: NonNullable<ClipPicture["crop"]> = [...(current.picture.crop ?? [0, 0, 0, 0])];
      next[index] = value / 100;
      current.picture.crop = next;
    }));
  };
  return <fieldset className="vj-picture-tools vj-crop-tools" disabled={!enabled} aria-label="裁剪画面">
    <span className="vj-picture-scope">裁剪</span>
    <fieldset>
      {(["左", "上", "右", "下"] as const).map((label, index) => <NumberField
        key={`${project?.id}:${clip?.id}:${index}`} label={label} ariaLabel={`${label}侧裁剪`}
        value={clip ? crop[index] * 100 : undefined} min={0} max={Math.max(0, 99 - crop[(index + 2) % 4] * 100)} step={1} suffix="%"
        onChange={value => change(index, value)} onCommit={commit}
      />)}
      <button type="button" aria-label="重置裁剪" title="重置裁剪" onClick={() => {
        if (!enabled || !clip) return;
        commit();
        useWorkshopStore.getState().edit(p => updateClip(p, clip.id, c => { c.picture.crop = [0, 0, 0, 0]; }));
      }}><RotateCcw size={13} /></button>
    </fieldset>
    <button type="button" aria-label="裁剪后自适应" aria-pressed={autoFit}
      title="开启时居中并等比铺满画幅；继续裁剪时自动适配，多余边缘会超出画幅"
      onClick={() => {
        if (!enabled || !clip) return;
        commit();
        useWorkshopStore.getState().edit(p => updateClip(p, clip.id, c => {
          c.picture.crop_auto_fit = !autoFit;
          if (!autoFit) { c.picture.x = .5; c.picture.y = .5; c.picture.scale = 1; }
        }));
      }}>{autoFit ? <SquareCheck size={13} /> : <Square size={13} />}裁剪后自适应</button>
    <button type="button" aria-label="保留原位置" aria-pressed={keepPosition} disabled={autoFit}
      title="保留原画面的大小和位置；关闭后按裁剪区域重新居中适配"
      onClick={() => {
        if (!enabled || !clip) return;
        commit();
        useWorkshopStore.getState().edit(p => updateClip(p, clip.id, c => { c.picture.crop_keep_position = !keepPosition; }));
      }}>{keepPosition ? <SquareCheck size={13} /> : <Square size={13} />}保留原位置</button>
  </fieldset>;
}
