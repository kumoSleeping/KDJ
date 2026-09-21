import { RotateCcw, Square, SquareCheck, X } from "lucide-react";
import { findClip, isVisualSource, updateClip } from "../../lib/workshop";
import { useWorkshopStore } from "../../stores/workshopStore";
import type { ClipPicture } from "../../types/workshop";
import { NumberField } from "./WorkshopNumberField";

export function WorkshopCropTools() {
  const project = useWorkshopStore(s => s.draft);
  const cropId = useWorkshopStore(s => s.cropId);
  const selected = useWorkshopStore(s => s.selectedId);
  const clip = project && cropId === selected && findClip(project, cropId);
  if (!project || !clip || !isVisualSource(project.sources.find(s => s.id === clip.source_id))) return null;
  const crop = clip.picture.crop ?? [0, 0, 0, 0];
  const keepPosition = clip.picture.crop_keep_position !== false;
  const commit = () => useWorkshopStore.getState().commit();
  const change = (index: number, value: number) => {
    const state = useWorkshopStore.getState();
    if (state.draft?.id !== project.id || state.selectedId !== clip.id) return;
    state.transient(updateClip(state.draft, clip.id, current => {
      const next: NonNullable<ClipPicture["crop"]> = [...(current.picture.crop ?? [0, 0, 0, 0])];
      next[index] = value / 100;
      current.picture.crop = next;
    }));
  };
  return <div className="vj-picture-tools vj-crop-tools" role="group" aria-label="裁剪画面">
    <span className="vj-picture-scope">裁剪</span>
    <fieldset>
      {(["左", "上", "右", "下"] as const).map((label, index) => <NumberField
        key={`${project.id}:${clip.id}:${index}`} label={label} ariaLabel={`${label}侧裁剪`}
        value={crop[index] * 100} min={0} max={Math.max(0, 99 - crop[(index + 2) % 4] * 100)} step={1} suffix="%"
        onChange={value => change(index, value)} onCommit={commit}
      />)}
      <button type="button" aria-label="重置裁剪" title="重置裁剪" onClick={() => {
        commit();
        useWorkshopStore.getState().edit(p => updateClip(p, clip.id, c => { c.picture.crop = [0, 0, 0, 0]; }));
      }}><RotateCcw size={13} /></button>
    </fieldset>
    <button type="button" aria-label="保留原位置" aria-pressed={keepPosition}
      title="保留原画面的大小和位置；关闭后按裁剪区域重新居中适配"
      onClick={() => {
        commit();
        useWorkshopStore.getState().edit(p => updateClip(p, clip.id, c => { c.picture.crop_keep_position = !keepPosition; }));
      }}>{keepPosition ? <SquareCheck size={13} /> : <Square size={13} />}保留原位置</button>
    <button type="button" aria-label="关闭裁剪" title="关闭裁剪" onClick={() => {
      commit();
      useWorkshopStore.setState({cropId: null});
    }}><X size={13} /></button>
  </div>;
}
