import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { Check } from "lucide-react";
import {
  LYRICS_EXTENT_LABEL,
  lyricsExtentChoices,
  shownLyricsExtent,
  useLyricsExtent,
  useLyricsExtentShape,
} from "../../lib/lyricsExtent";
import { ContextMenu } from "../common/ContextMenu";
import { resetDrawerHeight } from "../drawer/Drawer";

/** A finger held still this long asks for the menu, as a right click does (HarmonicList). */
const LONG_PRESS_MS = 480;
/** Further than this and the finger is scrolling. */
const LONG_PRESS_SLOP = 8;

/**
 * The menu of the lyrics panel: how tall the lyrics are (lib/lyricsExtent.ts). It opens on a
 * right click or a long press anywhere on the panel; `props` go on the panel's element.
 * `buttonProps`/`openFrom` offer the same menu from its player key, anchored above it when
 * needed; render `menu` alongside either trigger. The current choice carries a check mark. A
 * window that offers no choice (an upright phone) has no menu.
 */
export function useLyricsExtentMenu(identity?: string | number | null) {
  const stored = useLyricsExtent(state => state.extent);
  const shape = useLyricsExtentShape();
  const choices = lyricsExtentChoices(shape);
  const shown = shownLyricsExtent(stored, shape);
  const [at, setAt] = useState<{ x: number; y: number; anchorTop?: number; anchorElement?: HTMLElement; input: "pointer" | "keyboard" } | null>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** The click that ends a long press is not a click on the line under the finger. */
  const swallowClick = useRef(0);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancelPress, []);
  useEffect(() => { setAt(null); cancelPress(); }, [identity]);
  const offered = choices.length > 1;
  const openFrom = useCallback((anchor: HTMLElement, input: "pointer" | "keyboard" = "pointer") => {
    anchor.focus({ preventScroll: true });
    const box = anchor.getBoundingClientRect();
    setAt({ x: box.left, y: box.bottom + 4, anchorTop: box.top, anchorElement: anchor, input });
  }, []);
  // Events of a menu drawn elsewhere (the source picker's) reach here through React's tree.
  const inside = (event: { currentTarget: HTMLElement; target: EventTarget }) =>
    event.target instanceof Node && event.currentTarget.contains(event.target);
  const props = offered ? {
      onContextMenu(event: MouseEvent<HTMLElement>) {
        if (!inside(event)) return;
        event.preventDefault();
        cancelPress();
        // From the keyboard there is no pointer: the menu hangs from the panel's middle.
        const box = event.currentTarget.getBoundingClientRect();
        const keyed = event.clientX === 0 && event.clientY === 0;
        setAt(keyed ? { x: box.left + box.width / 2, y: box.top + box.height / 2, input: "keyboard" }
          : { x: event.clientX, y: event.clientY, input: "pointer" });
      },
      // A right click asks for the menu; it does not move the focus to the line under it. Nor
      // does the mouse press a browser makes up when the finger of a long press lifts: the
      // focus stays in the menu that has just opened, where Esc belongs to the menu.
      onMouseDown(event: MouseEvent<HTMLElement>) {
        if (!inside(event)) return;
        if (event.button === 2 || performance.now() <= swallowClick.current) event.preventDefault();
      },
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.pointerType === "mouse" || !inside(event)) return;
        cancelPress();
        const { clientX: x, clientY: y } = event;
        press.current = {
          x, y,
          timer: window.setTimeout(() => {
            press.current = null;
            swallowClick.current = performance.now() + 700;
            setAt({ x, y, input: "pointer" });
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const held = press.current;
        if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > LONG_PRESS_SLOP) cancelPress();
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      onPointerLeave: cancelPress,
      onClickCapture(event: MouseEvent<HTMLElement>) {
        if (performance.now() > swallowClick.current) return;
        swallowClick.current = 0;
        event.preventDefault();
        event.stopPropagation();
      },
    } : {};
  return {
    props,
    openFrom: offered ? openFrom : undefined,
    opened: !!at && offered,
    buttonProps: {
      ...props,
      "aria-haspopup": offered ? "menu" as const : undefined,
      "aria-expanded": offered ? !!at : undefined,
      onContextMenu: offered ? (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        cancelPress();
        openFrom(event.currentTarget, event.clientX === 0 && event.clientY === 0 ? "keyboard" : "pointer");
      } : undefined,
      onKeyDown: offered ? (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        openFrom(event.currentTarget, "keyboard");
      } : undefined,
    },
    menu: at && offered ? <ContextMenu {...at} label="歌词高度" onClose={() => setAt(null)}>
      <div className="kd-menu-heading" role="presentation">歌词高度</div>
      {choices.map(choice => <button key={choice} type="button" role="menuitemradio" aria-checked={shown === choice}
        onClick={() => {
          setAt(null);
          // The item that is checked already keeps what is stored: in a wide window that may be
          // full screen, shown as 更长, and it is still there when the window is tall again.
          if (choice !== shown) useLyricsExtent.getState().setExtent(choice);
          // A height dragged earlier would keep the choice from showing.
          resetDrawerHeight();
        }}>
        <span className="kd-menu-check" aria-hidden="true">{shown === choice && <Check size={13} />}</span>
        <span className="kd-menu-label">{LYRICS_EXTENT_LABEL[choice]}</span>
      </button>)}
    </ContextMenu> : null,
  };
}
