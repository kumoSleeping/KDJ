import { createContext, startTransition, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type Ref } from "react";
import { ChevronsUp } from "lucide-react";
import { TitleTabs } from "./TitleTabs";
import { readLocalStorage, removeLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import type { DrawerEntry, DrawerSpec } from "./drawerSchema";
import "./Drawer.css";

/** The slide in; a panel is at rest once it is over. */
const ENTER_MS = 400;
/** The slide back out; a panel that was put away stays mounted this long. */
const LEAVE_MS = 260;
const HEIGHT_KEY = "kd-drawer-height";
const MIN_HEIGHT = 180;

const DrawerContext = createContext<string | null>(null);
/** The id of the drawer a component is shown in, or null outside one. */
export function useDrawer(): string | null { return useContext(DrawerContext); }

/**
 * The height at which everything in `body` fits without scrolling: the sheet's height now, plus
 * what its tallest scrolling part lacks or minus what it has to spare. Null when nothing in the
 * body scrolls, which says nothing about what it needs.
 */
function fittingHeight(sheet: HTMLElement, body: HTMLElement): number | null {
  const scrollers = [body, ...body.querySelectorAll<HTMLElement>(".kd-scroll, [data-drawer-scroll]")]
    .filter(node => node.clientHeight > 0 && getComputedStyle(node).overflowY !== "visible"
      && getComputedStyle(node).overflowY !== "hidden");
  if (!scrollers.length) return null;
  const range = document.createRange();
  let lack = -Infinity;
  for (const node of scrollers) {
    range.selectNodeContents(node);
    const style = getComputedStyle(node);
    const content = range.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    lack = Math.max(lack, Math.ceil(content) - node.clientHeight);
  }
  return Math.round(sheet.getBoundingClientRect().height + lack);
}

function DrawerLayer({ spec, leaving, panelId, onGone, onResizeStart, onHeightStart, onHeightReset }: {
  spec: DrawerSpec;
  leaving: boolean;
  /** Names the body for the page tabs in the title row. */
  panelId: string;
  onGone(): void;
  onResizeStart?(event: PointerEvent<HTMLDivElement>): void;
  onHeightStart(event: PointerEvent<HTMLDivElement>): void;
  onHeightReset(): void;
}) {
  const layer = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // A `content` app is as tall as what it holds, between two thirds and the whole way down
  // (the limits are the stylesheet's); `fit` is that height in px once it has been measured.
  const [fit, setFit] = useState<number | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // A body whose size decides how far the sheet comes down is built with the sheet and measured
  // before the first paint, so the sheet starts at the height it will keep. Any other body is
  // built a frame later: the sheet's first frame, the one its entrance starts from, is not
  // held up by a heavy app (settings, the visualizer configuration).
  const [built, setBuilt] = useState(spec.extent === "content");
  useEffect(() => {
    if (built) return;
    const frame = requestAnimationFrame(() => startTransition(() => setBuilt(true)));
    return () => cancelAnimationFrame(frame);
  }, [built]);
  useLayoutEffect(() => {
    if (spec.extent === "content" && body.current && layer.current) setFit(fittingHeight(layer.current, body.current));
    // Only the first picture is decided here; later changes are followed below.
  }, []);
  // At rest the sheet is no longer a moving layer, and a change of height may be shown.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), ENTER_MS + 80);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (spec.extent !== "content") return;
    const node = body.current, sheet = layer.current, host = sheet?.parentElement;
    if (!node || !sheet || !host || leaving) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = fittingHeight(sheet, node);
      // A pixel either way is rounding, not a change of content.
      if (next !== null && (fitRef.current === null || Math.abs(next - fitRef.current) > 1)) setFit(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    const resized = new ResizeObserver(schedule);
    resized.observe(node);
    resized.observe(host);
    const changed = new MutationObserver(schedule);
    changed.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open", "aria-expanded"] });
    return () => { cancelAnimationFrame(frame); resized.disconnect(); changed.disconnect(); };
  }, [spec.extent, spec.page, leaving]);
  // The animation is the usual end of a leaving drawer; the timer covers a tab in the background.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onGone, LEAVE_MS + 120);
    return () => window.clearTimeout(timer);
  }, [leaving, onGone]);
  return <section ref={layer} className="kd-drawer" data-app={spec.id} data-extent={spec.extent}
    style={fit === null ? undefined : { "--kd-drawer-fit": `${fit}px` } as CSSProperties}
    data-leaving={leaving || undefined} data-settled={settled && !leaving || undefined}
    role="region" aria-label={leaving ? undefined : spec.title}
    aria-hidden={leaving || undefined} inert={leaving}
    onAnimationEnd={event => {
      if (event.target !== event.currentTarget) return;
      if (leaving) onGone();
      else setSettled(true);
    }}>
    <DrawerContext.Provider value={spec.id}>
      <TitleTabs label={spec.title} title={spec.title} tabs={spec.pages} value={spec.page}
        onChange={leaving ? undefined : spec.onPage} panelId={spec.pages ? panelId : undefined} caption={spec.caption}>
        {spec.tools}
        <button type="button" className="kd-drawer-rollup" aria-label={`收起${spec.title}`} title={`收起${spec.title} · Esc`}
          onClick={() => { spec.close(); }}>
          <ChevronsUp size={16} aria-hidden="true" />
        </button>
      </TitleTabs>
      <div ref={body} className="kd-drawer-body" id={panelId} role={spec.pages ? "tabpanel" : undefined}
        data-late={spec.extent === "content" ? undefined : "true"}>{built ? spec.body : null}</div>
    </DrawerContext.Provider>
    {onResizeStart && !leaving && <div className="kd-drawer-resize" role="separator" aria-orientation="vertical"
      aria-label="调整抽屉宽度" onPointerDown={onResizeStart} />}
    {!leaving && <div className="kd-drawer-resize" data-edge="bottom" role="separator" aria-orientation="horizontal"
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
  const [layers, setLayers] = useState<{ key: number; id: string; leaving: DrawerSpec | null }[]>(
    () => spec ? [{ key: 1, id: spec.id, leaving: null }] : []);
  const sequence = useRef(1);
  // What was shown after the last commit: the picture a replaced app leaves with.
  const last = useRef<DrawerSpec | null>(spec);
  const front = layers.find(layer => !layer.leaving);
  if ((spec?.id ?? null) !== (front?.id ?? null)) {
    const gone = last.current;
    const next = [
      ...layers.map(layer => layer.leaving || !gone ? layer : { ...layer, leaving: gone }).filter(layer => layer.leaving),
      ...(spec ? [{ key: ++sequence.current, id: spec.id, leaving: null }] : []),
    ];
    setLayers(next);
  }
  useLayoutEffect(() => { last.current = spec; });
  const specRef = useRef(spec);
  specRef.current = spec;
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      const open = specRef.current;
      if (!open || event.key !== "Escape" || event.defaultPrevented) return;
      // Escape inside a field or a modal dialog belongs to that field or dialog.
      if (event.target instanceof Element && event.target.closest("input, textarea, select, dialog[open], [role='menu']")) return;
      event.preventDefault();
      open.close();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  const host = useRef<HTMLDivElement | null>(null);
  const setHost = (node: HTMLDivElement | null) => {
    host.current = node;
    if (typeof hostRef === "function") hostRef(node);
    else if (hostRef) hostRef.current = node;
  };
  const panel = useId();
  // The height the user dragged the panel to, in px; null leaves it to each app's extent.
  const [userHeight, setUserHeight] = useState<number | null>(() => {
    const saved = Number.parseFloat(readLocalStorage(HEIGHT_KEY) ?? "");
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  const startHeightDrag = (event: PointerEvent<HTMLDivElement>) => {
    const sheet = event.currentTarget.parentElement, node = host.current;
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
  // The open app's entry puts it away; any other asks for its own app.
  const ask = (entry: DrawerEntry) => { if (spec?.id === entry.id) spec.close(); else entry.open(); };
  // One panel on screen at a time: while one is leaving, the next waits its turn.
  const waiting = layers.some(layer => layer.leaving);
  return <div ref={setHost} className="kd-drawer-host" data-open={spec ? "true" : undefined}
    data-sized={userHeight === null ? undefined : "true"}
    style={userHeight === null ? undefined : { "--kd-drawer-user-h": `${userHeight}px` } as CSSProperties}>
    {entries.length ? <nav className="kd-drawer-launcher" aria-label="侧边应用">
      <DrawerEntries entries={entries} front={spec?.id ?? null} onAsk={ask} />
    </nav> : null}
    <div className="kd-drawer-sheets">
      {layers.map(layer => {
        const shown = layer.leaving ?? spec;
        if (!shown || (waiting && !layer.leaving)) return null;
        return <DrawerLayer key={layer.key} spec={shown} leaving={!!layer.leaving} panelId={`${panel}-${layer.key}`}
          onResizeStart={onResizeStart} onHeightStart={startHeightDrag} onHeightReset={resetHeight}
          onGone={() => setLayers(list => list.filter(item => item.key !== layer.key))} />;
      })}
    </div>
  </div>;
}
