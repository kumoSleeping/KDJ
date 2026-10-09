import { createContext, startTransition, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type Ref, type RefObject } from "react";
import { ChevronsUp } from "lucide-react";
import { TitleTabs } from "./TitleTabs";
import type { DrawerEntry, DrawerSpec } from "./drawerSchema";
import "./Drawer.css";

/** The roll down; a sheet is at rest once it is over. */
const ENTER_MS = 420;
/** The roll back up; a drawer that was put away stays mounted this long. */
const LEAVE_MS = 320;
const ARRIVE = "cubic-bezier(0.22, 0.9, 0.26, 1)";
const LEAVE = "cubic-bezier(0.55, 0, 0.8, 0.35)";

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

function DrawerLayer({ spec, leaving, panelId, onGone, onResizeStart }: {
  spec: DrawerSpec;
  leaving: boolean;
  /** Names the body for the page tabs in the head. */
  panelId: string;
  onGone(): void;
  onResizeStart?(event: PointerEvent<HTMLDivElement>): void;
}) {
  const layer = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(spec.extent === "full");
  const fullRef = useRef(full);
  fullRef.current = full;
  // A body whose size decides how far the sheet comes down is built with the sheet and measured
  // before the first paint, so the sheet starts at the height it will keep. Any other body is
  // built a frame later: the sheet's first frame, the one its roll-down starts from, is not
  // held up by a heavy app (settings, the visualizer configuration).
  const [built, setBuilt] = useState(spec.extent === "content");
  useEffect(() => {
    if (built) return;
    const frame = requestAnimationFrame(() => startTransition(() => setBuilt(true)));
    return () => cancelAnimationFrame(frame);
  }, [built]);
  useLayoutEffect(() => {
    if (spec.extent === "content" && body.current && needsFull(body.current, false, 0)) setFull(true);
    // Only the first picture is decided here; later changes are followed below.
  }, []);
  // At rest the sheet is no longer a moving layer, and a change of height may be shown.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), ENTER_MS + 80);
    return () => window.clearTimeout(timer);
  }, []);
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
    data-leaving={leaving || undefined} data-settled={settled && !leaving || undefined}
    role="region" aria-label={leaving ? undefined : spec.title}
    aria-hidden={leaving || undefined} inert={leaving}
    onAnimationEnd={event => {
      if (event.target !== event.currentTarget) return;
      if (leaving) onGone();
      else setSettled(true);
    }}>
    <DrawerContext.Provider value={spec.id}>
      <div ref={body} className="kd-drawer-body" id={panelId} role={spec.pages ? "tabpanel" : undefined}
        data-late={spec.extent === "content" ? undefined : "true"}>{built ? spec.body : null}</div>
    </DrawerContext.Provider>
    {onResizeStart && !leaving && <div className="kd-drawer-resize" role="separator" aria-orientation="vertical"
      aria-label="调整抽屉宽度" onPointerDown={onResizeStart} />}
  </section>;
}

/** The entries of the head: words beside their icons while it is rolled up, icons alone beside a title. */
function DrawerEntries({ entries, front, compact, live, onAsk }: {
  entries: readonly DrawerEntry[];
  front: string | null;
  compact: boolean;
  /** Only the set that can be used names its entries, so `data-drawer-entry` finds one control. */
  live: boolean;
  onAsk(entry: DrawerEntry): void;
}) {
  return <>{entries.map(entry => {
    const name = entry.title ?? entry.label;
    return <button key={entry.id} type="button" className="kd-drawer-entry" data-drawer-entry={live ? entry.id : undefined}
      aria-pressed={front === entry.id} aria-label={entry.count ? `${name}，${entry.count} 项进行中` : name}
      title={name} onClick={() => onAsk(entry)}>
      {entry.icon}
      {compact ? null : <span>{entry.label}</span>}
      {entry.count ? <span className="kd-drawer-entry-count" aria-hidden="true">{entry.count > 99 ? "99+" : entry.count}</span> : null}
    </button>;
  })}</>;
}

/**
 * Toolbars the sheet passes over keep their right-hand tools beside it: each is given the
 * width that lies under the drawer as end padding, and what that moves slides to its new
 * place. Only those toolbars are laid out again; the list below them is not touched.
 */
