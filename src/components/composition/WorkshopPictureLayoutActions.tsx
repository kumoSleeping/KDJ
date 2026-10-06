import { Expand, Shrink } from "lucide-react";
import { isVisualSource } from "../../lib/workshop";
import { layoutProjectPictures } from "../../lib/workshopPicture";
import { useWorkshopStore } from "../../stores/workshopStore";

/** Immediate commands, not a persistent global layout mode. */
export function WorkshopPictureLayoutActions() {
  const project = useWorkshopStore(s => s.draft), saving = useWorkshopStore(s => s.saving);
  const visualSources = new Set(project?.sources.filter(isVisualSource).map(s => s.id));
  const enabled = !saving && Boolean(project?.layers.some(l => l.clips.some(c => visualSources.has(c.source_id) && !c.picture.subtitle)));
  const apply = (mode: "contain" | "cover") => {
    const store = useWorkshopStore.getState();
    if (!enabled || !store.draft || store.saving) return;
    store.commit();
    store.edit(p => layoutProjectPictures(p, mode), { followImportPicture: false });
  };
  return <div className="vj-picture-layout-actions" role="group" aria-label="统一画面布局">
    <button type="button" aria-label="所有画面完整显示" title="所有画面完整显示" disabled={!enabled} onClick={() => apply("contain")}><Shrink size={15} />完整</button>
    <button type="button" aria-label="所有画面等比铺满" title="所有画面等比铺满" disabled={!enabled} onClick={() => apply("cover")}><Expand size={15} />铺满</button>
  </div>;
}
