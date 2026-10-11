import { createContext, startTransition, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type Ref } from "react";
import { ChevronsRight, Minimize2 } from "lucide-react";
import { TitleTabs } from "./TitleTabs";
import { useSurfaceBackdrop } from "../common/SurfaceBackdrop";
import { createPortal } from "react-dom";
import { MOTION_IN_MS, MOTION_OUT_MS, MOTION_REDUCED_MS, prefersReducedMotion } from "../../lib/motion";
import { SONG_SWAP_IN_EASE, SONG_SWAP_OUT_EASE } from "../../lib/songSwapMotion";
import { readLocalStorage, removeLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import { raiseSurface } from "../../lib/surfaceOrder";
import { useWindowTaken } from "../../lib/windowTaken";
import type { DrawerEntry, DrawerSpec } from "./drawerSchema";
import "./Drawer.css";

/** The slide in; a panel is at rest once it is over. */
const ENTER_MS = 400;
/** The slide back out; a panel that was put away stays mounted this long. */
const LEAVE_MS = 260;
/** Fallback for a body with no measure; explicit pending content is allowed to finish first. */
const HOLD_MS = 120;
const HEIGHT_KEY = "kd-drawer-height";
const MIN_HEIGHT = 180;

const heightResets = new Set<() => void>();
/**
 * Gives the panel's height back to the app's own extent, as a double click on its bottom edge
 * does. For an app whose extent the listener chooses elsewhere (the lyrics' menu): a height that
 * was dragged earlier would otherwise keep that choice from showing.
 */
export function resetDrawerHeight(): void {
  for (const reset of heightResets) reset();
}

const DrawerContext = createContext<string | null>(null);
/** The id of the drawer a component is shown in, or null outside one. */
export function useDrawer(): string | null { return useContext(DrawerContext); }

/**
 * The height at which everything in `body` fits without scrolling: the sheet's height now, plus
 * what its scrolling part lacks or minus what it has to spare. A scrolling part inside another
 * (a list in a pane that fills a scrolling wrapper) is added to the one around it, since either
 * may be the one that takes up the slack; of parts side by side the neediest decides. Null when
 * nothing in the body scrolls, which says nothing about what it needs, and while the body says
 * it is still waiting for what decides its height (`data-drawer-pending`).
 */
function fittingHeight(sheet: HTMLElement, body: HTMLElement): number | null {
  if (pendingBody(body)) return null;
  // A part that is squeezed to nothing still counts; one that is not drawn at all (a page that
  // is kept but hidden) does not, nor does the still copy of a page that is sliding out: the
  // height follows the page that arrives from the moment the switch starts.
  const scrollers = [body, ...body.querySelectorAll<HTMLElement>(".kd-scroll, [data-drawer-scroll]")].filter(node => {
    const overflow = getComputedStyle(node).overflowY;
    return overflow !== "visible" && overflow !== "hidden" && overflow !== "clip" && node.getClientRects().length > 0
      && !node.closest(".kd-slide-ghost");
  });
  if (!scrollers.length) return null;
  const range = document.createRange();
  const lacks = scrollers.map(node => {
    range.selectNodeContents(node);
    const style = getComputedStyle(node);
    const content = range.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return content - (node.getBoundingClientRect().height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth));
  });
  let lack = -Infinity;
  scrollers.forEach(node => {
    if (scrollers.some(other => other !== node && node.contains(other))) return;
    lack = Math.max(lack, scrollers.reduce((sum, around, at) => around.contains(node) ? sum + lacks[at] : sum, 0));
  });
  // Whole pixels, rounded up so that nothing is left to scroll; the margin absorbs float noise.
  return Math.ceil(sheet.getBoundingClientRect().height + lack - 0.05);
}

/** A leaving page's still copy cannot keep the new page waiting. */
function pendingBody(body: HTMLElement): boolean {
  return [...body.querySelectorAll("[data-drawer-pending]")].some(node => !node.closest(".kd-slide-ghost"));
}

/** Where a panel lies in the window, by its layout alone: a panel on its way in is moved by a
 *  transform, which its painted box would include. */
interface PanelBox { left: number; top: number; right: number; bottom: number }
function panelBox(node: HTMLElement): PanelBox {
  const parent = node.offsetParent?.getBoundingClientRect();
  const left = (parent?.left ?? 0) + node.offsetLeft, top = (parent?.top ?? 0) + node.offsetTop;
  return { left, top, right: left + node.offsetWidth, bottom: top + node.offsetHeight };
}