function useClearToolbars(host: RefObject<HTMLDivElement | null>, selector: string | undefined, open: boolean) {
  const was = useRef(false);
  const sync = useRef<(slide: boolean) => void>(() => undefined);
  sync.current = slide => {
    const node = host.current, scope = node?.parentElement;
    if (!node || !scope || !selector) return;
    const edge = node.getBoundingClientRect().left;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    for (const bar of scope.querySelectorAll<HTMLElement>(selector)) {
      const box = bar.getBoundingClientRect();
      const under = open ? Math.max(0, Math.round(box.right - edge)) : 0;
      // A toolbar that is all but covered stays as it is: there is no room to move its tools to.
      const cover = box.width - under >= 120 ? under : 0;
      const value = cover ? `${cover}px` : "";
      if (bar.style.getPropertyValue("--kd-drawer-cover") === value) continue;
      const parts = slide && !still ? [...bar.children] : [];
      const before = parts.map(part => part.getBoundingClientRect().left);
      if (cover) bar.style.setProperty("--kd-drawer-cover", value);
      else bar.style.removeProperty("--kd-drawer-cover");
      parts.forEach((part, index) => {
        const shift = before[index] - part.getBoundingClientRect().left;
        if (Math.abs(shift) < 1 || typeof part.animate !== "function") return;
        part.animate([{ transform: `translateX(${shift}px)` }, { transform: "translateX(0)" }],
          { duration: open ? 460 : LEAVE_MS, easing: open ? ARRIVE : LEAVE });
      });
    }
  };
  // Every commit while open: the list's panes come and go without the drawer being told.
  useLayoutEffect(() => {
    const changed = was.current !== open;
    was.current = open;
    if (open || changed) sync.current(changed);
  });
  useEffect(() => {
    const node = host.current;
    if (!open || !selector || !node?.parentElement || typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(() => sync.current(false));
    resized.observe(node);
    resized.observe(node.parentElement);
    return () => resized.disconnect();
  }, [host, open, selector]);
}

/**
 * The drawer over the right of the list. Its head hangs from the top chrome beside the search
 * and is always there: rolled up it lists the apps that are opened by hand, and while an app is
 * open it carries that app's title row. The sheet rolls down from the head's lower edge, one
 * app at a time: a new app comes down over the one that was there, which rolls up beneath it
 * and is gone; nothing waits underneath to come back. The sheet covers the list instead of
 * taking a column from it, so the list never reflows while the drawer moves.
 */
export function DrawerHost({ spec, entries = [], clear, hostRef, onResizeStart }: {
  /** The app to show, described by its schema; null rolls the drawer up. */
  spec: DrawerSpec | null;
  /** What the rolled-up head offers. */
  entries?: readonly DrawerEntry[];
  /** Toolbars inside the host's parent that the sheet passes over (a selector). */
  clear?: string;
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
  // Whether anything has been opened or closed since the head appeared (it plays no motion before).
  const [moved, setMoved] = useState(false);
  if ((spec?.id ?? null) !== (front?.id ?? null)) {
    if (!moved) setMoved(true);
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
  useClearToolbars(host, clear, !!spec);
  const panel = useId();
  // The open app's entry puts it away; any other asks for its own app.
  const ask = (entry: DrawerEntry) => { if (spec?.id === entry.id) spec.close(); else entry.open(); };
  return <div ref={setHost} className="kd-drawer-host" data-open={spec ? "true" : undefined} data-moved={moved || undefined}>
    <div className="kd-drawer-lip" aria-hidden="true" />
    <div className="kd-drawer-sheets">
      {layers.map(layer => {
        const shown = layer.leaving ?? spec;
        return shown ? <DrawerLayer key={layer.key} spec={shown} leaving={!!layer.leaving} panelId={`${panel}-${layer.key}`}
          onResizeStart={onResizeStart} onGone={() => setLayers(list => list.filter(item => item.key !== layer.key))} /> : null;
      })}
    </div>
    <div className="kd-drawer-head">
      {entries.length ? <nav className="kd-drawer-launcher" aria-label="侧边应用" aria-hidden={spec ? true : undefined} inert={!!spec}>
        <DrawerEntries entries={entries} front={null} compact={false} live={!spec} onAsk={ask} />
      </nav> : null}
      <div className="kd-drawer-titles">
        {layers.map(layer => {
          const shown = layer.leaving ?? spec;
          if (!shown) return null;
          const gone = !!layer.leaving;
          // A title that is leaving is only its words: the tools belong to the app that took over.
          return <div key={layer.key} className="kd-drawer-title" data-leaving={gone || undefined}
            aria-hidden={gone || undefined} inert={gone}>
            <DrawerContext.Provider value={shown.id}>
              <TitleTabs label={shown.title} title={shown.title} tabs={shown.pages} value={shown.page}
                onChange={gone ? undefined : shown.onPage} panelId={shown.pages ? `${panel}-${layer.key}` : undefined}
                caption={shown.caption}>
                {gone ? null : shown.tools}
              </TitleTabs>
            </DrawerContext.Provider>
          </div>;
        })}
      </div>
      {layers.length ? <div className="kd-drawer-tail" data-leaving={spec ? undefined : "true"} inert={!spec}>
        <DrawerEntries entries={entries} front={spec?.id ?? null} compact live={!!spec} onAsk={ask} />
        <button type="button" className="kd-drawer-rollup" aria-label={spec ? `收起${spec.title}` : "收起"}
          title={spec ? `收起${spec.title} · Esc` : undefined} onClick={() => { spec?.close(); }}>
          <ChevronsUp size={16} aria-hidden="true" />
        </button>
      </div> : null}
    </div>
  </div>;
}
