import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronsDown, ChevronsUp, ChevronsUpDown, Info, LoaderCircle } from "lucide-react";
import { useCoverLoad } from "../../lib/coverLoad";
import { useMiniPlayer } from "../../lib/miniPlayer";
import { MOTION_MICRO_MS, MOTION_MICRO_OUT_MS, MOTION_REDUCED_MS } from "../../lib/motion";
import { playerBarMoving, usePlayerBarAway } from "../../lib/playerBarAway";
import { prefersReducedSeekMotion } from "../../lib/seekTransition";
import { readLocalStorage, writeLocalStorageSoon } from "../../lib/storageWrite";
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
import { TASK_COVER_LIMIT, taskStay, type TaskCover, type TaskBubbleSpec, type TaskPlacement, type TaskSize } from "./taskBubbleSchema";
import { taskEntryKey, useTaskBubbles, type TaskBubbleEntry } from "./taskBubbleStore";
import { startTaskSources, type TaskSource } from "./taskSources";
import { usePreparedTaskCovers } from "./taskCoverPreparation";
import "./TaskBubbles.css";

/** The gap between two bubbles of a stack, in px. */
const STACK_GAP = 8;
/** The gap between a stack and the edges it stands on and beside: --kd-task-gap in
 *  TaskBubbles.css, which at the top is the drawer's own gap. */
const EDGE_GAP: Record<TaskPlacement, number> = { bottom: 12, top: 10 };
/** How far inside the top edge of a base bubble a bubble that comes out from behind it starts,
 *  so that nothing of its edge or shadow shows before it moves. */
const BEHIND_INSET = 6;
const SIZE_RANK: Record<TaskSize, number> = { small: 0, regular: 1, large: 2 };
/** A resizable bubble (TaskBubbleSpec.resizable) is never narrower than this, in px. */
const RESIZE_MIN = 288;
const widthKey = (kind: string) => `kd-task-width:${kind}`;
function storedWidth(kind: string): number | null {
  const value = Number(readLocalStorage(widthKey(kind)));
  return Number.isFinite(value) && value >= RESIZE_MIN ? value : null;
}
/** The widest a bubble may be: the host's width less its gaps. */
const resizeMax = (slot: HTMLElement) => Math.max(RESIZE_MIN, (slot.parentElement?.clientWidth ?? window.innerWidth) - 2 * EDGE_GAP.bottom);

/**
 * The inner edge of a resizable bubble, as a grip: dragging it sets the bubble's width (the
 * right edge stays where the stack stands), double-clicking gives the bubble its usual width.
 */
