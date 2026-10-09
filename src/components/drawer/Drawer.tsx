import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type Ref } from "react";
import { ChevronsUp } from "lucide-react";
import { TitleTabs } from "./TitleTabs";
import type { DrawerSpec } from "./drawerSchema";
import "./Drawer.css";

/** The roll back up; a drawer that was put away stays mounted this long. */
const LEAVE_MS = 300;

const DrawerContext = createContext<string | null>(null);
/** The id of the drawer a component is shown in, or null outside one. */
export function useDrawer(): string | null { return useContext(DrawerContext); }

/**
 * Whether what is in `body` needs more room than two thirds of the way down. A drawer that is
 * all the way down goes back only when everything would fit with room to spare, so a list
 * whose length hovers at the limit does not make it travel back and forth.
 */
function needsFull(body: HTMLElement, full: boolean, spare: number): boolean {
  const scrollers = [body, ...body.querySelectorAll<HTMLElement>(".kd-scroll, [data-drawer-scroll]")]
    .filter(node => node.clientHeight > 0 && getComputedStyle(node).overflowY !== "visible"
      && getComputedStyle(node).overflowY !== "hidden");
  if (!full) return scrollers.some(node => node.scrollHeight > node.clientHeight + 1);
  if (!scrollers.length) return true;
  const range = document.createRange();
  return scrollers.some(node => {
    range.selectNodeContents(node);
    const content = range.getBoundingClientRect().height;
    // Content that stretches to fill its scroller says nothing about what it needs.
    return content + 12 > node.clientHeight - spare;
  });
}

function DrawerLayer({ spec, leaving, onGone, onResizeStart }: {
  spec: DrawerSpec;
  leaving: boolean;
  onGone(): void;
  onResizeStart?(event: PointerEvent<HTMLDivElement>): void;
}) {
  const layer = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [full, setFull] = useState(spec.extent === "full");
  const fullRef = useRef(full);
  fullRef.current = full;
  useEffect(() => {
    if (spec.extent !== "content") { setFull(spec.extent === "full"); return; }
    const node = body.current, sheet = layer.current, host = sheet?.parentElement;
    if (!node || !sheet || !host || leaving) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const spare = fullRef.current ? host.clientHeight / 3 : 0;
      const next = needsFull(node, fullRef.current, spare);
      if (next !== fullRef.current) setFull(next);
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
  return <section ref={layer} className="kd-drawer" data-app={spec.id} data-extent={full ? "full" : "two-thirds"}
    data-leaving={leaving || undefined} role="region" aria-label={leaving ? undefined : spec.title}
    aria-hidden={leaving || undefined} inert={leaving}
    onAnimationEnd={event => { if (leaving && event.target === event.currentTarget) onGone(); }}>
    <DrawerContext.Provider value={spec.id}>
      <div className="kd-drawer-content">
        <TitleTabs label={spec.title} title={spec.title} tabs={spec.pages} value={spec.page} onChange={spec.onPage}
          panelId={spec.pages ? panelId : undefined} caption={spec.caption}>
          {spec.tools}
          <button type="button" aria-label={`收起${spec.title}`} title={`收起${spec.title} · Esc`} onClick={() => { spec.close(); }}>
            <ChevronsUp size={16} aria-hidden="true" />
          </button>
        </TitleTabs>
        <div ref={body} className="kd-drawer-body" id={panelId} role={spec.pages ? "tabpanel" : undefined}>{spec.body}</div>
      </div>
    </DrawerContext.Provider>
    {onResizeStart && !leaving && <div className="kd-drawer-resize" role="separator" aria-orientation="vertical"
      aria-label="调整抽屉宽度" onPointerDown={onResizeStart} />}
  </section>;
}

/**
 * The drawer over the right of the list: one app at a time, pulled down from under the list's
 * toolbar like a blind. A new app comes down over the one that was there, which rolls up
 * beneath it and is gone; nothing waits underneath to come back. It covers the list instead of
 * taking a column from it, so the list never reflows while the drawer moves.
 */
export function DrawerHost({ spec, hostRef, onResizeStart }: {
  /** The app to show, described by its schema; null rolls the drawer up. */
  spec: DrawerSpec | null;
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
  if (!layers.length) return null;
  return <div ref={hostRef} className="kd-drawer-host">
    {layers.map(layer => {
      const shown = layer.leaving ?? spec;
      return shown ? <DrawerLayer key={layer.key} spec={shown} leaving={!!layer.leaving} onResizeStart={onResizeStart}
        onGone={() => setLayers(list => list.filter(item => item.key !== layer.key))} /> : null;
    })}
  </div>;
}
