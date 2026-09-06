import { useEffect } from "react";
import { finishApiActivity } from "./activityLog";
import { importFolders } from "./importFolders";
import { useToastStore } from "../stores/toastStore";
import { getBridge } from "./bridge";
import { useWorkshopStore } from "../stores/workshopStore";
import { claimActiveTrackDragIds, finishTrackDrop, isTrackDrag, readTrackDragIds } from "./trackDrag";

export interface WorkshopDropTarget { project: string | null; at: number; element: HTMLElement; }
export function workshopDropTargetAt(x: number, y: number): WorkshopDropTarget | null {
  const node = document.elementFromPoint(x, y) as HTMLElement | null;
  const root = node?.closest<HTMLElement>("[data-vj-drop]");
  if (!root) return null;
  const state = useWorkshopStore.getState();
  const task = node?.closest<HTMLElement>("[data-vj-project]");
  const project = task?.dataset.vjProject ?? state.activeId;
  const rail = node?.closest<HTMLElement>("[data-vj-time-scale]");
  const p = state.projects.find(p => p.id === project);
  const frame = 1000 / (p?.canvas.fps ?? 30);
  const at = rail ? Math.max(0, Math.round((x - rail.getBoundingClientRect().left) / Number(rail.dataset.vjTimeScale) / frame) * frame) : state.position;
  return {project, at, element: rail ?? task ?? root};
}
export function paintWorkshopDrop(x?: number, y?: number): boolean {
  document.querySelectorAll("[data-vj-drop-over]").forEach(n => n.removeAttribute("data-vj-drop-over"));
  const target = x === undefined || y === undefined ? null : workshopDropTargetAt(x, y);
  target?.element.setAttribute("data-vj-drop-over", "true");
  return Boolean(target);
}
function traceDrop(detail: string): void {
  if (import.meta.env.DEV) finishApiActivity({category: "user", action: "文件拖放诊断", detail}, {status: 200, durationMs: 0, ok: true});
}
let internalClaimedAt = -Infinity;
export function dropWorkshopTracks(x: number, y: number, ids?: number[]): boolean {
  const target = workshopDropTargetAt(x, y);
  if (!target) return false;
  const claimed = ids ?? claimActiveTrackDragIds();
  paintWorkshopDrop();
  if (!claimed.length) return true;
  finishTrackDrop(); internalClaimedAt = performance.now();
  void useWorkshopStore.getState().add([...claimed], target.at, target.project);
  return true;
}
export function useWorkshopDrop(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let consumedNative = -1;
    let hovered: {x:number;y:number;target:WorkshopDropTarget|null} | null = null;
    let alive = true, unlisten: (() => void) | undefined;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer || !(isTrackDrag(e) || Array.from(e.dataTransfer.types).includes("Files"))) return;
      if (paintWorkshopDrop(e.clientX, e.clientY)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
    };
    const drop = (e: DragEvent) => {
      if (!workshopDropTargetAt(e.clientX, e.clientY) || !e.dataTransfer) return;
      const ids = readTrackDragIds(e.dataTransfer);
      if (!ids.length && !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault(); e.stopImmediatePropagation(); paintWorkshopDrop();
      if (ids.length) dropWorkshopTracks(e.clientX, e.clientY, ids);
      // Real external paths arrive through the validated native event only.
    };
    const clear = () => { paintWorkshopDrop(); };
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", clear);
    if (!getBridge().onMediaDrop) traceDrop("原生监听不可用");
    void getBridge().onMediaDrop?.(event => {
      if (!alive) return;
      if (event.phase === "enter" || event.phase === "drop") traceDrop(`${event.phase} #${event.id} (${event.x}, ${event.y}) 文件 ${event.paths.length} 目录 ${event.folders?.length ?? 0} VJ ${Boolean(workshopDropTargetAt(event.x,event.y))} 错误 ${event.error ?? "无"}`);
      if (event.phase === "leave") { clear(); return; }
      if (event.phase !== "drop") {
        if(event.phase === "enter") internalClaimedAt=-Infinity;
        hovered={x:event.x,y:event.y,target:workshopDropTargetAt(event.x,event.y)};
        paintWorkshopDrop(event.x, event.y); return;
      }
      if(consumedNative === event.id) return;
      consumedNative=event.id;
      const target = hovered && hovered.x === event.x && hovered.y === event.y ? hovered.target : workshopDropTargetAt(event.x,event.y); clear();
      hovered=null;
      if (performance.now() - internalClaimedAt < 300) return;
      if (event.error) useToastStore.getState().show(event.error);
      if (!target) {
        // A file-only selection must never expand to its parent or scan all roots.
        void importFolders(event.folders ?? []).catch(error => useToastStore.getState().show(`导入失败：${String(error)}`));
        return;
      }
      const ids = claimActiveTrackDragIds();
      if (ids.length) {
        internalClaimedAt = performance.now();
        void useWorkshopStore.getState().add(ids, target.at, target.project);
      } else void useWorkshopStore.getState().intake([], event.paths, target.at, target.project);
    }).then(stop => { if (alive) { unlisten = stop; traceDrop("原生监听已连接"); } else stop(); }).catch(error => {if(alive) { traceDrop(`原生监听失败：${String(error)}`); useWorkshopStore.setState({error:`无法接收文件拖入：${String(error)}`}); }});
    return () => { alive = false; unlisten?.(); clear(); window.removeEventListener("dragover", over, true); window.removeEventListener("drop", drop, true); window.removeEventListener("dragend", clear); };
  }, [enabled]);
}