/** A morph under way: its animations, and the surface that stands in for the panel's edge. */
interface PanelMorph { animations: Animation[]; surface: HTMLElement | null }

function endMorph(morph: PanelMorph): void {
  for (const animation of morph.animations) animation.cancel();
  morph.surface?.remove();
  morph.animations = [];
  morph.surface = null;
}

/**
 * The panel between its place as a drawer and the window's block (`takesWindow`). The panel is
 * laid out as the block throughout; what is seen of it grows out of the drawer's rectangle, or
 * closes down to it (`grow` false), by a clip. Nothing on it is stretched: the title keeps to
 * the corner it belongs to, the tools to theirs, and the body's middle stays the middle of what
 * is seen. A body that is drawn larger in the window (--kd-drawer-window-zoom, set by the app's
 * own stylesheet) is scaled by that, so its words grow with the panel instead of jumping.
 *
 * The clip cuts the panel's own edge and shadow off, so an empty surface with the panel's look
 * lies under it for the gesture and is moved over the same rectangles: the block is seen to
 * grow and shrink as a thing with an edge, and no edge appears from nowhere when it ends.
 *
 * Both rectangles are measured before this is called; it only starts the animations.
 */
function morphPanel(node: HTMLElement, drawer: PanelBox, block: PanelBox, grow: boolean): PanelMorph {
  const style = getComputedStyle(node);
  const radius = style.borderTopLeftRadius || "0px";
  const zoom = Number.parseFloat(style.getPropertyValue("--kd-drawer-window-zoom")) || 1;
  const timing: KeyframeAnimationOptions = grow
    ? { duration: MOTION_IN_MS, easing: SONG_SWAP_IN_EASE, fill: "backwards" }
    // Held at its end until the panel takes its drawer place in the same frame (DrawerLayer).
    : { duration: MOTION_OUT_MS, easing: SONG_SWAP_OUT_EASE, fill: "forwards" };
  const px = (value: number) => `${value.toFixed(1)}px`;
  const at = (x: number, y: number, scale = "1"): Keyframe => ({ transform: `translate(${px(x)}, ${px(y)}) scale(${scale})` });
  const run = (element: Element | null, small: Keyframe, large: Keyframe) =>
    element ? [element.animate(grow ? [small, large] : [large, small], timing)] : [];
  const dx = drawer.left - block.left, dy = drawer.top - block.top;
  const width = block.right - block.left, height = block.bottom - block.top;
  const surface = document.createElement("div");
  surface.className = "kd-drawer-surface";
  surface.setAttribute("aria-hidden", "true");
  Object.assign(surface.style, { left: px(block.left), top: px(block.top), width: px(width), height: px(height) });
  node.before(surface);
  return {
    surface,
    animations: [
      ...run(node,
        { clipPath: `inset(${px(dy)} ${px(block.right - drawer.right)} ${px(block.bottom - drawer.bottom)} ${px(dx)} round ${radius})` },
        { clipPath: `inset(0px 0px 0px 0px round ${radius})` }),
      ...run(surface,
        at(dx, dy, `${((drawer.right - drawer.left) / Math.max(1, width)).toFixed(4)}, ${((drawer.bottom - drawer.top) / Math.max(1, height)).toFixed(4)}`),
        at(0, 0, "1, 1")),
      ...run(node.querySelector(":scope > .kd-title-tabs > .kd-title-tabs-text"), at(dx, dy), at(0, 0)),
      ...run(node.querySelector(":scope > .kd-title-tabs > .kd-title-tabs-tools"), at(drawer.right - block.right, dy), at(0, 0)),
      ...run(node.querySelector(":scope > .kd-drawer-body"),
        at((drawer.left + drawer.right - block.left - block.right) / 2, (drawer.top + drawer.bottom - block.top - block.bottom) / 2, (1 / zoom).toFixed(4)),
        at(0, 0)),
    ],
  };
}

/** The title row: the title or the page words, the app's tools and the roll-up key.
 *  While the app has the window that key gives the window back instead. */
function DrawerTitle({ spec, page, leaving, panelId }: { spec: DrawerSpec; page?: string; leaving: boolean; panelId: string }) {
  const taking = spec.takesWindow;
  const away = taking ? taking.label : `收起${spec.title}`;
  return <TitleTabs label={spec.title} title={spec.title} tabs={spec.pages} value={page}
    onChange={leaving ? undefined : spec.onPage} panelId={spec.pages ? panelId : undefined}>
    {spec.tools}
    <button type="button" className="kd-drawer-rollup" aria-label={away} title={`${away} · Esc`}
      onClick={() => { if (taking) taking.leave(); else spec.close(); }}>
      {taking ? <Minimize2 size={15} aria-hidden="true" /> : <ChevronsRight size={16} aria-hidden="true" />}
    </button>
  </TitleTabs>;
}

