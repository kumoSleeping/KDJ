import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Move } from "lucide-react";
import { FloatingVideoControls, FloatingVideoScrub } from "../player/FloatingVideoControls";
import { useWorkshopStore } from "../../stores/workshopStore";
import { projectDuration } from "../../lib/workshop";
import type { WorkshopPlayback } from "../../lib/workshopPlayback";
import { WorkshopPreview } from "./WorkshopPreview";

type Box = { x: number; y: number; width: number };
const resizeEdges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type ResizeEdge = typeof resizeEdges[number];
const edgeLabels: Record<ResizeEdge, string> = { n: "上边", s: "下边", e: "右边", w: "左边", ne: "右上角", nw: "左上角", se: "右下角", sw: "左下角" };

export function WorkshopFloatingPreview({ playback, onClose }: {
  playback: WorkshopPlayback; onClose(): void;
}) {
  const project = useWorkshopStore(s => s.draft);
  const position = useWorkshopStore(s => s.position);
  const cropId = useWorkshopStore(s => s.cropId);
  const [pictureEditing, setPictureEditing] = useState(false);
  const editing = pictureEditing || cropId !== null;
  const ratio = project ? project.canvas.width / project.canvas.height : 16 / 9;
  const fit = (box: Box): Box => {
    const maximum = Math.max(1, Math.min(window.innerWidth - 24, (window.innerHeight - 24) * ratio));
    const width = Math.min(maximum, Math.max(Math.min(256, maximum), box.width));
    return { width,
      x: Math.max(12, Math.min(window.innerWidth - width - 12, box.x)),
      y: Math.max(12, Math.min(window.innerHeight - width / ratio - 12, box.y)),
    };
  };
  const [box, setBox] = useState(() => {
    const width = fit({width: Math.min(512, window.innerWidth * .34), x: 0, y: 12}).width;
    return fit({width, x: window.innerWidth - width - 12, y: 12});
  });
  const [fullscreen, setFullscreen] = useState(false);
  const drag = useRef<{ x: number; y: number; box: Box; edge?: ResizeEdge } | null>(null);
  useEffect(() => {
    const resize = () => setBox(b => fit(b));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [ratio]);
  const down = (e: PointerEvent<HTMLElement>, edge?: ResizeEdge) => {
    if (e.button !== 0 || fullscreen || (!edge && (e.target as HTMLElement).closest("button,[role=button],[role=slider]"))) return;
    e.preventDefault(); e.stopPropagation();
    drag.current = {x: e.clientX, y: e.clientY, box, edge};
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.edge) {
      setBox(fit({...d.box, x: d.box.x + dx, y: d.box.y + dy}));
      return;
    }
    const horizontal = d.edge.includes("e") ? dx : d.edge.includes("w") ? -dx : 0;
    const vertical = (d.edge.includes("s") ? dy : d.edge.includes("n") ? -dy : 0) * ratio;
    const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
    const width = fit({...d.box, width: d.box.width + delta}).width;
    setBox(fit({width,
      x: d.box.x + (d.edge.includes("w") ? d.box.width - width : 0),
      y: d.box.y + (d.edge.includes("n") ? (d.box.width - width) / ratio : 0),
    }));
  };
  const end = () => { drag.current = null; };
  const scrubbing = useRef(false);
  const latestPlayback = useRef(playback);
  latestPlayback.current = playback;
  const finishScrub = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    useWorkshopStore.setState({scrubbing: false});
    latestPlayback.current.endScrub();
  };
  useEffect(() => () => finishScrub(), []);
  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && project) playback.seek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * projectDuration(project));
  };
  if (!project) return null;
  const preview = <div data-vj-drop="" data-vj-project={project.id} className="kd-pip-float vj-floating-preview" role="dialog" aria-label="作品预览小窗"
    data-fullscreen={fullscreen || undefined} data-picture-editing={editing || undefined} style={{left: box.x, top: box.y, width: box.width}}
    onPointerDown={e => down(e)} onPointerMove={move} onPointerUp={end}
    onPointerCancel={() => { if (drag.current) setBox(drag.current.box); end(); }} onLostPointerCapture={end}
    onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (fullscreen) setFullscreen(false); else onClose(); }
      else if (e.key === " " && !(e.target as HTMLElement).closest("button,[role=slider]")) {
        e.preventDefault(); e.stopPropagation(); playback.toggle();
      }
    }}>
    <div className="kd-pip-float-stage" style={{aspectRatio: fullscreen ? "auto" : String(ratio)}}>
      <WorkshopPreview playback={playback} editable={editing} />
      <FloatingVideoControls title={project.name} playing={playback.playing} position={position / 1000}
        duration={projectDuration(project) / 1000} fullscreen={fullscreen}
        onClose={onClose} closeLabel="关闭作品预览小窗" onToggle={playback.toggle}
        onFullscreen={() => setFullscreen(v => !v)}
        extra={<button type="button" aria-label="调整画面" title="调整画面" aria-pressed={editing}
          onClick={e => {
            e.stopPropagation();
            setPictureEditing(!editing);
            if (editing) useWorkshopStore.setState({cropId: null});
          }}><Move size={13} /></button>} />
      <FloatingVideoScrub position={position / 1000} duration={projectDuration(project) / 1000}
        onPointerDown={e => { if (e.button !== 0) return; e.stopPropagation(); scrubbing.current = true; useWorkshopStore.setState({scrubbing: true}); playback.beginScrub(); e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
        onPointerMove={e => { if (scrubbing.current) scrub(e); }}
        onPointerUp={e => { if (!scrubbing.current) return; scrub(e); finishScrub(); e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={finishScrub} onLostPointerCapture={finishScrub}
        onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault(); e.stopPropagation();
          playback.seek(e.key === "Home" ? 0 : e.key === "End" ? projectDuration(project) : position + (e.key === "ArrowRight" ? 5000 : -5000));
        }} />
      {resizeEdges.map(edge => <span key={edge} role="button" tabIndex={edge === "se" ? 0 : -1} className="kd-pip-resize" data-edge={edge}
        aria-label={edge === "se" ? "调整预览小窗大小" : `调整预览小窗大小：${edgeLabels[edge]}`} title="拖动缩放 · 方向键微调"
        onPointerDown={e => down(e, edge)}
        onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
          e.preventDefault(); e.stopPropagation();
          setBox(b => fit({...b, width: b.width + (["ArrowRight", "ArrowUp"].includes(e.key) ? 24 : -24)}));
        }} />)}
    </div>
  </div>;
  return createPortal(preview, document.body);
}
