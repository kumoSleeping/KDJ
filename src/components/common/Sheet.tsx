import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SheetProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}

/**
 * 从右侧滑入的旁路面板。窄屏下用它装原本在右栏里的东西。
 *
 * 占约 70% 屏宽，左侧用轻透明遮罩；点遮罩、按 Esc、或把面板往右拖即可关闭。
 * 入场动画刻意做得很短很轻，不拖泥带水。
 */
export function Sheet({ open, title, onClose, children }: SheetProps) {
  /** 拖动时的即时位移（px，向右为正）。松手时要么归零、要么关掉。 */
  const [drag, setDrag] = useState(0);
  const startX = useRef(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setDrag(0);
  }, [open]);

  if (!open) return null;

  return (
    <div className="kd-sheet-scrim kd-pop-scrim" onClick={onClose}>
      <div
        className="kd-sheet kd-pop-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={drag > 0 ? { transform: `translateX(${drag}px)`, transition: "none", animation: "none" } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="kd-sheet-head"
          onPointerDown={(event) => {
            startX.current = event.clientX;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            // 只认往右拖：往左拖不该把面板拉得比屏还宽
            setDrag(Math.max(0, event.clientX - startX.current));
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            if (drag > 110) onClose();
            setDrag(0);
          }}
        >
          <span className="kd-sheet-title">{title}</span>
        </div>
        <div className="kd-sheet-body kd-scroll">{children}</div>
      </div>
    </div>
  );
}
