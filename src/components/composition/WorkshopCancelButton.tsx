import { useState } from "react";
import { CircleMinus } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import type { WorkshopJob } from "../../types/workshop";
export const canCancelExport = (job?: WorkshopJob) => Boolean(job && ["queued", "rendering", "validating"].includes(job.phase));
export function WorkshopCancelButton({ job }: { job: WorkshopJob }) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  if (!canCancelExport(job)) return null;
  return <span className="vj-cancel-export">
    <button type="button" disabled={pending} aria-label="取消这项导出" title={pending ? "正在取消" : "取消这项导出"} onClick={e => {
      e.stopPropagation(); setPending(true); setError("");
      void useWorkshopStore.getState().cancelExport(job.id).catch(e => setError(`取消失败：${String(e)}`)).finally(() => setPending(false));
    }}><CircleMinus size={14} /></button>
    {error && <span className="vj-error" role="status">{error}</span>}
  </span>;
}
