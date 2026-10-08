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

export function WorkshopFloatingPreview({ playback, onClose, docked = false }: {
  playback: WorkshopPlayback; onClose(): void; docked?: boolean;
}) {
  const project = useWorkshopStore(s => s.draft);
  const position = useWorkshopStore(s => s.position);
  const cropId = useWorkshopStore(s => s.cropId);
  const selectedId = useWorkshopStore(s => s.selectedId);
  const [pictureEditing, setPictureEditing] = useState(false);
  const editing = docked || pictureEditing || (cropId !== null && cropId === selectedId);
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
  const previewNode = useRef<HTMLDivElement>(null);
  const [dockedWidth, setDockedWidth] = useState(0);
  useEffect(() => {
    if (!docked || fullscreen) return;
    const host = previewNode.current?.parentElement;
    if (!host) return;
    const fit = (width: number, height: number) => {
      const next = Math.max(1, Math.min(width, height * ratio));
      setDockedWidth(previous => Math.abs(previous - next) < .5 ? previous : next);
    };
    const style = getComputedStyle(host);
    fit(host.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
      host.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
    const observer = new ResizeObserver(([entry]) => fit(entry.contentRect.width, entry.contentRect.height));
    observer.observe(host);
    return () => observer.disconnect();
  }, [docked, fullscreen, ratio]);
  const drag = useRef<{ x: number; y: number; box: Box; edge?: ResizeEdge } | null>(null);
  useEffect(() => {
    const resize = () => setBox(b => fit(b));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [ratio]);
  const down = (e: PointerEvent<HTMLElement>, edge?: ResizeEdge) => {
    if (docked || e.button !== 0 || fullscreen || (!edge && (e.target as HTMLElement).closest("button,[role=button],[role=slider]"))) return;
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
  const preview = <div ref={previewNode} data-vj-drop="" data-vj-project={project.id} className="kd-pip-float vj-floating-preview" role={docked ? "region" : "dialog"} aria-label="作品预览"
    data-docked={docked || undefined} data-fullscreen={fullscreen || undefined} data-picture-editing={editing || undefined} style={docked ? !fullscreen && dockedWidth ? {width: dockedWidth, height: dockedWidth / ratio} : undefined : {left: box.x, top: box.y, width: box.width}}
    onPointerDown={e => down(e)} onPointerMove={move} onPointerUp={end}
    onPointerCancel={() => { if (drag.current) setBox(drag.current.box); end(); }} onLostPointerCapture={end}
    onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (fullscreen) setFullscreen(false); else if (!docked) onClose(); }
      else if (e.key === " " && !(e.target as HTMLElement).closest("button,[role=slider]")) {
        e.preventDefault(); e.stopPropagation(); playback.toggle();
      }
    }}>
    <div className="kd-pip-float-stage" style={{aspectRatio: fullscreen ? "auto" : String(ratio)}}>
      <WorkshopPreview playback={playback} editable={editing} />
      <FloatingVideoControls title={project.name} showTitle={!docked} playing={playback.playing} loading={playback.loading} position={position / 1000}
        duration={projectDuration(project) / 1000} fullscreen={fullscreen}
        onClose={docked ? undefined : onClose} closeLabel="关闭作品预览小窗" onToggle={playback.toggle}
        volumeChannel={playback.volumeChannel}
        onFullscreen={() => setFullscreen(v => !v)}
        extra={<>{!docked && <button type="button" aria-label="调整画面" title="调整画面" aria-pressed={editing}
          onClick={e => {
            e.stopPropagation();
            setPictureEditing(!editing);
            if (editing) useWorkshopStore.setState({cropId: null});
          }}><Move size={13} /></button>}</>} />
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
      {!docked && resizeEdges.map(edge => <span key={edge} role="button" tabIndex={edge === "se" ? 0 : -1} className="kd-pip-resize" data-edge={edge}
        aria-label={edge === "se" ? "调整预览小窗大小" : `调整预览小窗大小：${edgeLabels[edge]}`} title="拖动缩放 · 方向键微调"
        onPointerDown={e => down(e, edge)}
        onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
          e.preventDefault(); e.stopPropagation();
          setBox(b => fit({...b, width: b.width + (["ArrowRight", "ArrowUp"].includes(e.key) ? 24 : -24)}));
        }} />)}
    </div>
  </div>;
  return docked && !fullscreen ? preview : createPortal(preview, document.body);
}
