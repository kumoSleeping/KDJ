import { type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FloatingMediaResizeHandles, useFloatingMediaWindow } from "./FloatingMediaWindow";

/** Floating geometry only; the caller owns rendering, transport and picture editing. */
export function FloatingPreviewFrame({ floating, fullscreen, editing, compact, ratio, shared = false, title, children, onEscape }: {
  floating: boolean; fullscreen: boolean; editing: boolean; compact: boolean; ratio: number;
  /** The popup of the playing song: it is the floating media window, in the box the video window uses. */
  shared?: boolean; title?: string;
  children: ReactNode; onEscape(): void;
}) {
  const frame = useFloatingMediaWindow({
    shown: floating, locked: fullscreen, shared, content: { ratio },
    initial: viewport => ({ x: viewport.width - 524, y: 60, w: 512, h: 512 / ratio }),
    motion: !fullscreen, title, ghostClass: "kd-pip-float kd-viz-floating-preview",
    picture: box => box.querySelector("canvas"),
    dragExempt: target => editing && Boolean(target.closest("canvas")),
    swallowPress: true,
  });
  const detached = floating || fullscreen;
  const preview = <div ref={frame.bind} className={`kd-pip-float ${detached ? "kd-viz-floating-preview" : "kd-viz-preview"}`}
    role={detached ? "dialog" : undefined} aria-label={fullscreen ? "可视化全屏预览" : floating ? "可视化预览小窗" : undefined}
    data-fullscreen={fullscreen || undefined}
    data-empty-media={(!detached && compact) || undefined}
    data-picture-editing={editing || undefined}
    style={{ "--kd-preview-ratio": ratio, ...(floating ? { left: frame.rect.x, top: frame.rect.y, width: frame.rect.w } : {}) } as CSSProperties}
    {...frame.frameProps}
    onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onEscape(); } }}>
    <div className="kd-pip-float-stage" style={{ aspectRatio: fullscreen ? "auto" : String(ratio) }}>
      {children}
      {floating && !fullscreen && <FloatingMediaResizeHandles window={frame} name="可视化小窗" />}
    </div>
  </div>;
  return detached ? createPortal(preview, document.body) : preview;
}
