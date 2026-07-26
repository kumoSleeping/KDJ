import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SheetProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}

/**
 * 从底部升起的抽屉。窄屏（竖屏 / 手机）下用它装原本在左右两栏里的东西。
 *
 * 为什么是底部抽屉而不是全屏页：**列表不能丢**。DJ 找歌是"扫一眼列表 →
 * 看一眼这首的详情 → 回列表接着扫"，抽屉只盖住下半屏，上面那截列表还在，
 * 心里知道自己停在哪。换成全屏页就变成了"进去/出来"，每次都要重新找位置。
 *
 * 三种关法都给：抓着把手往下拖、点背景、按 Esc。手机上第一种最顺手，
 * 桌面窄窗口下后两种更快——不知道用户是哪种，就都留着。
 */
export function Sheet({ open, title, onClose, children }: SheetProps) {
  /** 拖动时的即时位移（px）。松手时要么归零、要么关掉。 */
  const [drag, setDrag] = useState(0);
  const startY = useRef(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 关掉时把拖动位移清零，下次打开不会带着上次的残留位置弹出来
  useEffect(() => {
    if (!open) setDrag(0);
  }, [open]);

  if (!open) return null;

  return (
    <div className="kd-sheet-scrim" onClick={onClose}>
      <div
        className="kd-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={drag > 0 ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
        // 抽屉内部的点击不能冒到背景上，否则点任何东西都会把抽屉关掉
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="kd-sheet-grab"
          onPointerDown={(event) => {
            startY.current = event.clientY;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            // 只认往下拖：往上拖不该把抽屉拉得比屏幕还高
            setDrag(Math.max(0, event.clientY - startY.current));
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            // 拖过 110px 才算"要关"。阈值太小的话，滚动列表时手指的
            // 轻微下滑会把抽屉误关掉
            if (drag > 110) onClose();
            setDrag(0);
          }}
        >
          <span className="kd-sheet-bar" aria-hidden="true" />
          <span className="kd-sheet-title">{title}</span>
        </div>
        <div className="kd-sheet-body kd-scroll">{children}</div>
      </div>
    </div>
  );
}
