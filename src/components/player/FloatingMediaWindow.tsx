import { useThemePack } from "../../lib/themePack";
import { raiseSurface } from "../../lib/surfaceOrder";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  FLOAT_RESIZE_EDGES,
  defaultFloatRect,
  fitFloatRect,
  resizeFloatRect,
  resolveFloatRect,
  type FloatContent,
  type FloatRect,
  type FloatResizeEdge,
  type FloatViewport,
} from "../../lib/floatingMediaBox";
import {
  floatChromeElement,
  floatingMediaMotion,
  measureFloatViewport,
  type FloatingMediaPresenter,
} from "../../lib/floatingMediaMotion";
import { useFloatingMediaBox } from "../../lib/floatingMediaStore";
import { playerBarFloor, playerBarStandsDown, usePlayerBarAway } from "../../lib/playerBarAway";
import "./FloatingMediaWindow.css";

const EDGE_LABELS: Record<FloatResizeEdge, string> = {
  n: "上边", s: "下边", e: "右边", w: "左边", ne: "右上角", nw: "左上角", se: "右下角", sw: "左下角",
};
const DRAG_EXEMPT = "button, a, input, [role=button], [role=slider], .kd-pip-resize, .kd-pip-float-scrub";

export interface FloatingMediaWindowOptions {
  /** The window is on screen as a floating box (fullscreen included: it is the same window). */
  shown: boolean;
  /** Moving and sizing are off, e.g. in fullscreen. */
  locked?: boolean;
  content: FloatContent;
  /**
   * The remembered box of the floating media window, shared with every other picture that
   * uses it, and its way in, out and through a song change. Without it the window keeps a
   * private box for as long as it is mounted and simply appears.
   */
  shared: boolean;
  /** Private box only: where it first appears. */
  initial?(viewport: FloatViewport): FloatRect;
  /** False where a transform cannot carry the picture: fullscreen, a native platform embed. */
  motion?: boolean;
  /** Which song's picture the window holds; a change while shown is a song change. */
  contentKey?: string;
  title?: string;
  /** Classes the leaving still picture needs to look like this window. */
  ghostClass?: string;
  /** The element inside the window's box whose current frame is the picture. */
  picture?(box: HTMLElement): HTMLVideoElement | HTMLCanvasElement | null;
  /** The library track whose picture this is, when the window follows the playing song. */
  song?: number | null;
  /** Presses the window must leave to its content. */
  dragExempt?(target: HTMLElement): boolean;
  /** Keep the press from reaching anything behind the window. */
  swallowPress?: boolean;
}

export interface FloatingMediaWindow {
  rect: FloatRect;
  /** Ref for the window's own box. */
  bind(element: HTMLElement | null): void;
  frameProps: {
    onPointerDown(event: PointerEvent<HTMLElement>): void;
    onPointerMove(event: PointerEvent<HTMLElement>): void;
    onPointerUp(event: PointerEvent<HTMLElement>): void;
    onPointerCancel(event: PointerEvent<HTMLElement>): void;
    onLostPointerCapture(): void;
  };
  press(event: PointerEvent<HTMLElement>, edge?: FloatResizeEdge): void;
  nudge(event: KeyboardEvent<HTMLElement>): void;
  /** Call before tearing the media down in the same turn that hides the window. */
  preserve(): void;
}

/**
 * The viewport and the bottom of the top chrome above it. Both are measured again when the
 * window comes on screen: a host that is always mounted renders before the chrome exists.
 */
function useViewport(shown: boolean): FloatViewport {
  const [viewport, setViewport] = useState<FloatViewport>(measureFloatViewport);
  useEffect(() => {
    const measure = () => setViewport(previous => {
      const next = measureFloatViewport();
      return previous.width === next.width && previous.height === next.height && previous.top === next.top
        ? previous : next;
    });
    measure();
    window.addEventListener("resize", measure);
    // A theme pack or a platform class can change the chrome's height without a window resize.
    const chrome = floatChromeElement();
    const resized = chrome && typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (chrome) resized?.observe(chrome);
    return () => {
      window.removeEventListener("resize", measure);
      resized?.disconnect();
    };
  }, [shown]);
  return viewport;
}

