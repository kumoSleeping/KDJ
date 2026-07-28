import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const PAD = 8;

export interface ContextMenuProps {
  /** 视口坐标（通常来自 contextmenu 的 clientX/Y）。 */
  x: number;
  y: number;
  onClose(): void;
  children: ReactNode;
  className?: string;
}

/**
 * 全局右键/弹出菜单：挂到 document.body，fixed 定位，量完尺寸后夹进视口。
 * 点菜单外或 Esc 关闭。内容过高时靠 CSS max-height 内部滚动。
 */
export function ContextMenu({ x, y, onClose, children, className }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    setPos({ x, y });
  }, [x, y]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nextX = pos.x;
      let nextY = pos.y;
      if (nextX + rect.width > vw - PAD) nextX = vw - PAD - rect.width;
      if (nextY + rect.height > vh - PAD) nextY = vh - PAD - rect.height;
      if (nextX < PAD) nextX = PAD;
      if (nextY < PAD) nextY = PAD;
      if (Math.abs(nextX - pos.x) > 0.5 || Math.abs(nextY - pos.y) > 0.5) {
        setPos({ x: nextX, y: nextY });
      }
    };

    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    window.addEventListener("resize", clamp);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [pos.x, pos.y, children]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      className={["kd-context-menu", className].filter(Boolean).join(" ")}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
    >
      {children}
    </div>,
    document.body,
  );
}
