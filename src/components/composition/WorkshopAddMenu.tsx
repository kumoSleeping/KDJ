import { Clapperboard, ChevronRight, Plus } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import { enqueueLocalComposition } from "../../lib/compositionActions";

export function WorkshopAddMenu({ ids, close }: { ids(): number[]; close(): void }) {
  const projects = useWorkshopStore(s => s.projects);
  const add = (target?: string) => {
    const selected = ids(); close();
    void enqueueLocalComposition(selected, target);
  };
  if (!projects.length) return <button type="button" onClick={() => add("new")}><Clapperboard size={12} />添加到任务</button>;
  return <details className="vj-add-menu">
    <summary><Clapperboard size={12} />添加到任务<ChevronRight size={12} /></summary>
    <div>
      {projects.map(p => <button type="button" key={p.id} onClick={() => add(p.id)} title={p.name}>{p.name}</button>)}
      <button type="button" onClick={() => add("new")}><Plus size={12} />添加到新任务</button>
    </div>
  </details>;
}
