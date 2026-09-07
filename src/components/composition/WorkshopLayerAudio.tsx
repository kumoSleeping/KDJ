import { useEffect, useRef } from "react";
import { Music2 } from "lucide-react";
import { cloneProject } from "../../lib/workshop";
import { useWorkshopStore } from "../../stores/workshopStore";
import type { CompositionProject, WorkshopLayer } from "../../types/workshop";

/** Track sound edits use clip sound, so preview, export and undo stay identical. */
export function WorkshopLayerAudio({ projectId, layer, title }: { projectId: string; layer: WorkshopLayer; title: string }) {
  const drag = useRef<{ y: number; base: CompositionProject; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const muted = layer.clips.every(c => c.sound.muted);
  const gains = layer.clips.map(c => Math.round(c.sound.gain * 100));
  const low = Math.min(...gains), high = Math.max(...gains);
  const patch = (base: CompositionProject, delta: number) => {
    const next = cloneProject(base);
    for (const c of next.layers.find(l => l.id === layer.id)?.clips ?? []) {
      c.sound.gain = Math.max(0, Math.min(2, Math.round(c.sound.gain * 100 + delta) / 100));
      c.sound.manual = true;
    }
    return next;
  };
  const cancel = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) { suppressClick.current = true; useWorkshopStore.getState().abort(); }
  };
  useEffect(() => cancel, [projectId, layer.id]);
  if (!layer.clips.length) return null;
  return <button type="button" className="vj-layer-audio" aria-pressed={!muted}
    aria-label={`${muted ? "开启" : "关闭"}轨道音频：${title}`}
    title="点击开启/关闭声音；上下拖动调音量；↑/↓ 微调，Shift 十倍（同时用于导出）"
    onPointerDown={e => {
      if (e.button !== 0) return;
      const state = useWorkshopStore.getState();
      if (state.gesture || state.draft?.id !== projectId) return;
      e.preventDefault(); e.stopPropagation();
      e.currentTarget.focus({ preventScroll: true });
      suppressClick.current = false;
      drag.current = { y: e.clientY, base: cloneProject(state.draft), moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e => {
      const d = drag.current;
      if (!d) return;
      const delta = Math.round(d.y - e.clientY);
      if (!d.moved && Math.abs(delta) < 3) return;
      e.stopPropagation();
      if (!d.moved) useWorkshopStore.getState().begin();
      d.moved = true;
      useWorkshopStore.getState().transient(patch(d.base, delta));
    }}
    onPointerUp={e => {
      const d = drag.current;
      drag.current = null;
      if (d?.moved) {
        suppressClick.current = true;
        useWorkshopStore.getState().commit();
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onClick={e => {
      if (suppressClick.current && e.detail !== 0) { suppressClick.current = false; return; }
      useWorkshopStore.getState().edit(p => {
        const next = cloneProject(p);
        for (const c of next.layers.find(l => l.id === layer.id)?.clips ?? []) {
          c.sound.muted = !muted;
          c.sound.manual = true;
        }
        return next;
      });
    }}
    onKeyDown={e => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault(); e.stopPropagation();
      useWorkshopStore.getState().edit(p => patch(p, (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1)));
    }}>
    <Music2 size={13}>{muted && <path d="m3 3 18 18" />}</Music2>
    <span>{low === high ? low : `${low}–${high}`}%</span>
  </button>;
}
