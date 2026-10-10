import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronsDown, ChevronsUpDown, Info, LoaderCircle } from "lucide-react";
import { useCoverLoad } from "../../lib/coverLoad";
import { playerBarMoving, usePlayerBarAway } from "../../lib/playerBarAway";
import { prefersReducedSeekMotion } from "../../lib/seekTransition";
import {
  SONG_SWAP_IN_EASE,
  SONG_SWAP_IN_MS,
  SONG_SWAP_OUT_EASE,
  SONG_SWAP_OUT_MS,
  setSongSurfacePresent,
} from "../../lib/songSwapMotion";
import { MarqueeText } from "../common/MarqueeText";
import { useSurfaceBackdrop } from "../common/SurfaceBackdrop";
import { VinylPlaceholder } from "../common/VinylPlaceholder";
import { TASK_COVER_LIMIT, taskStay, type TaskCover, type TaskBubbleSpec } from "./taskBubbleSchema";
import { useTaskBubbles, type TaskBubbleEntry } from "./taskBubbleStore";
import { startTaskSources, type TaskSource } from "./taskSources";
import "./TaskBubbles.css";

/** The gap between two bubbles of the stack, in px. The gap to the bar and the window edge is
 *  --kd-task-gap in TaskBubbles.css. */
const STACK_GAP = 8;
const EDGE_GAP = 12;
/** The exit under reduced motion: a short fade. */
const REDUCED_LEAVE_MS = 140;

const TASK_CLOCK = {
  "--kd-task-in": `${SONG_SWAP_IN_MS}ms`,
  "--kd-task-out": `${SONG_SWAP_OUT_MS}ms`,
  "--kd-task-in-ease": SONG_SWAP_IN_EASE,
  "--kd-task-out-ease": SONG_SWAP_OUT_EASE,
} as CSSProperties;

function TaskCoverImage({ cover }: { cover: TaskCover }) {
  const owner = typeof cover === "string" ? cover : cover.key;
  const urls = typeof cover === "string" ? [cover] : cover.urls;
  const load = useCoverLoad(owner, urls);
  return <span className="kd-task-cover" data-face={load.face}>
    {load.face !== "image" && <VinylPlaceholder />}
    {load.src && <img key={owner} ref={load.imageRef} src={load.src} alt="" draggable={false}
      referrerPolicy="no-referrer" onLoad={load.onLoad} onError={load.onError} />}
  </span>;
}

function coverKey(cover: TaskCover): string {
  return typeof cover === "string" ? cover : String(cover.key);
}

function ToneMark({ tone, size = 16 }: { tone: NonNullable<TaskBubbleSpec["tone"]>; size?: number }) {
  const Icon = tone === "error" ? AlertTriangle : tone === "success" ? Check : Info;
  return <Icon size={size} strokeWidth={size < 14 ? 2.6 : 2} aria-hidden="true" />;
}

/** Up to three covers overlapping, how many more there are, and how the task ended. */
function TaskCoverStack({ covers, count, tone }: { covers: readonly TaskCover[]; count: number; tone: NonNullable<TaskBubbleSpec["tone"]> }) {
  const shown = covers.slice(0, TASK_COVER_LIMIT);
  const more = Math.max(covers.length, count) - shown.length;
  return <span className="kd-task-covers" data-count={shown.length}>
    <span className="kd-task-cover-row">
      {shown.map(cover => <TaskCoverImage key={coverKey(cover)} cover={cover} />)}
      {tone !== "info" && <span className="kd-task-badge"><ToneMark tone={tone} size={10} /></span>}
    </span>
    {more > 0 && <span className="kd-task-more">+{more}</span>}
  </span>;
}

/** What a bubble of each kind is called. A theme pack that draws a bubble as a small window
 *  writes this on its caption bar (Sakura98, in TaskBubbles.css); the built-in themes show no
 *  name. A kind without a name of its own is a note. */
const TASK_KIND_NAMES: Readonly<Record<string, string | undefined>> = {
  playing: "正在播放",
  download: "下载",
  export: "导出",
  import: "导入",
};
const TASK_NOTE_NAME = "提示";