function ResizeGrip({ kind, width, onWidth }: { kind: string; width: number | null; onWidth(width: number | null): void }) {
  return <span className="kd-task-resize" role="separator" aria-orientation="vertical" aria-label="调整宽度"
    onDoubleClick={() => { onWidth(null); writeLocalStorageSoon(widthKey(kind), ""); }}
    onPointerDown={event => {
      const slot = event.currentTarget.parentElement;
      if (!slot || event.button !== 0) return;
      event.preventDefault();
      const grip = event.currentTarget;
      grip.setPointerCapture(event.pointerId);
      const startX = event.clientX, startWidth = width ?? slot.getBoundingClientRect().width, max = resizeMax(slot);
      let last = startWidth;
      const move = (moved: PointerEvent) => {
        last = Math.round(Math.min(max, Math.max(RESIZE_MIN, startWidth + startX - moved.clientX)));
        onWidth(last);
      };
      const end = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", end);
        grip.removeEventListener("pointercancel", end);
        writeLocalStorageSoon(widthKey(kind), String(last));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", end);
      grip.addEventListener("pointercancel", end);
    }} />;
}

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
function TaskCoverStack({ covers, count, tone, turn }: {
  covers: readonly TaskCover[]; count: number; tone: NonNullable<TaskBubbleSpec["tone"]>; turn?: "in" | "out";
}) {
  const shown = covers.slice(0, TASK_COVER_LIMIT);
  const more = Math.max(covers.length, count) - shown.length;
  return <span className="kd-task-covers" data-count={shown.length} data-kd-turn={turn}>
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

interface TaskBubbleProps {
  entry: TaskBubbleEntry;
  /** How far from the resting place nearest its stack's edge this bubble sits, in px. */
  lift: number;
  /** How far beyond its resting place it is out of sight, less its own height, in px: set for
   *  a bubble that comes and goes behind the base bubble. Null: beyond the stack's edge. */
  away: number | null;
  /** Bubbles nearer the stack's edge are drawn over those beyond them, so one that leaves goes
   *  behind what stays. */
  front: number;
  held: boolean;
  onHeld(key: string, held: boolean): void;
  onSize(key: string, height: number | null): void;
}

/** The playing song's bubble waits (briefly) for its cover: preparing is not an arrival, with no
 * empty surface, stack space or countdown yet, and an existing bubble keeps its picture while
 * the next covers load, though its live controls follow playback. Every other bubble comes up at
 * once and shows its covers as they load. */
function TaskBubble(props: TaskBubbleProps) {
  const { entry } = props;
  const covers = usePreparedTaskCovers(entry.spec.covers ?? [], entry.spec.kind === "playing");
  const previous = useRef<TaskBubbleEntry | null>(null);
  if (covers !== null && !entry.leaving) previous.current = { ...entry, spec: { ...entry.spec, covers } };
  const shown = previous.current;
  useEffect(() => {
    if (entry.leaving && !shown) useTaskBubbles.getState().remove(entry.spec.id, entry.token);
  }, [entry.leaving, entry.spec.id, entry.token, !!shown]);
  if (!shown) return null;
  const preparedEntry = covers !== null && !entry.leaving ? shown : {
    ...shown,
    leaving: entry.leaving,
    token: entry.leaving ? entry.token : shown.token,
    spec: entry.leaving ? shown.spec : { ...shown.spec, controls: entry.spec.controls, actions: entry.spec.actions,
      tools: entry.spec.tools, stay: entry.spec.stay, escape: entry.spec.escape,
      dismiss: entry.spec.dismiss, onDismiss: entry.spec.onDismiss },
  };
  return <ReadyTaskBubble {...props} entry={preparedEntry} preparing={covers === null} />;
}

function ReadyTaskBubble({ entry, lift, away, front, held, onHeld, onSize, preparing }: TaskBubbleProps & { preparing: boolean }) {
  const id = entry.spec.id;
  /** This arrival, in the host's books. */
  const key = taskEntryKey(entry);
  const reduced = prefersReducedSeekMotion();
  const mini = useMiniPlayer(state => state.phase === "on") && entry.spec.song !== undefined;
  const node = useRef<HTMLElement>(null);
  const resizable = !!entry.spec.resizable;
  const [width, setWidth] = useState(() => (resizable ? storedWidth(entry.spec.kind) : null));

  // A bubble about the playing song keeps the old song while it rolls down, then rises with
  // the new one.
  const [shownSong, setShownSong] = useState(entry.spec.song);
  const kept = useRef(entry.spec);
  const changed = shownSong !== entry.spec.song;
  const swapping = changed && shownSong !== undefined && entry.spec.song !== undefined && !entry.leaving && (!reduced || mini);
  if (!changed) kept.current = entry.spec;
  const spec = swapping || (changed && entry.leaving) ? kept.current : entry.spec;
  const [turningIn, setTurningIn] = useState(false);
  const wasSwapping = useRef(false);
  useLayoutEffect(() => {
    if (swapping) wasSwapping.current = true;
    else if (wasSwapping.current) {
      wasSwapping.current = false;
      // Also bring the old content back if a rapid skip returned to its song mid-exit.
      setTurningIn(mini && !entry.leaving);
    }
  }, [swapping, mini, entry.leaving]);
  const exitMs = mini ? (reduced ? MOTION_REDUCED_MS : MOTION_MICRO_OUT_MS) : SONG_SWAP_OUT_MS;
  useEffect(() => {
    if (!changed || preparing || entry.leaving) return;
    if (!swapping) { setShownSong(entry.spec.song); return; }
    const timer = window.setTimeout(() => {
      setShownSong(entry.spec.song);
    }, exitMs);
    return () => window.clearTimeout(timer);
    // The newest prepared song is the one that arrives; skipped songs do not queue.
  }, [changed, swapping, entry.spec.song, entry.leaving, exitMs, mini, preparing]);
  useEffect(() => {
    if (!turningIn) return;
    const timer = window.setTimeout(() => setTurningIn(false), reduced ? MOTION_REDUCED_MS : MOTION_MICRO_MS);
    return () => window.clearTimeout(timer);
  }, [turningIn, shownSong, reduced]);
  // The window stays put. Only the cover and copy turn, using the work rail/search text's
  // existing gesture; the transport and window keys remain available throughout.
  const turn = mini ? swapping ? "out" : turningIn ? "in" : undefined : undefined;
  const songBound = entry.spec.song !== undefined;
  useEffect(() => {
    if (!songBound) return;
    setSongSurfacePresent(`task:${key}`, true);
    return () => setSongSurfacePresent(`task:${key}`, false);
  }, [key, songBound]);

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
    if (held || preparing || swapping) return;
    const started = performance.now(), remaining = countdown.current.remaining;
    const timer = window.setTimeout(() => useTaskBubbles.getState().dismiss(id, "timeout"), remaining);
    return () => {
      window.clearTimeout(timer);
      countdown.current.remaining = Math.max(0, remaining - (performance.now() - started));
    };
  }, [timed, held, preparing, swapping, entry.token, stay, id]);

  const escape = !!entry.spec.escape && !entry.spec.held && !entry.leaving;
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
  const controls = mini ? entry.spec.controls : spec.controls;
  const hasControls = controls != null;
  const lastControls = useRef(controls);
  if (hasControls) lastControls.current = controls;
  const [controlsRow, setControlsRow] = useState(hasControls);
  const [controlsOpen, setControlsOpen] = useState(hasControls);
  const controlsClip = useRef<HTMLDivElement>(null);
  const controlsWere = useRef(hasControls);
  /** The row is on its way: the bubble's height is not what the stack stands on. */
  const folding = useRef(false);

  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    const report = () => { if (!folding.current) onSize(key, element.offsetHeight); };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => { observer.disconnect(); onSize(key, null); };
  }, [key, onSize]);
  useLayoutEffect(() => {
    if (controlsWere.current === hasControls) return;
    controlsWere.current = hasControls;
    const element = node.current, clip = controlsClip.current;
    if (!element || !clip) return;
    // Measured once, before the row moves: the height the bubble is going to. The rest of the
    // stack and the drawer's limit move there in one step, on the row's own clock, instead of
    // following its height frame by frame.
    folding.current = true;
    onSize(key, element.offsetHeight - clip.offsetHeight + (hasControls ? clip.scrollHeight : 0));
    setControlsRow(true);
    setControlsOpen(hasControls);
    const timer = window.setTimeout(() => {
      folding.current = false;
      if (hasControls) onSize(key, element.offsetHeight);
      else setControlsRow(false);
    }, (reduced ? REDUCED_LEAVE_MS : SONG_SWAP_IN_MS) + 20);
    return () => window.clearTimeout(timer);
  }, [hasControls, key, onSize, reduced]);
  useEffect(() => () => onHeld(key, false), [key, onHeld]);

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
  // The key that sends it away points the way it goes.
  const Away = entry.place === "top" ? ChevronsUp : ChevronsDown;
  return <div className="kd-task-slot" data-size={spec.size ?? "regular"} data-resizable={resizable || undefined}
    style={{ "--kd-task-lift": `${lift}px`, "--kd-task-away": away === null ? undefined : `${away}px`, zIndex: front,
      width: resizable && width !== null ? `min(${width}px, calc(100% - 2 * var(--kd-task-gap)))` : undefined } as CSSProperties}>
    {resizable && !entry.leaving && <ResizeGrip kind={entry.spec.kind} width={width} onWidth={setWidth} />}
    <article ref={node} className="kd-task" role={tone === "error" ? "alert" : "status"}
      data-kind={spec.kind} data-tone={tone} data-phase={entry.leaving || swapping ? "out" : "in"}
      data-expanded={expanded || undefined} data-held={held || preparing || swapping || undefined}
      data-controls={hasControls || undefined} {...backdrop.attributes} style={backdrop.style}
      onPointerEnter={() => onHeld(key, true)} onPointerLeave={() => onHeld(key, false)}
      onFocus={() => onHeld(key, true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onHeld(key, false); }}>
      {backdrop.layer}
      <div className="kd-task-main" data-opens={open ? "true" : undefined} data-bare={summary ? undefined : "true"}
        onClick={open ? event => { if (!(event.target as Element).closest("button, a, input")) open(); } : undefined}>
        {summary && (covers.length > 0
          ? <TaskCoverStack covers={covers} count={spec.count ?? covers.length} tone={tone} turn={turn} />
          : <span className="kd-task-mark" data-kd-turn={turn}>{spec.icon ?? <ToneMark tone={tone} />}</span>)}
        {summary && (open
          ? <button type="button" className="kd-task-copy" data-kd-turn={turn} inert={swapping} aria-hidden={swapping || undefined} onClick={open}>{copy}</button>
          : <div className="kd-task-copy" data-kd-turn={turn} inert={swapping} aria-hidden={swapping || undefined}>{copy}</div>)}
        <div className="kd-task-tools" data-caption={TASK_KIND_NAMES[spec.kind] ?? TASK_NOTE_NAME}>
          {timed && <svg key={entry.token} className="kd-task-countdown" viewBox="0 0 16 16" role="img" aria-label="即将收起"
            style={{ "--kd-task-stay": `${stay}ms` } as CSSProperties}>
            <circle cx="8" cy="8" r="5.5" />
            <circle cx="8" cy="8" r="5.5" pathLength={1} />
          </svg>}
          {(mini ? entry.spec.actions : spec.actions)?.map(action => <button key={action.id} type="button" className="kd-task-action" data-task-action={action.id}
            aria-label={action.label} title={action.label} aria-pressed={action.pressed}
            aria-haspopup={action.onContextMenu ? "menu" : undefined}
            aria-expanded={action.onContextMenu ? !!action.menuOpen : undefined}
            onContextMenu={action.onContextMenu ? event => {
              event.preventDefault();
              action.onContextMenu?.(event.currentTarget, event.clientX === 0 && event.clientY === 0 ? "keyboard" : "pointer");
            } : undefined}
            onKeyDown={action.onContextMenu ? event => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              action.onContextMenu?.(event.currentTarget, "keyboard");
            } : undefined}
            aria-busy={action.busy || undefined} onClick={() => { if (node.current) action.onSelect(node.current); }}>
            {action.busy ? <LoaderCircle size={14} className="kd-spin" aria-hidden="true" /> : action.icon}
          </button>)}
          {spec.tools}
          {expandable && <button type="button" className="kd-task-action" aria-expanded={expanded}
            aria-label={expanded ? "收起详情" : "展开详情"} title={expanded ? "收起详情" : "展开详情"}
            onClick={() => setExpanded(!expanded)}>
            <ChevronsUpDown size={14} aria-hidden="true" />
          </button>}
          {!spec.held && <button type="button" className="kd-task-action kd-task-dismiss" aria-label={dismissLabel}
            title={spec.escape ? `${dismissLabel}（Esc）` : dismissLabel}
            onClick={() => useTaskBubbles.getState().dismiss(id, "user")}>
            {spec.dismiss?.icon ?? <Away size={14} aria-hidden="true" />}
          </button>}
        </div>
      </div>
      {expanded && <div className="kd-task-body kd-scroll">{spec.body}</div>}
      {(hasControls || controlsRow) && <div className="kd-task-controls" data-open={hasControls && controlsOpen ? "true" : undefined}
        inert={!hasControls}>
        <div ref={controlsClip} className="kd-task-controls-clip">
          <div className="kd-task-controls-row">{hasControls ? controls : lastControls.current}</div>
        </div>
      </div>}
    </article>
  </div>;
}

