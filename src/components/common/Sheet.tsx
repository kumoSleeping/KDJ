import { PanelRightClose } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface SheetProps {
  open: boolean;
  title: string;
  /** 替换默认标题文案（例如详情/歌词分段）。 */
  heading?: ReactNode;
  /** 标题右侧、关闭键左侧的面板动作。 */
  tools?: ReactNode;
  onClose(): void;
  children: ReactNode;
}

/**
 * 从右侧滑入的旁路面板。窄屏下用它装原本在右栏里的东西。
 *
 * 只盖顶栏与底栏播放之间的中间区（不遮顶栏、不压播放条）。
 * 占约 70% 中间区宽，左侧用轻透明遮罩；点遮罩、按 Esc、或把面板往右拖即可关闭。
 * 入场动画刻意做得很短很轻，不拖泥带水。
 */
export function Sheet({ open, title, heading, tools, onClose, children }: SheetProps) {
  /** 拖动时的即时位移（px，向右为正）。松手时要么归零、要么关掉。 */
  const [drag, setDrag] = useState(0);
  const dragRef = useRef(0);
  const startX = useRef(0);
  /** Android 可能在同一触摸序列里补发 click；关闭动作必须幂等。 */
  const closeRequestedRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    onClose();
  }, [onClose]);
  const resetDrag = useCallback(() => {
    dragRef.current = 0;
    setDrag(0);
  }, []);
  const ownsPointer = (element: HTMLDivElement, pointerId: number): boolean => {
    try {
      return element.hasPointerCapture(pointerId);
    } catch {
      return false;
    }
  };
  const releasePointer = (element: HTMLDivElement, pointerId: number) => {
    try {
      if (ownsPointer(element, pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      // Android WebView can deliver a late pointercancel after the panel has begun unmounting.
    }
  };

  useEffect(() => {
    closeRequestedRef.current = false;
    if (!open) resetDrag();
  }, [open, resetDrag]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  if (!open) return null;

  return (
    <div className="kd-sheet-scrim kd-pop-scrim" onClick={requestClose}>
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
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // A cancelled Android pointer may no longer be capturable.
            }
          }}
          onPointerMove={(event) => {
            if (!ownsPointer(event.currentTarget, event.pointerId)) return;
            // 只认往右拖：往左拖不该把面板拉得比屏还宽
            const next = Math.max(0, event.clientX - startX.current);
            dragRef.current = next;
            setDrag(next);
          }}
          onPointerUp={(event) => {
            releasePointer(event.currentTarget, event.pointerId);
            const moved = dragRef.current;
            resetDrag();
            if (moved > 110) requestClose();
          }}
          onPointerCancel={(event) => {
            releasePointer(event.currentTarget, event.pointerId);
            resetDrag();
          }}
        >
          {heading ?? <span className="kd-sheet-title">{title}</span>}
          {tools}
          <button
            type="button"
            className="kd-sheet-close"
            aria-label="收起右侧栏"
            title="收起右侧栏"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={requestClose}
          >
            <PanelRightClose size={14} />
          </button>
        </div>
        <div className="kd-sheet-body kd-scroll">{children}</div>
      </div>
    </div>
  );
}