function TaskBubble({ entry, lift, front, held, onHeld, onSize }: {
  entry: TaskBubbleEntry;
  /** How far above its resting place at the bottom of the stack this bubble sits, in px. */
  lift: number;
  /** Newer bubbles are drawn over older ones, so one that leaves sinks behind them. */
  front: number;
  held: boolean;
  onHeld(id: string, held: boolean): void;
  onSize(id: string, height: number | null): void;
}) {
  const id = entry.spec.id;
  const reduced = prefersReducedSeekMotion();
  const node = useRef<HTMLElement>(null);

  // A bubble about the playing song keeps the old song while it rolls down, then rises with
  // the new one.
  const [shownSong, setShownSong] = useState(entry.spec.song);
  const kept = useRef(entry.spec);
  const changed = shownSong !== entry.spec.song;
  const swapping = changed && shownSong !== undefined && entry.spec.song !== undefined && !entry.leaving && !reduced;
  if (!changed) kept.current = entry.spec;
  const spec = swapping ? kept.current : entry.spec;
  useEffect(() => {
    if (!changed) return;
    if (!swapping) { setShownSong(entry.spec.song); return; }
    const timer = window.setTimeout(() => setShownSong(entry.spec.song), SONG_SWAP_OUT_MS);
    return () => window.clearTimeout(timer);
    // The newest song is the one that rises: a later change starts the wait over.
  }, [changed, swapping, entry.spec.song]);
  const songBound = entry.spec.song !== undefined;
  useEffect(() => {
    if (!songBound) return;
    setSongSurfacePresent(`task:${id}`, true);
    return () => setSongSurfacePresent(`task:${id}`, false);
  }, [id, songBound]);

  useEffect(() => {
    if (!entry.leaving) return;
    const timer = window.setTimeout(() => useTaskBubbles.getState().remove(id, entry.token),
      reduced ? REDUCED_LEAVE_MS : SONG_SWAP_OUT_MS + 20);
    return () => window.clearTimeout(timer);
  }, [entry.leaving, entry.token, id, reduced]);

  // The stay is counted here and waits while the stack is in use.
  const stay = taskStay(entry.spec);
  const timed = stay > 0 && !entry.leaving;
  const countdown = useRef({ token: 0, remaining: stay });
  useEffect(() => {
    if (!timed) return;
    if (countdown.current.token !== entry.token) countdown.current = { token: entry.token, remaining: stay };
    if (held) return;
    const started = performance.now(), remaining = countdown.current.remaining;
    const timer = window.setTimeout(() => useTaskBubbles.getState().dismiss(id, "timeout"), remaining);
    return () => {
      window.clearTimeout(timer);
      countdown.current.remaining = Math.max(0, remaining - (performance.now() - started));
    };
  }, [timed, held, entry.token, stay, id]);

  const escape = !!entry.spec.escape && !entry.leaving;
  useEffect(() => {
    if (!escape) return;
    const dismiss = (event: KeyboardEvent) => {
      // Escape inside a field belongs to that field; a draft is never dropped by a stray key.
      if (event.key !== "Escape" || event.defaultPrevented
        || (event.target instanceof Element && event.target.closest("input, textarea, select"))) return;
      event.preventDefault();
      useTaskBubbles.getState().dismiss(id, "user");
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [escape, id]);

  // The task's own controls may come and go while its bubble is up (the playing song's
  // transport, with the player bar away). The row then unfolds open or folds away instead of
  // jumping (TaskBubbles.css): it is in the bubble from before it has any height until after it
  // has lost it, and shows the controls it last had while it closes. A bubble that comes up
  // with its controls simply has them.
  const hasControls = spec.controls != null;
  const lastControls = useRef(spec.controls);
  if (hasControls) lastControls.current = spec.controls;
  const [controlsRow, setControlsRow] = useState(hasControls);
  const [controlsOpen, setControlsOpen] = useState(hasControls);
  const controlsClip = useRef<HTMLDivElement>(null);
  const controlsWere = useRef(hasControls);
  /** The row is on its way: the bubble's height is not what the stack stands on. */
  const folding = useRef(false);

  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    const report = () => { if (!folding.current) onSize(id, element.offsetHeight); };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => { observer.disconnect(); onSize(id, null); };
  }, [id, onSize]);
  useLayoutEffect(() => {
    if (controlsWere.current === hasControls) return;
    controlsWere.current = hasControls;
    const element = node.current, clip = controlsClip.current;
    if (!element || !clip) return;
    // Measured once, before the row moves: the height the bubble is going to. The stack above
    // and the drawer's limit move there in one step, on the row's own clock, instead of
    // following its height frame by frame.
    folding.current = true;
    onSize(id, element.offsetHeight - clip.offsetHeight + (hasControls ? clip.scrollHeight : 0));
    setControlsRow(true);
    setControlsOpen(hasControls);
    const timer = window.setTimeout(() => {
      folding.current = false;
      if (hasControls) onSize(id, element.offsetHeight);
      else setControlsRow(false);
    }, (reduced ? REDUCED_LEAVE_MS : SONG_SWAP_IN_MS) + 20);
    return () => window.clearTimeout(timer);
  }, [hasControls, id, onSize, reduced]);
  useEffect(() => () => onHeld(id, false), [id, onHeld]);

  const [ownExpanded, setOwnExpanded] = useState(false);
  const expandable = spec.body != null;
  const expanded = expandable && (spec.onExpand ? !!spec.expanded : ownExpanded);
  const setExpanded = (next: boolean) => { if (spec.onExpand) spec.onExpand(next); else setOwnExpanded(next); };
  const tone = spec.tone ?? "info";
  const covers = spec.covers ?? [];
  const summary = !(expanded && spec.replacesSummary);
  const progress = typeof spec.progress === "number" ? Math.min(1, Math.max(0, spec.progress)) : null;
  const dismissLabel = spec.dismiss?.label ?? "收起";
  // The task's own layer under everything the bubble holds, and the ink that layer asks for.
  const backdrop = useSurfaceBackdrop(spec.backdrop);
  const copy = <>
    {tone === "error"
      ? <span className="kd-task-title" data-wrap="true" title={spec.title}>{spec.title}</span>
      : <MarqueeText className="kd-task-title" text={spec.title} />}
    {spec.detail && <span className="kd-task-detail" title={spec.detail}>{spec.detail}</span>}
    {(spec.origin || !!spec.facts?.length) && <span className="kd-task-facts">
      {spec.origin && <span className="kd-task-origin" role="img" aria-label={spec.origin.label} title={spec.origin.label}>{spec.origin.mark}</span>}
      {spec.facts?.map(fact => <span key={fact}>{fact}</span>)}
    </span>}
    {progress !== null && <span className="kd-task-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)} aria-label={`${spec.title} 进度`}>
      <i style={{ transform: `scaleX(${progress})` }} />
    </span>}
  </>;
  const open = spec.onOpen;
  return <div className="kd-task-slot" data-size={spec.size ?? "regular"} style={{ "--kd-task-lift": `${lift}px`, zIndex: front } as CSSProperties}>
    <article ref={node} className="kd-task" role={tone === "error" ? "alert" : "status"}
      data-kind={spec.kind} data-tone={tone} data-phase={entry.leaving || swapping ? "out" : "in"}
      data-expanded={expanded || undefined} data-held={held || undefined}
      data-controls={hasControls || undefined} {...backdrop.attributes} style={backdrop.style}
      onPointerEnter={() => onHeld(id, true)} onPointerLeave={() => onHeld(id, false)}
      onFocus={() => onHeld(id, true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onHeld(id, false); }}>
      {backdrop.layer}
      <div className="kd-task-main" data-opens={open ? "true" : undefined} data-bare={summary ? undefined : "true"}
        onClick={open ? event => { if (!(event.target as Element).closest("button, a, input")) open(); } : undefined}>
        {summary && (covers.length > 0
          ? <TaskCoverStack covers={covers} count={spec.count ?? covers.length} tone={tone} />
          : <span className="kd-task-mark">{spec.icon ?? <ToneMark tone={tone} />}</span>)}
        {summary && (open
          ? <button type="button" className="kd-task-copy" onClick={open}>{copy}</button>
          : <div className="kd-task-copy">{copy}</div>)}
        <div className="kd-task-tools" data-caption={TASK_KIND_NAMES[spec.kind] ?? TASK_NOTE_NAME}>
          {timed && <svg key={entry.token} className="kd-task-countdown" viewBox="0 0 16 16" role="img" aria-label="即将收起"
            style={{ "--kd-task-stay": `${stay}ms` } as CSSProperties}>
            <circle cx="8" cy="8" r="5.5" />
            <circle cx="8" cy="8" r="5.5" pathLength={1} />
          </svg>}
          {spec.actions?.map(action => <button key={action.id} type="button" className="kd-task-action" data-task-action={action.id}
            aria-label={action.label} title={action.label} aria-pressed={action.pressed}
            aria-busy={action.busy || undefined} onClick={() => { if (node.current) action.onSelect(node.current); }}>
            {action.busy ? <LoaderCircle size={14} className="kd-spin" aria-hidden="true" /> : action.icon}
          </button>)}
          {expandable && <button type="button" className="kd-task-action" aria-expanded={expanded}
            aria-label={expanded ? "收起详情" : "展开详情"} title={expanded ? "收起详情" : "展开详情"}
            onClick={() => setExpanded(!expanded)}>
            <ChevronsUpDown size={14} aria-hidden="true" />
          </button>}
          <button type="button" className="kd-task-action kd-task-dismiss" aria-label={dismissLabel}
            title={spec.escape ? `${dismissLabel}（Esc）` : dismissLabel}
            onClick={() => useTaskBubbles.getState().dismiss(id, "user")}>
            {spec.dismiss?.icon ?? <ChevronsDown size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {expanded && <div className="kd-task-body kd-scroll">{spec.body}</div>}
      {(hasControls || controlsRow) && <div className="kd-task-controls" data-open={hasControls && controlsOpen ? "true" : undefined}
        inert={!hasControls}>
        <div ref={controlsClip} className="kd-task-controls-clip">
          <div className="kd-task-controls-row">{hasControls ? spec.controls : lastControls.current}</div>
        </div>
      </div>}
    </article>
  </div>;
}

/**
 * 任务信息: the one place task bubbles are drawn. They rise from behind the top edge of the
 * player bar to a resting place detached from it, at the bottom right, and roll back down;
 * several stack upwards with the newest nearest the bar. With the bar put away they stand on
 * the window's bottom edge instead, and the playing song's bubble is always among them. In a
 * tall desktop window a large bubble spans the window (TaskBubbles.css). `sources` names the
 * app's own activities this window reports (see taskSources.ts).
 */
export function TaskBubbleHost({ sources }: { sources?: readonly TaskSource[] }) {
  const entries = useTaskBubbles(state => state.entries);
  const [sizes, setSizes] = useState<Readonly<Record<string, number>>>({});
  const [holds, setHolds] = useState<readonly string[]>([]);
  const onSize = useCallback((id: string, height: number | null) => {
    setSizes(before => {
      if (height === null) {
        if (!(id in before)) return before;
        const { [id]: _gone, ...rest } = before;
        return rest;
      }
      return before[id] === height ? before : { ...before, [id]: height };
    });
  }, []);
  const onHeld = useCallback((id: string, held: boolean) => {
    setHolds(before => held === before.includes(id) ? before : held ? [...before, id] : before.filter(other => other !== id));
  }, []);
  const sourceKey = sources?.join(",") ?? "";
  useEffect(() => sourceKey ? startTaskSources(sourceKey.split(",") as TaskSource[]) : undefined, [sourceKey]);

  // The stack stands on the top edge of the player bar; without a bar, on the window's bottom.
  // `floor` is the bar's height. A bar that is put away (src/lib/playerBarAway.ts) lies over the
  // page from the moment it starts to slide: the host then reaches the window's bottom, and the
  // bubbles that are up ride the bar's top edge down, or back up, by a transform on the same
  // clock. That is settled when the slide starts: with nothing standing on the bar there is
  // nothing to carry, and a bubble the slide itself brings (the playing song, as the bar goes)
  // rises from the window's edge while the bar sinks behind it.
  const [floor, setFloor] = useState(0);
  const barPhase = usePlayerBarAway(state => state.phase);
  const ride = useRef({ phase: barPhase, on: false });
  if (ride.current.phase !== barPhase) {
    ride.current = { phase: barPhase, on: playerBarMoving(barPhase) && entries.some(entry => !entry.leaving) };
  }
  const riding = ride.current.on;
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setRoot(document.querySelector<HTMLElement>(".kd-app")); }, []);
  useLayoutEffect(() => {
    if (!root) return;
    let bar: HTMLElement | null = null;
    const size = new ResizeObserver(() => setFloor(bar?.offsetHeight ?? 0));
    const find = () => {
      const next = root.querySelector<HTMLElement>(":scope > .kd-player");
      if (next === bar) return;
      if (bar) size.unobserve(bar);
      bar = next;
      if (bar) size.observe(bar);
      setFloor(bar?.offsetHeight ?? 0);
    };
    find();
    const children = new MutationObserver(find);
    children.observe(root, { childList: true });
    return () => { children.disconnect(); size.disconnect(); };
  }, [root]);

  // Newest first: each bubble that is staying lifts the older ones above it. One that is
  // leaving gives its place up at once and keeps the lift it had.
  const ordered = [...entries].sort((a, b) => b.order - a.order);
  const lifts = useRef<Record<string, number>>({});
  let stacked = 0, kept = 0;
  for (const entry of ordered) {
    const id = entry.spec.id;
    if (entry.leaving) { lifts.current[id] ??= stacked; continue; }
    lifts.current[id] = stacked;
    const height = sizes[id] ?? 0;
    if (taskStay(entry.spec) === 0) kept = Math.max(kept, stacked + height + EDGE_GAP * 2);
    stacked += height + STACK_GAP;
  }
  for (const id of Object.keys(lifts.current)) if (!entries.some(entry => entry.spec.id === id)) delete lifts.current[id];

  // The drawer over the list ends above a bubble that is kept up (see --kd-info-lift in
  // Drawer.css). A bubble that leaves by itself may cover the drawer's bottom for its stay.
  // While a stack rides the sliding bar, the list already reaches the window's bottom and the
  // stack is still on the bar: the drawer keeps clear of the bar's height as well, and takes
  // that room when the bar is gone.
  const lift = kept > 0 ? Math.round(kept + (riding ? floor : 0)) : 0;
  useEffect(() => {
    if (lift > 0) document.documentElement.style.setProperty("--kd-info-lift", `${lift}px`);
    else document.documentElement.style.removeProperty("--kd-info-lift");
  }, [lift]);
  useEffect(() => () => { document.documentElement.style.removeProperty("--kd-info-lift"); }, []);

  if (entries.length === 0) return null;
  return createPortal(
    <div className="kd-task-host" data-floor={riding && !prefersReducedSeekMotion() ? (barPhase === "leaving" ? "down" : "up") : undefined}
      style={{ ...TASK_CLOCK, "--kd-task-floor": `${barPhase === "up" ? floor : 0}px`, "--kd-task-ride": `${floor}px` } as CSSProperties}>
      {ordered.map((entry, index) => <TaskBubble key={`${entry.spec.id}:${entry.order}`} entry={entry}
        lift={lifts.current[entry.spec.id] ?? 0} front={ordered.length - index}
        held={holds.length > 0} onHeld={onHeld} onSize={onSize} />)}
    </div>,
    root ?? document.body,
  );
}
