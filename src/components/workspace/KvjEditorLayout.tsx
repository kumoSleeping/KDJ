import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeft, PanelRight, Redo2, Undo2 } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import { cloneProject, findClip } from "../../lib/workshop";
import { readLocalStorage, writeLocalStorageSoon } from "../../lib/storageWrite";
import { KvjMediaBrowser } from "./KvjMediaBrowser";
import { WorkshopExportSettings } from "../composition/WorkshopExport";
import { WorkshopPictureLayoutActions } from "../composition/WorkshopPictureLayoutActions";

const defaults = { left: 260, right: 300, timeline: 36 };
type Part = keyof typeof defaults;
function readLayout() {
  const result = { ...defaults };
  try {
    const saved: unknown = JSON.parse(readLocalStorage("kdj-kvj-layout") || "null");
    if (saved && typeof saved === "object") for (const part of Object.keys(defaults) as Part[]) {
      const value = Reflect.get(saved, part);
      if (typeof value === "number" && Number.isFinite(value)) result[part] = Math.max(part === "timeline" ? 25 : 180, Math.min(part === "timeline" ? 70 : 420, value));
    }
  } catch { /* Invalid local layout preferences do not affect projects. */ }
  return result;
}

/** Layout owns only view preferences; edits and undo remain in the workshop store. */
export function KvjEditorLayout({ preview, inspector, children, actions }: {
  preview: ReactNode; inspector: ReactNode; children: ReactNode; actions: ReactNode;
}) {
  const project = useWorkshopStore(s => s.draft), saving = useWorkshopStore(s => s.saving);
  const selected = useWorkshopStore(s => s.selectedId);
  const clip = project && findClip(project, selected);
  const source = project?.sources.find(s => s.id === clip?.source_id);
  const past = useWorkshopStore(s => s.past.length), future = useWorkshopStore(s => s.future.length);
  const [layout, setLayout] = useState(readLayout);
  const [browserOpen, setBrowserOpen] = useState(true), [inspectorOpen, setInspectorOpen] = useState(true);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ part: Part; x: number; y: number; value: number } | null>(null);
  const change = (part: Part, value: number) => setLayout(previous => {
    const next = { ...previous, [part]: Math.max(part === "timeline" ? 25 : 180, Math.min(part === "timeline" ? 70 : 420, value)) };
    writeLocalStorageSoon("kdj-kvj-layout", JSON.stringify(next));
    return next;
  });
  const separator = (part: Part) => <div className={`kd-kvj-divider kd-kvj-divider-${part}`} role="separator" tabIndex={0}
    aria-label={part === "timeline" ? "调整时间线高度" : part === "left" ? "调整素材区宽度" : "调整属性区宽度"}
    aria-orientation={part === "timeline" ? "horizontal" : "vertical"} aria-valuenow={layout[part]}
    aria-valuemin={part === "timeline" ? 25 : 180} aria-valuemax={part === "timeline" ? 70 : 420}
    onPointerDown={e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
      drag.current = { part, x: e.clientX, y: e.clientY, value: layout[part] };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e => {
      const start = drag.current;
      if (!start || start.part !== part) return;
      const delta = part === "timeline" ? (start.y - e.clientY) / Math.max(1, grid.current?.clientHeight ?? 1) * 100
        : (e.clientX - start.x) * (part === "right" ? -1 : 1);
      change(part, start.value + delta);
    }}
    onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onPointerCancel={() => { if (drag.current) change(part, drag.current.value); drag.current = null; }}
    onDoubleClick={() => change(part, defaults[part])}
    onKeyDown={e => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Home") { change(part, defaults[part]); return; }
      const positive = part === "timeline" ? e.key === "ArrowUp" : part === "right" ? e.key === "ArrowLeft" : e.key === "ArrowRight";
      change(part, layout[part] + (positive ? 1 : -1) * (part === "timeline" ? 2 : e.shiftKey ? 40 : 10));
    }} />;
  return <div className="kd-kvj-editor-layout">
    <header className="kd-kvj-editor-header">
      <button type="button" aria-label="素材浏览器" title="素材浏览器" aria-pressed={browserOpen} onClick={() => setBrowserOpen(value => !value)}><PanelLeft size={16} /></button>
      {project && <input aria-label="工程名称" value={project.name} onChange={e => {
        const store = useWorkshopStore.getState();
        if (!store.draft) return;
        const next = cloneProject(store.draft); next.name = e.target.value; store.transient(next);
      }} onBlur={() => useWorkshopStore.getState().commit()} />}
      <button type="button" aria-label="撤销" title="撤销 · ⌘/Ctrl Z" disabled={!past} onClick={() => useWorkshopStore.getState().undo()}><Undo2 size={15} /></button>
      <button type="button" aria-label="重做" title="重做 · ⌘/Ctrl Shift Z" disabled={!future} onClick={() => useWorkshopStore.getState().redo()}><Redo2 size={15} /></button>
      <WorkshopPictureLayoutActions />
      <span className="kd-kvj-save" role="status">{saving ? "保存中" : ""}</span>
      {actions}
      <button type="button" aria-label="属性检查器" title="属性检查器" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><PanelRight size={16} /></button>
    </header>
    <div ref={grid} className="kd-kvj-editor-grid" data-browser={browserOpen} data-inspector={inspectorOpen}
      style={{ "--kvj-left": `${layout.left}px`, "--kvj-right": `${layout.right}px`, "--kvj-timeline": `${layout.timeline}%` } as CSSProperties}>
      <aside className="kd-kvj-browser-pane" aria-label="素材区" hidden={!browserOpen}><KvjMediaBrowser /></aside>
      {browserOpen && separator("left")}
      <section className="kd-kvj-viewer" aria-label="剪辑预览" data-kvj-region="viewer">{preview}</section>
      {inspectorOpen && separator("right")}
      <aside className="kd-kvj-inspector" aria-label="属性检查器" data-kvj-region="inspector" hidden={!inspectorOpen}>
        {source && <header className="kd-kvj-inspector-heading"><span title={source.title}>{source.title}</span></header>}
        {inspector || (project && <WorkshopExportSettings docked />)}
      </aside>
      {separator("timeline")}
      <section className="kd-kvj-timeline-pane" aria-label="剪辑时间线" data-kvj-region="timeline">{children}</section>
    </div>
  </div>;
}