/**
 * The title row of an app with pages. It alone reads the page in view (`usePage`), so a switch
 * of page redraws this row and the body that follows the same state, and nothing above them.
 */
function PagedTitle({ usePage, ...title }: { spec: DrawerSpec; usePage(): string; leaving: boolean; panelId: string }) {
  return <DrawerTitle {...title} page={usePage()} />;
}

function DrawerLayer({ spec, leaving, userSized, panelId, onGone, onResizeStart, onHeightStart, onHeightReset }: {
  spec: DrawerSpec;
  leaving: boolean;
  /** The user has dragged a height: the app's extent does not decide it. */
  userSized: boolean;
  /** Names the body for the page tabs in the title row. */
  panelId: string;
  onGone(): void;
  onResizeStart?(event: PointerEvent<HTMLDivElement>): void;
  onHeightStart(event: PointerEvent<HTMLDivElement>): void;
  onHeightReset(): void;
}) {
  const layer = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // A `fit` or `at-least-half` app is as tall as what it holds (the limits are the
  // stylesheet's); `fit` is that height in px once it has been measured.
  const [fit, setFit] = useState<number | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const sized = spec.extent === "fit" || spec.extent === "at-least-half";
  // The app takes the window (`takesWindow`). The panel has the window's layout from the moment
  // it is asked to and grows into it; asked to give it back, it keeps that layout while what is
  // seen of it closes down to its drawer place, and takes that place when the gesture is over.
  // The app has let go by then: the page is back and in use while the panel shrinks.
  const wantsWindow = !!spec.takesWindow;
  const [inWindow, setInWindow] = useState(wantsWindow);
  if (wantsWindow && !inWindow) setInWindow(true);
  const wanted = useRef(wantsWindow);
  const morph = useRef<PanelMorph>({ animations: [], surface: null });
  useLayoutEffect(() => {
    const node = layer.current;
    if (!node || leaving || wanted.current === wantsWindow) return;
    wanted.current = wantsWindow;
    endMorph(morph.current);
    if (prefersReducedMotion() || typeof node.animate !== "function") {
      if (!wantsWindow) setInWindow(false);
      return;
    }
    // Measured once, before anything moves: the panel's place as a drawer and as the block.
    node.removeAttribute("data-takes-window");
    const drawer = panelBox(node);
    node.setAttribute("data-takes-window", "true");
    const running = morphPanel(node, drawer, panelBox(node), wantsWindow);
    morph.current = running;
    const clip = running.animations[0];
    if (wantsWindow) {
      // Grown: the panel's own edge is back, and the stand-in goes.
      clip?.addEventListener("finish", () => { if (morph.current === running) endMorph(running); });
      return;
    }
    // The gesture's own end; the timer covers a window that is not being drawn.
    const settle = () => { if (morph.current === running) setInWindow(false); };
    clip?.addEventListener("finish", settle);
    const timer = window.setTimeout(settle, MOTION_OUT_MS * 3);
    return () => window.clearTimeout(timer);
  }, [wantsWindow, leaving]);
  // Back in its drawer place: what held the shrunken picture goes in the same frame.
  useLayoutEffect(() => { if (!inWindow) endMorph(morph.current); }, [inWindow]);
  useEffect(() => () => endMorph(morph.current), []);
  // An app that keeps room (`at-least-half`) is built with the sheet and measured before the
  // first paint: the sheet starts at the height it will keep, and what is thrown at it
  // (lib/downloadToss.ts) finds its list from the first frame. Any other body is built a frame
  // later, so the sheet's first frame is not held up by a heavy app (settings, the visualizer
  // configuration).
  const eager = spec.extent === "at-least-half";
  const [built, setBuilt] = useState(eager);
  useEffect(() => {
    if (built) return;
    const frame = requestAnimationFrame(() => startTransition(() => setBuilt(true)));
    return () => cancelAnimationFrame(frame);
  }, [built]);
  useLayoutEffect(() => {
    if (eager && body.current && layer.current) setFit(fittingHeight(layer.current, body.current));
    // Only the first picture is decided here; later changes are followed below.
  }, []);
  // A `fit` panel arrives at its prepared height. Explicitly pending content (settings'
  // storage statistics, for example) must not be mistaken for a short finished page.
  const [patient, setPatient] = useState(spec.extent === "fit" && !userSized);
  const held = patient && fit === null;
  useEffect(() => {
    if (!held || leaving) return;
    const timer = window.setTimeout(() => {
      const node = body.current, sheet = layer.current;
      if (node && pendingBody(node)) return;
      // The fallback can run before the scheduled measurement; finish it before releasing.
      if (node && sheet) setFit(fittingHeight(sheet, node));
      setPatient(false);
    }, HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [held, leaving]);
  // At rest the sheet is no longer a moving layer, and a change of height may be shown.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (held || leaving) return;
    const duration = prefersReducedMotion() ? MOTION_REDUCED_MS : spec.contentKey !== undefined ? MOTION_IN_MS : ENTER_MS;
    const timer = window.setTimeout(() => setSettled(true), duration + 80);
    return () => window.clearTimeout(timer);
  }, [held, leaving, spec.contentKey]);
  useEffect(() => {
    // Measure before the entrance and at rest, never while the panel is sliding in.
    if (!sized || !built || (!held && !settled)) return;
    const node = body.current, sheet = layer.current, host = sheet?.parentElement;
    if (!node || !sheet || !host || leaving) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = fittingHeight(sheet, node);
      // A pixel either way is rounding, not a change of content.
      if (next !== null && (fitRef.current === null || Math.abs(next - fitRef.current) > 1)) setFit(next);
      // A completed body with no measurable scroller uses its extent, not an endless hold.
      if (next === null && !pendingBody(node)) setPatient(false);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    const resized = new ResizeObserver(schedule);
    resized.observe(node);
    resized.observe(host);
    const changed = new MutationObserver(schedule);
    changed.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open", "aria-expanded", "data-drawer-pending"] });
    return () => { cancelAnimationFrame(frame); resized.disconnect(); changed.disconnect(); };
  }, [sized, built, held, settled, leaving]);
  // The animation is the usual end of a leaving drawer; the timer covers a tab in the background.
  // Loading the next song must not restart that deadline on every parent render.
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (!leaving) return;
    // Cancelled before it was visible: there is no outgoing picture to animate.
    if (held) { gone.current(); return; }
    const duration = prefersReducedMotion() ? MOTION_REDUCED_MS : spec.contentKey !== undefined ? MOTION_OUT_MS : LEAVE_MS;
    const timer = window.setTimeout(() => gone.current(), duration + 120);
    return () => window.clearTimeout(timer);
  }, [leaving, held, spec.contentKey]);
  // The app's own layer under the whole panel, and the ink that layer asks for.
  const backdrop = useSurfaceBackdrop(spec.backdrop);
  return <section ref={layer} className="kd-drawer" data-app={spec.id} data-extent={spec.extent}
    data-content-turn={spec.contentKey !== undefined || undefined}
    data-takes-window={inWindow || undefined}
    style={fit === null ? backdrop.style : { ...backdrop.style, "--kd-drawer-fit": `${fit}px` } as CSSProperties}
    {...backdrop.attributes} data-leaving={leaving || undefined} data-held={held || undefined} data-settled={settled && !leaving || undefined}
    role="region" aria-label={leaving ? undefined : spec.title}
    aria-hidden={leaving || held || undefined} inert={leaving || held}
    onAnimationEnd={event => {
      if (event.target !== event.currentTarget) return;
      if (leaving) onGone();
      else setSettled(true);
    }}>
    {backdrop.layer}
    <DrawerContext.Provider value={spec.id}>
      {spec.usePage ? <PagedTitle spec={spec} usePage={spec.usePage} leaving={leaving} panelId={panelId} />
        : <DrawerTitle spec={spec} leaving={leaving} panelId={panelId} />}
      <div ref={body} className="kd-drawer-body" id={panelId} role={spec.pages ? "tabpanel" : undefined}
        data-late={eager || spec.extent === "fit" ? undefined : "true"}>{built ? spec.body : null}</div>
    </DrawerContext.Provider>
    {onResizeStart && !leaving && !inWindow && <div className="kd-drawer-resize" role="separator" aria-orientation="vertical"
      aria-label="调整抽屉宽度" onPointerDown={onResizeStart} />}
    {!leaving && !inWindow && <div className="kd-drawer-resize" data-edge="bottom" role="separator" aria-orientation="horizontal"
      aria-label="调整抽屉高度" title="拖动调整高度 · 双击恢复" onPointerDown={onHeightStart} onDoubleClick={onHeightReset} />}
  </section>;
}

