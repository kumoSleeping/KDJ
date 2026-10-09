import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { AudioLines, Layers2, ListMusic, Music2, Video, type LucideIcon } from "lucide-react";
import { useCoverLoad } from "../../lib/coverLoad";
import type { TaskCoverKind } from "../../lib/taskCovers";
import "./TaskCover.css";

const NO_URLS: readonly string[] = [];
const GLYPHS: Record<TaskCoverKind, LucideIcon> = {
  song: Music2,
  video: Video,
  mix: Layers2,
  visualizer: AudioLines,
  set: ListMusic,
};

/**
 * True once the box has come near the visible part of its scrolling list, and from then on. A
 * queue can hold hundreds of rows; only the ones that were ever near the viewport ask for a
 * picture, and one that has asked keeps it instead of loading again on the way back.
 */
function useNearViewport(host: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = host.current;
    if (near || !node) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNear(true);
      observer.disconnect();
    }, { root: node.closest(".kd-scroll"), rootMargin: "240px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [host, near]);
  return near;
}

export interface TaskCoverProps {
  /** Every address that can show the task's picture, best first (see `lib/taskCovers`). */
  urls: readonly string[];
  /**
   * Whose picture this is. A row that is keyed by its task can leave it out; a box that goes on
   * to show another task must name each one, so that nothing of the last one counts for the next.
   */
  owner?: string | number;
  /** The glyph drawn when no address loads. */
  kind?: TaskCoverKind;
  /** The addresses are still being worked out: keep the plain tile instead of the glyph. */
  pending?: boolean;
  className?: string;
}

/**
 * The cover box of a task. Its size is fixed by CSS (`--kd-task-cover-size`, 3rem), so a picture
 * that arrives late moves nothing. Until one has loaded the box is a plain tinted tile; when none
 * can be shown it carries the glyph of its kind.
 */
export const TaskCover = memo(function TaskCover({ urls, owner = "", kind = "song", pending = false, className = "" }: TaskCoverProps) {
  const host = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(host);
  const load = useCoverLoad(owner, near && !pending ? urls : NO_URLS);
  const face = pending || !near ? "loading" : load.face;
  const Glyph = GLYPHS[kind];
  return (
    <span ref={host} className={`kd-task-cover ${className}`.trim()} data-face={face} data-kind={kind} aria-hidden="true">
      {face === "missing" && <Glyph className="kd-task-cover-glyph" strokeWidth={1.6} />}
      {load.src && (
        <img
          key={owner}
          ref={load.imageRef}
          src={load.src}
          alt=""
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={load.onLoad}
          onError={load.onError}
        />
      )}
    </span>
  );
}, (before, after) => before.owner === after.owner && before.kind === after.kind && before.pending === after.pending
  && before.className === after.className
  && (before.urls === after.urls || before.urls.join("\n") === after.urls.join("\n")));

export interface TaskCoverStackProps {
  /** One list of addresses per picture, front first: `taskCoverStack(...).covers`. */
  covers: readonly (readonly string[])[];
  /** How many more tasks the batch has than pictures shown: `taskCoverStack(...).more`. */
  more?: number;
  /** Names the batch, as `owner` names a single cover. */
  owner?: string | number;
  kind?: TaskCoverKind;
  pending?: boolean;
  /**
   * `fan` keeps the pictures inside one cover box, stepped along its diagonal — a row of a list,
   * where every cover has the same place. `row` lays full-size boxes side by side, overlapped.
   */
  layout?: "fan" | "row";
  className?: string;
}

/**
 * Up to three overlapped covers for a batch of tasks. With one picture or none it is exactly a
 * `TaskCover`, so a list can use it for every row of a kind that may be a batch.
 */
export const TaskCoverStack = memo(function TaskCoverStack({ covers, more = 0, owner = "", kind = "song", pending = false, layout = "fan", className = "" }: TaskCoverStackProps) {
  const shown = covers.slice(0, 3);
  const extra = more + covers.length - shown.length;
  if (shown.length <= 1 && extra <= 0) {
    return <TaskCover urls={shown[0] ?? NO_URLS} owner={owner} kind={kind} pending={pending} className={className} />;
  }
  return (
    <span className={`kd-task-cover-stack ${className}`.trim()} data-layout={layout} data-count={shown.length} aria-hidden="true">
      {shown.map((urls, index) => (
        <TaskCover key={index} urls={urls} owner={`${owner}:${index}`} kind={kind} pending={pending} />
      ))}
      {extra > 0 && <span className="kd-task-cover-more">+{extra > 99 ? "99" : extra}</span>}
    </span>
  );
}, (before, after) => before.owner === after.owner && before.kind === after.kind && before.pending === after.pending
  && before.more === after.more && before.layout === after.layout && before.className === after.className
  && (before.covers === after.covers
    || before.covers.map((urls) => urls.join("\n")).join("\n\n") === after.covers.map((urls) => urls.join("\n")).join("\n\n")));