/** One place's stack, as the host lays it out. */
interface TaskStack {
  /** Nearest the stack's edge first: the base, then the newest. */
  ordered: TaskBubbleEntry[];
  /** How far the bubbles that are kept up reach from the edge, the gap on either side of them
   *  included; 0 with none. */
  kept: number;
  /** How far the bubbles that are staying reach from the edge, the gaps before the first and
   *  after the last included; 0 with none. */
  reach: number;
  /** Per arrival: where it is out of sight behind the base bubble (see TaskBubble's `away`). */
  away: Record<string, number>;
}

/**
 * Lay one place's stack out. A base bubble rests nearest the edge whatever came after it; then
 * the newest, each one that is staying moving the older ones further out by its own height.
 * One that is leaving gives its place up at once and keeps the lift it had (`lifts`, the host's
 * record, is brought up to date here).
 *
 * A bubble beyond a base that is staying comes out from behind it and goes back behind it,
 * instead of crossing its face from the stack's edge: the base is drawn over it, and `away` is
 * where it is wholly behind the base. That holds while the base is at least as large a size
 * and tall enough to hide it; otherwise it travels to the stack's edge like any other.
 */
function layStack(place: TaskPlacement, entries: readonly TaskBubbleEntry[], sizes: Readonly<Record<string, number>>,
  lifts: Record<string, number>): TaskStack {
  const ordered = entries.filter(entry => entry.place === place)
    .sort((a, b) => Number(!!b.spec.base) - Number(!!a.spec.base) || b.order - a.order);
  const away: Record<string, number> = {};
  let stacked = 0, kept = 0, staying = 0;
  let cover: { from: number; to: number; rank: number } | null = null;
  for (const entry of ordered) {
    const key = taskEntryKey(entry);
    const height = sizes[key] ?? 0;
    if (height === 0) continue; // Still preparing: it takes no room in the stack or drawer.
    const rank = SIZE_RANK[entry.spec.size ?? "regular"];
    if (entry.leaving) lifts[key] ??= stacked;
    else lifts[key] = stacked;
    if (!entry.spec.base && cover && height > 0 && rank <= cover.rank && height + BEHIND_INSET <= cover.to - cover.from) {
      away[key] = lifts[key] - cover.to + BEHIND_INSET;
    }
    if (entry.leaving) continue;
    if (entry.spec.base) cover = { from: stacked, to: stacked + height, rank };
    if (taskStay(entry.spec) === 0) kept = Math.max(kept, stacked + height + EDGE_GAP[place] * 2);
    stacked += height + STACK_GAP;
    staying += 1;
  }
  return { ordered, kept, reach: staying > 0 ? EDGE_GAP[place] + stacked : 0, away };
}