/** The apps that are opened by hand, as icons at the right end of the search row. */
function DrawerEntries({ entries, front, onAsk }: {
  entries: readonly DrawerEntry[];
  front: string | null;
  onAsk(entry: DrawerEntry): void;
}) {
  return <>{entries.map(entry => {
    const name = entry.title ?? entry.label;
    return <button key={entry.id} type="button" className="kd-drawer-entry" data-drawer-entry={entry.id}
      aria-pressed={front === entry.id} aria-label={entry.count ? `${name}，${entry.count} 项进行中` : name}
      title={name} onClick={() => onAsk(entry)}>
      {entry.icon}
      {entry.count ? <span className="kd-drawer-entry-count" aria-hidden="true">{entry.count > 99 ? "99+" : entry.count}</span> : null}
    </button>;
  })}</>;
}

/**
 * The drawer: a floating panel over the right of the list, one app at a time. Its entries are
 * icons at the right end of the search row and are always there; the panel slides in from the
 * window's right edge and floats free of every edge, like a task bubble. A new app waits until
 * the one that was there has left completely, then comes in; nothing stays underneath to come
 * back. The panel covers the list and its toolbar instead of taking room from them, so nothing
 * beneath it is laid out again. It is resized by its left edge (width) and its bottom edge
 * (height; a double click gives the height back to the app's own extent).
 */
