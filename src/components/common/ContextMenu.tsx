import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { leaveAfterUnmount, MOTION_STAGGER_TOTAL_MS } from "../../lib/motion";

const PAD = 8;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
type MenuInput = "pointer" | "keyboard";

// Track the opening gesture before a menu mounts. WebKit can carry :focus-visible
// from a previously focused input into a programmatically focused menu button.
let lastInput: MenuInput = "keyboard";
if (typeof window !== "undefined") {
  const pointer = () => { lastInput = "pointer"; };
  const keyboard = (event: KeyboardEvent) => {
    if (!MODIFIER_KEYS.has(event.key)) lastInput = "keyboard";
  };
  window.addEventListener("pointerdown", pointer, true);
  window.addEventListener("keydown", keyboard, true);
  (import.meta as ImportMeta & { hot?: { dispose(callback: () => void): void } }).hot?.dispose(() => {
    window.removeEventListener("pointerdown", pointer, true);
    window.removeEventListener("keydown", keyboard, true);
  });
}

export interface ContextMenuProps {
  /** 视口坐标（通常来自 contextmenu 的 clientX/Y）。 */
  x: number;
  y: number;
  /** 点击控件展开时的上边缘；下方空间不足则优先在控件上方展开。 */
  anchorTop?: number;
  /** Only scrolling this anchor's ancestors invalidates its viewport position. */
  anchorElement?: HTMLElement | null;
  /** Let the trigger click toggle the menu instead of closing on pointerdown first. */
  toggleAnchor?: boolean;
  minWidth?: number;
  id?: string;
  label?: string;
  initialFocus?: "selected" | "first" | "last" | "none";
  /** Pointer-opened menus keep keyboard focus without drawing a keyboard focus ring until
   * a key is used. Omitted: infer from the latest pointer or keyboard gesture. */
  input?: "pointer" | "keyboard";
  role?: "menu" | "listbox";
  /** A menu opened from an item of another menu unfolds out of that item's side. */
  unfoldFrom?: "anchor" | "side";
  onClose(): void;
  /** 这些元素上的按下属于菜单本身（开关按钮、联动滑杆），不触发关闭。 */
  keepOpen?: string;
  children: ReactNode;
  className?: string;
}

/**
 * 右键与选择菜单共用浮层、主题、视口避让及键盘导航。
 *
 * Motion (docs/motion-schema.md): the surface unfolds out of the point it was asked for — the
 * pointer, or the anchor's corner — and its items follow. When its owner unmounts it, it folds
 * back into that point as an inert picture; the owner's action never waits for it.
 */
export function ContextMenu({ x, y, anchorTop, anchorElement, toggleAnchor = false, minWidth, id, label, onClose, keepOpen, children, className, initialFocus = "selected", input, role = "menu", unfoldFrom = "anchor" }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const search = useRef({ text: "", time: 0 });
  const [inputMode, setInputMode] = useState(input ?? lastInput);
  /** Where the menu is, and the point inside it that it unfolds from (`ox`, `oy`, in px). */
  const [pos, setPos] = useState({ x, y, ox: 0, oy: 0, up: false });
  /** True while the items follow the surface in; afterwards an added item simply appears. */
  const [opening, setOpening] = useState(true);
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
    const opened = window.setTimeout(() => setOpening(false), MOTION_STAGGER_TOTAL_MS);
    return () => {
      window.clearTimeout(opened);
      // Before the popover closes: the fold needs the menu's scroll position.
      leaveAfterUnmount(el);
      el.hidePopover?.();
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      // The layout size: the unfolding surface is scaled, and its painted box is not its size.
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nextX = Math.min(x, vw - PAD - width);
      let nextY = y;
      if (nextY + height > vh - PAD) {
        nextY = anchorTop !== undefined && anchorTop - height - 4 >= PAD
          ? anchorTop - height - 4 : vh - PAD - height;
      }
      nextX = Math.max(PAD, nextX);
      nextY = Math.max(PAD, nextY);
      // The asked-for point, seen from the menu that had to move away from it: a menu pushed
      // left or lifted above its anchor still grows out of the pointer or the anchor.
      const ox = Math.max(0, Math.min(width, x - nextX));
      const oy = Math.max(0, Math.min(height, y - nextY));
      const up = height > 0 && oy > height / 2;
      setPos(previous => Math.abs(nextX - previous.x) > 0.5 || Math.abs(nextY - previous.y) > 0.5
        || Math.abs(ox - previous.ox) > 0.5 || Math.abs(oy - previous.oy) > 0.5 || up !== previous.up
        ? { x: nextX, y: nextY, ox, oy, up } : previous);
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    window.addEventListener("resize", clamp);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", clamp);
    };
    // The observer reports every change of the menu's own size; children need no second pass.
  }, [x, y, anchorTop]);

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
      // does not move a header's menu anchor and must not dismiss that menu. A caller that
      // passes no anchor usually opened the menu from the focused element, its trigger; WebKit
      // does not focus a clicked button, and then any scroll still closes the menu.
      const anchor = anchorElement ?? (returnFocus.current === document.body ? null : returnFocus.current);
      if (anchor && event.target instanceof Node && !event.target.contains(anchor)) return;
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
      data-kd-motion="unfold"
      data-menu-input={inputMode}
      data-kd-from={unfoldFrom === "side" ? "side" : undefined}
      data-kd-stagger={opening ? (pos.up ? "up" : "down") : undefined}
      style={{ left: pos.x, top: pos.y, transformOrigin: `${pos.ox}px ${pos.oy}px`,
        minWidth: minWidth === undefined ? undefined : `min(${minWidth}px, calc(100vw - 16px))` }}
      role={role}
      aria-label={label}
      onPointerDown={event => {
        setInputMode("pointer");
        event.stopPropagation();
      }}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (!MODIFIER_KEYS.has(event.key)) setInputMode("keyboard");
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