/**
 * Place, size, gestures and motion of a floating media window. The video window and the
 * visualizer of the playing song both use it with `shared`, so they are one window to the user:
 * moving or sizing either moves "the floating media window".
 */
export function useFloatingMediaWindow(options: FloatingMediaWindowOptions): FloatingMediaWindow {
  const { shown, shared, content } = options;
  const viewport = useViewport(shown);
  const sharedRect = useFloatingMediaBox(state => state.rect);
  const barDown = usePlayerBarAway(state => playerBarStandsDown(state.phase));
  const [privateRect, setPrivateRect] = useState<FloatRect | null>(null);
  const remembered = shared ? sharedRect : privateRect;
  // A theme pack may give the window a strip of its own above the picture (Sakura98's caption
  // bar, as padding); the box is that much taller than its picture.
  const [strip, setStrip] = useState(0);
  const packId = useThemePack(state => state.active?.id ?? null);
  const { ratio, minWidth = 0 } = content;
  const extraHeight = (content.extraHeight ?? 0) + strip;
  const rect = useMemo(() => {
    const shape = { ratio, extraHeight, minWidth };
    // Never placed: above the player bar as it stands now, or on the window's bottom while the
    // bar is put away. (The bar is measured again whenever the window comes on screen and when
    // the bar goes or comes; a host that is always mounted renders before the bar exists.)
    const base = remembered ?? (shared ? null : options.initial?.(viewport))
      ?? defaultFloatRect(viewport, playerBarFloor());
    return resolveFloatRect(base, viewport, shape);
    // `initial` only seeds a box that has never been placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remembered, shared, shown, viewport, ratio, extraHeight, minWidth, barDown]);

  const live = useRef({ rect, viewport, content, remembered, options });
  live.current = { rect, viewport, content, remembered, options };
  const place = (next: FloatRect | null) => {
    if (live.current.options.shared) useFloatingMediaBox.getState().place(next);
    else setPrivateRect(next);
  };
  const remember = () => {
    if (live.current.options.shared) useFloatingMediaBox.getState().remember();
  };

  const element = useRef<HTMLElement | null>(null);
  const bind = useRef((node: HTMLElement | null) => { element.current = node; }).current;
  const locked = Boolean(options.locked);
  useLayoutEffect(() => {
    const node = element.current;
    const style = shown && !locked && node ? node.ownerDocument.defaultView?.getComputedStyle(node) : null;
    const next = style ? Math.round(parseFloat(style.paddingTop) || 0) : 0;
    setStrip(current => current === next ? current : next);
  }, [shown, locked, packId]);
  const presenter = useRef<FloatingMediaPresenter | null>(null);
  if (!presenter.current) {
    const self: FloatingMediaPresenter = {
      element: null, rect, animate: false, ghostClass: "kd-pip-float", title: "", song: null,
      // `element` is the box that was shown, kept even after React detached it.
      picture: () => (self.element && live.current.options.picture?.(self.element)) || null,
    };
    presenter.current = self;
  }
  const presented = useRef({ shown: false, key: "" });
  // Every commit: the presenter describes the window as it is on screen, and a change of
  // presence or song is handed to the choreography before the browser paints it.
  useLayoutEffect(() => {
    const self = presenter.current!;
    const now = shared && shown && Boolean(element.current);
    const key = options.contentKey ?? "";
    const was = presented.current;
    if (now) {
      self.rect = rect;
      self.animate = options.motion !== false;
      self.ghostClass = options.ghostClass ?? "kd-pip-float";
      self.title = options.title ?? "";
      self.song = options.song ?? null;
    }
    if (now && !was.shown) {
      self.element = element.current;
      // A window that has just come out is in front of the other floating surfaces.
      raiseSurface(element.current);
      floatingMediaMotion.show(self, key);
    } else if (!now && was.shown) {
      floatingMediaMotion.hide(self);
    } else if (now && was.key !== key) {
      self.element = element.current;
      floatingMediaMotion.swap(self, key);
    } else if (now) {
      self.element = element.current;
    }
    presented.current = { shown: now, key };
  });
  useLayoutEffect(() => () => {
    // Unmounting: the picture is still in the document here, so it can be copied.
    if (!presented.current.shown) return;
    presented.current = { shown: false, key: "" };
    floatingMediaMotion.hide(presenter.current!);
  }, []);

  const gesture = useRef<{
    pointerId: number; x: number; y: number; rect: FloatRect; edge?: FloatResizeEdge;
    before: FloatRect | null; moved: boolean;
  } | null>(null);
  const press = (event: PointerEvent<HTMLElement>, edge?: FloatResizeEdge) => {
    const { options: current, rect: at, remembered: before } = live.current;
    if (!current.shown || current.locked || event.button !== 0 || !event.isPrimary) return;
    const target = event.target as HTMLElement;
    // Touching the window brings it in front of the drawer's panel.
    raiseSurface(element.current);
    if (!edge && (target.closest(DRAG_EXEMPT) || current.dragExempt?.(target))) return;
    if (edge || current.swallowPress) { event.preventDefault(); event.stopPropagation(); }
    // The hand takes the window from wherever a motion had it.
    if (current.shared) floatingMediaMotion.settle();
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: at, edge, before, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!start.moved && dx === 0 && dy === 0) return;
    start.moved = true;
    const { viewport: bounds, content: shape } = live.current;
    place(start.edge
      ? resizeFloatRect(start.rect, start.edge, dx, dy, bounds, shape)
      : fitFloatRect({ ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy }, bounds, shape));
  };
  const finish = (commit: boolean) => {
    const start = gesture.current;
    gesture.current = null;
    if (!start?.moved) return;
    if (commit) remember();
    else place(start.before);
  };
  const release = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    finish(commit);
    // The handle that took the capture may be the target rather than the frame.
    for (const node of [event.target as HTMLElement, event.currentTarget]) {
      try { if (node.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    }
  };
  const nudge = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const { options: current, rect: at, viewport: bounds, content: shape } = live.current;
    if (!current.shown || current.locked) return;
    event.preventDefault(); event.stopPropagation();
    if (current.shared) floatingMediaMotion.settle();
    place(resizeFloatRect(at, "se", ["ArrowRight", "ArrowUp"].includes(event.key) ? 24 : -24, 0, bounds, shape));
    remember();
  };

  return {
    rect,
    bind,
    frameProps: {
      onPointerDown: event => press(event),
      onPointerMove: move,
      onPointerUp: event => release(event, true),
      onPointerCancel: event => release(event, false),
      // The capture can be taken away without an up or a cancel; what was dragged so far stands.
      onLostPointerCapture: () => finish(true),
    },
    press,
    nudge,
    preserve: () => { if (presented.current.shown) floatingMediaMotion.preserve(presenter.current!); },
  };
}

/** The eight sizing handles, shared so every floating media window sizes the same way. */
export function FloatingMediaResizeHandles({ window: target, name, edges = FLOAT_RESIZE_EDGES }: {
  window: FloatingMediaWindow; name: string; edges?: readonly FloatResizeEdge[];
}) {
  return <>{edges.map(edge => <span key={edge} className="kd-pip-resize" data-edge={edge}
    role="button" tabIndex={edge === "se" ? 0 : -1} aria-label={`调整${name}大小：${EDGE_LABELS[edge]}`} title="拖动缩放 · 方向键微调"
    onPointerDown={event => target.press(event, edge)} onKeyDown={target.nudge} />)}</>;
}