export function DrawerHost({ spec, entries = [], hostRef, onResizeStart }: {
  /** The app to show, described by its schema; null rolls the drawer up. */
  spec: DrawerSpec | null;
  /** The apps offered beside the search. */
  entries?: readonly DrawerEntry[];
  hostRef?: Ref<HTMLDivElement>;
  /** Dragging the left edge changes the width. */
  onResizeStart?(event: PointerEvent<HTMLDivElement>): void;
}) {
  // The app can remain enabled while its panel has nothing to show. Its entry still closes
  // that intent; only the visual layer is suspended.
  const panel = spec?.suspended ? null : spec;
  const [layers, setLayers] = useState<{ key: number; id: string; contentKey?: string | number; leaving: DrawerSpec | null }[]>(
    () => panel ? [{ key: 1, id: panel.id, contentKey: panel.contentKey, leaving: null }] : []);
  const sequence = useRef(1);
  // Freeze the outgoing description, including its song, until the whole shell has left.
  const last = useRef<DrawerSpec | null>(panel);
  const front = layers.find(layer => !layer.leaving);
  if ((panel?.id ?? null) !== (front?.id ?? null) || panel?.contentKey !== front?.contentKey) {
    const gone = last.current;
    const waiting = layers.some(layer => layer.leaving);
    const next = [
      // A queued front has never been drawn. Drop it on another change instead of making
      // it an outgoing layer and briefly flashing a skipped song.
      ...layers.flatMap(layer => layer.leaving ? [layer] : !waiting && gone ? [{ ...layer, leaving: gone }] : []),
      ...(panel ? [{ key: ++sequence.current, id: panel.id, contentKey: panel.contentKey, leaving: null }] : []),
    ];
    setLayers(next);
  }
  useLayoutEffect(() => { last.current = panel; });
  const specRef = useRef(spec);
  specRef.current = spec;
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      const open = specRef.current;
      if (!open || event.key !== "Escape" || event.defaultPrevented) return;
      // Escape inside a field or a modal dialog belongs to that field or dialog.
      if (event.target instanceof Element && event.target.closest("input, textarea, select, dialog[open], [role='menu']")) return;
      event.preventDefault();
      // An app that has the window gives it back first; the next Esc puts it away.
      if (open.takesWindow) open.takesWindow.leave();
      else open.close();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  // The app in front has the window for as long as its description says so (lib/windowTaken.ts).
  const takenBy = panel?.takesWindow ? panel.id : null;
  useLayoutEffect(() => {
    if (!takenBy) return;
    useWindowTaken.getState().take(takenBy, () => specRef.current?.takesWindow?.leave());
    return () => useWindowTaken.getState().release(takenBy);
  }, [takenBy]);
  const host = useRef<HTMLDivElement | null>(null);
  const setHost = (node: HTMLDivElement | null) => {
    host.current = node;
    if (typeof hostRef === "function") hostRef(node);
    else if (hostRef) hostRef.current = node;
  };
  const panelIdPrefix = useId();
  // The height the user dragged the panel to, in px; null leaves it to each app's extent.
  const [userHeight, setUserHeight] = useState<number | null>(() => {
    const saved = Number.parseFloat(readLocalStorage(HEIGHT_KEY) ?? "");
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  const startHeightDrag = (event: PointerEvent<HTMLDivElement>) => {
    const sheet = event.currentTarget.parentElement, node = sheet?.parentElement;
    if (event.button !== 0 || !sheet || !node) return;
    event.preventDefault();
    const handle = event.currentTarget, from = event.clientY, start = sheet.getBoundingClientRect().height;
    let height = start;
    handle.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) => {
      height = Math.max(MIN_HEIGHT, start + moved.clientY - from);
      node.style.setProperty("--kd-drawer-user-h", `${Math.round(height)}px`);
      node.dataset.sized = "true";
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (Math.abs(height - start) < 2) return;
      writeLocalStorageNow(HEIGHT_KEY, String(Math.round(height)));
      setUserHeight(Math.round(height));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const resetHeight = () => {
    removeLocalStorage(HEIGHT_KEY);
    setUserHeight(null);
  };
  useEffect(() => {
    heightResets.add(resetHeight);
    return () => { heightResets.delete(resetHeight); };
  });
  // The open app's entry puts it away; any other asks for its own app.
  const ask = (entry: DrawerEntry) => { if (spec?.id === entry.id) spec.close(); else entry.open(); };
  // One panel on screen at a time: while one is leaving, the next waits its turn.
  const waiting = layers.some(layer => layer.leaving);
  // The panels are drawn outside the list's own stacking order, beside the floating media
  // window, so that the two can pass over each other. `area` is where they belong in the
  // layout; the frame that holds them is kept on that rectangle.
  const area = useRef<HTMLDivElement>(null);
  const sheets = useRef<HTMLDivElement>(null);
  const [outside, setOutside] = useState<HTMLElement | null>(null);
  const out = layers.length > 0;
  useLayoutEffect(() => {
    const from = area.current, to = sheets.current;
    if (!out || !from || !to) return;
    const sync = () => {
      const box = from.getBoundingClientRect();
      to.style.left = `${box.left}px`;
      to.style.top = `${box.top}px`;
      to.style.width = `${box.width}px`;
      to.style.height = `${box.height}px`;
    };
    sync();
    window.addEventListener("resize", sync);
    if (typeof ResizeObserver === "undefined") return () => window.removeEventListener("resize", sync);
    const resized = new ResizeObserver(sync);
    resized.observe(from);
    // The list's column moving (the sidebar or an editor column resized) moves the area too.
    const column = host.current?.parentElement;
    if (column) resized.observe(column);
    return () => { window.removeEventListener("resize", sync); resized.disconnect(); };
  }, [out, outside]);
  // A panel that comes out is in front of the other floating surfaces.
  const frontKey = front?.key;
  useLayoutEffect(() => { if (frontKey !== undefined && !waiting) raiseSurface(sheets.current); }, [frontKey, waiting]);
  const panels = out ? <div ref={sheets} className="kd-drawer-sheets" data-sized={userHeight === null ? undefined : "true"}
    style={userHeight === null ? undefined : { "--kd-drawer-user-h": `${userHeight}px` } as CSSProperties}
    onPointerDownCapture={() => raiseSurface(sheets.current)}>
    {layers.map(layer => {
      const shown = layer.leaving ?? panel;
      if (!shown || (waiting && !layer.leaving)) return null;
      return <DrawerLayer key={layer.key} spec={shown} leaving={!!layer.leaving} userSized={userHeight !== null} panelId={`${panelIdPrefix}-${layer.key}`}
        onResizeStart={onResizeStart} onHeightStart={startHeightDrag} onHeightReset={resetHeight}
        onGone={() => setLayers(list => list.filter(item => item.key !== layer.key))} />;
    })}
  </div> : null;
  return <div ref={node => { setHost(node); setOutside(node ? node.closest<HTMLElement>(".kd-app") ?? node.parentElement : null); }}
    className="kd-drawer-host" data-open={panel ? "true" : undefined}>
    {entries.length ? <nav className="kd-drawer-launcher" aria-label="侧边应用">
      <DrawerEntries entries={entries} front={spec?.id ?? null} onAsk={ask} />
    </nav> : null}
    <div ref={area} className="kd-drawer-area" aria-hidden="true" />
    {panels && outside ? createPortal(panels, outside) : null}
  </div>;
}