/**
 * 任务信息: the one place task bubbles are drawn. There are two places a bubble can come up
 * (`placement` in its spec), each with a stack of its own that mirrors the other.
 *
 * At the bottom they rise from behind the top edge of the player bar to a resting place
 * detached from it, at the bottom right, and roll back down; several stack upwards with the
 * newest nearest the bar. With the bar put away they stand on the window's bottom edge instead,
 * and the playing song's bubble is the base of that stack. In a tall desktop window a large
 * bubble spans the window (TaskBubbles.css).
 *
 * At the top they drop from behind the bottom edge of the search row, at the top right where
 * the drawer hangs, and leave upwards; several stack downwards with the newest nearest that
 * edge. They lie over the drawer's panel, which stays where it is: notices above, settings
 * below.
 *
 * `sources` names the app's own activities this window reports (see taskSources.ts).
 */
export function TaskBubbleHost({ sources }: { sources?: readonly TaskSource[] }) {
  const entries = useTaskBubbles(state => state.entries);
  // The host's books are kept per arrival (taskEntryKey), not per id.
  const [sizes, setSizes] = useState<Readonly<Record<string, number>>>({});
  const [holds, setHolds] = useState<readonly string[]>([]);
  const onSize = useCallback((key: string, height: number | null) => {
    setSizes(before => {
      if (height === null) {
        if (!(key in before)) return before;
        const { [key]: _gone, ...rest } = before;
        return rest;
      }
      return before[key] === height ? before : { ...before, [key]: height };
    });
  }, []);
  const onHeld = useCallback((key: string, held: boolean) => {
    setHolds(before => held === before.includes(key) ? before : held ? [...before, key] : before.filter(other => other !== key));
  }, []);
  const sourceKey = sources?.join(",") ?? "";
  useEffect(() => sourceKey ? startTaskSources(sourceKey.split(",") as TaskSource[]) : undefined, [sourceKey]);

  // The bottom stack stands on the top edge of the player bar; without a bar, on the window's
  // bottom. `floor` is the bar's height. A bar that is put away (src/lib/playerBarAway.ts) lies
  // over the page from the moment it starts to slide: the host then reaches the window's
  // bottom, and the bubbles that are up ride the bar's top edge down, or back up, by a
  // transform on the same clock. That is settled when the slide starts: with nothing standing
  // on the bar there is nothing to carry, and a bubble the slide itself brings (the playing
  // song, as the bar goes) rises from the window's edge while the bar sinks behind it.
  const [floor, setFloor] = useState(0);
  const barPhase = usePlayerBarAway(state => state.phase);
  const ride = useRef({ phase: barPhase, on: false });
  if (ride.current.phase !== barPhase) {
    ride.current = { phase: barPhase, on: playerBarMoving(barPhase) && entries.some(entry => entry.place === "bottom" && !entry.leaving) };
  }
  const riding = ride.current.on;
  // A bar that comes back with nothing to carry finds the bubbles that are still up on their
  // way down at the window's edge (the playing song's, sent away to bring the bar back). There
  // is no top edge at rest to clip them at, so for that slide the stack is drawn under the bar
  // (TaskBubbles.css): they go down behind it, as they do behind its edge while it is up.
  const underBar = barPhase === "returning" && !riding;
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

  // The top stack hangs from the top edge of the place the drawer's panels have: the list's
  // column under the search row (.kd-drawer-area, see Drawer.css), which is two rows down in a
  // tall window and ends left of an editor column. It is measured when a bubble comes up
  // there and when that place changes size, never while one moves. A window without a drawer
  // (a phone, the editor windows) hangs it under the window's own top bar (TaskBubbles.css).
  const topUp = entries.some(entry => entry.place === "top");
  const [ceiling, setCeiling] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!root || !topUp) return;
    const area = root.querySelector<HTMLElement>(".kd-drawer-area");
    if (!area) { setCeiling(null); return; }
    const measure = () => {
      const box = area.getBoundingClientRect();
      // A list that is not laid out (another view has the window) has no such place.
      if (box.width === 0 && box.height === 0) { setCeiling(null); return; }
      const top = Math.round(box.top), right = Math.max(0, Math.round(document.documentElement.clientWidth - box.right));
      setCeiling(before => before && before.top === top && before.right === right ? before : { top, right });
    };
    measure();
    window.addEventListener("resize", measure);
    const resized = new ResizeObserver(measure);
    resized.observe(area);
    return () => { window.removeEventListener("resize", measure); resized.disconnect(); };
  }, [root, topUp]);

  const lifts = useRef<Record<string, number>>({});
  const bottom = layStack("bottom", entries, sizes, lifts.current);
  const top = layStack("top", entries, sizes, lifts.current);
  for (const key of Object.keys(lifts.current)) if (!entries.some(entry => taskEntryKey(entry) === key)) delete lifts.current[key];

  // The drawer over the list ends above a bottom bubble that is kept up (see --kd-info-lift in
  // Drawer.css). A bubble that leaves by itself may cover the drawer's bottom for its stay.
  // While a stack rides the sliding bar, the list already reaches the window's bottom and the
  // stack is still on the bar: the drawer keeps clear of the bar's height as well, and takes
  // that room when the bar is gone.
  const lift = bottom.kept > 0 ? Math.round(bottom.kept + (riding ? floor : 0)) : 0;
  useEffect(() => {
    if (lift > 0) document.documentElement.style.setProperty("--kd-info-lift", `${lift}px`);
    else document.documentElement.style.removeProperty("--kd-info-lift");
  }, [lift]);
  useEffect(() => () => { document.documentElement.style.removeProperty("--kd-info-lift"); }, []);

  if (entries.length === 0) return null;
  // The stay waits while the pointer or the focus is in a stack: that stack's, not the other's.
  const heldAt = (stack: TaskStack) => stack.ordered.some(entry => holds.includes(taskEntryKey(entry)));
  const bubbles = (stack: TaskStack) => {
    const held = heldAt(stack);
    return stack.ordered.map((entry, index) => {
      const key = taskEntryKey(entry);
      return <TaskBubble key={key} entry={entry} lift={lifts.current[key] ?? 0} away={stack.away[key] ?? null}
        front={stack.ordered.length - index} held={held} onHeld={onHeld} onSize={onSize} />;
    });
  };
  return createPortal(
    <>
      {bottom.ordered.length > 0 && <div className="kd-task-host" data-place="bottom"
        data-floor={riding && !prefersReducedSeekMotion() ? (barPhase === "leaving" ? "down" : "up") : undefined}
        data-under-bar={underBar ? "true" : undefined}
        style={{ ...TASK_CLOCK, "--kd-task-floor": `${barPhase === "up" ? floor : 0}px`, "--kd-task-ride": `${floor}px` } as CSSProperties}>
        {bubbles(bottom)}
      </div>}
      {top.ordered.length > 0 && <div className="kd-task-host" data-place="top"
        style={{ ...TASK_CLOCK, "--kd-task-ceiling": ceiling ? `${ceiling.top}px` : undefined,
          "--kd-task-ceiling-right": ceiling ? `${ceiling.right}px` : undefined } as CSSProperties}>
        {bubbles(top)}
      </div>}
    </>,
    root ?? document.body,
  );
}
