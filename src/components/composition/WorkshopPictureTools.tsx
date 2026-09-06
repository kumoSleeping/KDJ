import { Link2, RotateCcw } from "lucide-react";
import { cloneProject, findClip, isVisualSource } from "../../lib/workshop";
import { useWorkshopStore } from "../../stores/workshopStore";
import type { ClipPicture } from "../../types/workshop";
import { NumberField } from "./WorkshopNumberField";

type Layout = Pick<ClipPicture, "x" | "y" | "scale" | "opacity">;
const original: Layout = { x: .5, y: .5, scale: 1, opacity: 1 };
const layoutOf = ({ x, y, scale, opacity }: Layout): Layout => ({ x, y, scale, opacity });

export function WorkshopPictureTools() {
  const p = useWorkshopStore(s => s.draft);
  const selected = useWorkshopStore(s => s.selectedId);
  if (!p) return null;
  const clip = findClip(p, selected);
  const visual = clip && isVisualSource(p.sources.find(s => s.id === clip.source_id)) ? clip : null;
  const follows = p.canvas.import_picture !== null;
  const picture = visual?.picture ?? p.canvas.import_picture ?? original;
  const change = (patch: Partial<Layout>) => {
    const state = useWorkshopStore.getState();
    if (!state.draft || state.draft.id !== p.id) return;
    const next = cloneProject(state.draft);
    const current = visual && findClip(next, visual.id);
    const layout = { ...layoutOf(current?.picture ?? next.canvas.import_picture ?? original), ...patch };
    if (current) Object.assign(current.picture, layout);
    if (next.canvas.import_picture !== null) next.canvas.import_picture = layout;
    state.transient(next);
  };
  const commit = () => useWorkshopStore.getState().commit();
  return <div className="vj-picture-tools" role="group" aria-label="画面设置">
    <span className="vj-picture-scope">{visual ? "画面" : "新素材"}</span>
    <fieldset disabled={!visual && !follows}>
      {([
        ["scale", "大小", 10, 200],
        ["opacity", "透明度", 0, 100],
        ["x", "横向", 0, 100],
        ["y", "纵向", 0, 100],
      ] as const).map(([key, label, min, max]) => <NumberField
        key={`${p.id}:${visual?.id ?? "import"}:${key}`} label={label}
        value={picture[key] * 100} min={min} max={max} step={1} suffix="%"
        onChange={value => change({ [key]: value / 100 })} onCommit={commit}
      />)}
      <button type="button" aria-label="重置画面布局" title="居中、原始比例、完全不透明"
        onClick={() => { change(original); commit(); }}><RotateCcw size={13} /></button>
    </fieldset>
    <button type="button" className="vj-picture-follow" aria-label="沿用到新素材"
      aria-pressed={follows} title="后续导入的图片和视频沿用这组大小、透明度和位置"
      onClick={() => useWorkshopStore.getState().edit(project => {
        const next = cloneProject(project);
        next.canvas.import_picture = follows ? null : layoutOf(picture);
        return next;
      })}><Link2 size={13} /><span>沿用</span></button>
  </div>;
}
