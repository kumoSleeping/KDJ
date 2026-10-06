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
  /** 点击控件展开时的上边缘；下方空间不足则优先在控件上方展开。 */
  anchorTop?: number;
  /** Only scrolling this anchor's ancestors invalidates its viewport position. */
  anchorElement?: HTMLElement;
  /** Let the trigger click toggle the menu instead of closing on pointerdown first. */
  toggleAnchor?: boolean;
  minWidth?: number;
  id?: string;
  label?: string;
  initialFocus?: "selected" | "first" | "last" | "none";
  role?: "menu" | "listbox";
  onClose(): void;
  /** 这些元素上的按下属于菜单本身（开关按钮、联动滑杆），不触发关闭。 */
  keepOpen?: string;
  children: ReactNode;
  className?: string;
}

/** 右键与选择菜单共用浮层、主题、视口避让及键盘导航。 */
export function ContextMenu({ x, y, anchorTop, anchorElement, toggleAnchor = false, minWidth, id, label, onClose, keepOpen, children, className, initialFocus = "selected", role = "menu" }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const search = useRef({ text: "", time: 0 });
  const [pos, setPos] = useState({ x, y });
  const [host] = useState(() => typeof document === "undefined" ? null
    : document.activeElement?.closest("dialog[open]") ?? document.body);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.contains(document.activeElement)) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    // Top layer also works inside modal dialogs; older WebViews keep the fixed portal.
    el.showPopover?.();
    if (initialFocus !== "none" && !el.contains(document.activeElement)) {
      const buttons = Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled)'));
      const checked = el.querySelector<HTMLElement>('button[aria-checked="true"]:not(:disabled)');
      const target = initialFocus === "last" ? buttons.at(-1) : initialFocus === "first" ? buttons[0] : checked ?? buttons[0];
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: "nearest" });
    }
    return () => { el.hidePopover?.(); };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nextX = Math.min(x, vw - PAD - rect.width);
      let nextY = y;
      if (nextY + rect.height > vh - PAD) {
        nextY = anchorTop !== undefined && anchorTop - rect.height - 4 >= PAD
          ? anchorTop - rect.height - 4 : vh - PAD - rect.height;
      }
      nextX = Math.max(PAD, nextX);
      nextY = Math.max(PAD, nextY);
      setPos(previous => Math.abs(nextX - previous.x) > 0.5 || Math.abs(nextY - previous.y) > 0.5
        ? { x: nextX, y: nextY } : previous);
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    window.addEventListener("resize", clamp);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [x, y, anchorTop, children]);

  useEffect(() => {
    const close = (event: Event) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target as Node)) return;
      if (toggleAnchor && anchorElement?.contains(target as Node)) return;
      if (keepOpen && target?.closest?.(keepOpen)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        returnFocus.current?.focus({ preventScroll: true });
        onClose();
      }
    };
    const scroll = (event: Event) => {
      // Lyrics and virtual lists scroll themselves during playback. Their scroll
      // does not move a header's menu anchor and must not dismiss that menu.
      if (anchorElement && event.target instanceof Node && !event.target.contains(anchorElement)) return;
      if (anchorTop !== undefined && !ref.current?.contains(event.target as Node)) onClose();
    };
    const resize = () => { if (anchorTop !== undefined) onClose(); };
    window.addEventListener("resize", resize);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose, keepOpen, anchorTop, anchorElement, toggleAnchor]);

  if (!host) return null;

  return createPortal(
    <div
      ref={ref}
      id={id}
      popover="manual"
      className={["kd-context-menu", className].filter(Boolean).join(" ")}
      style={{ left: pos.x, top: pos.y, minWidth: minWidth === undefined ? undefined : `min(${minWidth}px, calc(100vw - 16px))` }}
      role={role}
      aria-label={label}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          returnFocus.current?.focus({ preventScroll: true });
          onClose();
          return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        // Sliders, text inputs and nested controls retain their own keyboard behavior.
        if (!(event.target instanceof HTMLElement) || event.target.tagName !== "BUTTON"
          || (event.target.parentElement !== ref.current && !event.target.closest(".kd-panel-index-sections"))) return;
        const buttons = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled), .kd-panel-index-sections button:not(:disabled)"));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        let next: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
        else if (event.key === "ArrowUp") next = buttons[(index - 1 + buttons.length) % buttons.length];
        else if (event.key === "Home") next = buttons[0];
        else if (event.key === "End") next = buttons.at(-1);
        else if (event.key.length === 1 && event.key !== " ") {
          const now = Date.now();
          search.current.text = (now - search.current.time < 700 ? search.current.text : "") + event.key.toLocaleLowerCase();
          search.current.time = now;
          const query = [...search.current.text].every(char => char === search.current.text[0]) ? search.current.text[0] : search.current.text;
          next = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)]
            .find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(query));
          event.preventDefault();
        }
        if (next) {
          event.preventDefault();
          next.focus({ preventScroll: true });
          next.scrollIntoView?.({ block: "nearest" });
        }
      }}
    >
      {children}
    </div>,
    host,
  );
}
