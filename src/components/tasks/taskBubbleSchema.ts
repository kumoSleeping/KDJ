import type { ReactNode } from "react";

/**
 * 任务信息: what one task bubble says. A bubble is described, never drawn by its owner — the
 * host (TaskBubbleHost) draws the surface, the cover stack, the countdown, the hold on hover,
 * the entrance and the exit for every kind. See docs/task-bubbles.md.
 */
export type TaskTone = "info" | "success" | "error";

export type TaskSize = "small" | "regular" | "large";

/** Why a bubble left. `timeout`: its stay ran out. `user`: dismissed on the bubble or by Esc.
 *  `caller`: its owner took it away. `crowded`: newer bubbles pushed it out. */
export type TaskDismissReason = "timeout" | "user" | "caller" | "crowded";

/**
 * One cover of a stack. `urls` are every address that can show it, best first (a sized
 * thumbnail, then the original); `key` says whose cover it is, so the same owner keeps its
 * picture while its addresses change. A plain string is one address that is its own key.
 */
export type TaskCover = string | { key: string | number; urls: readonly string[] };

/** A compact icon action on the bubble. Selected state is `pressed`; `busy` shows it working. */
export interface TaskAction {
  id: string;
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  busy?: boolean;
  /** `bubble` is the bubble's own element, for what opens beside it. */
  onSelect(bubble: HTMLElement): void;
}

export interface TaskBubbleSpec {
  /** One bubble per id. Showing an id that is up changes that bubble instead of adding one. */
  id: string;
  /**
   * What kind of task this is: `playing`, `download`, `export`, `import`, `notice`, … A styling
   * hook (data-kind), and what the bubble is called where a theme pack gives it a caption bar:
   * the host names the kinds it knows (TASK_KIND_NAMES in TaskBubbleHost.tsx: 正在播放, 下载,
   * 导出, 导入) and calls every other kind 提示.
   */
  kind: string;
  title: string;
  /** One quiet line under the title. */
  detail?: string;
  /** Short facts, drawn as one quieter line (BPM, key, length, …). */
  facts?: readonly string[];
  /**
   * Where the task's subject comes from: a small mark the host draws at the head of the facts
   * line (the platform a song is streamed or was downloaded from), with `label` as its name.
   * A brand mark keeps its own colour.
   */
  origin?: { label: string; mark: ReactNode };
  /** Up to three are shown, overlapping; the rest becomes "+N". */
  covers?: readonly TaskCover[];
  /** How many things the covers stand for, when that is more than the covers given. */
  count?: number;
  /** The mark shown when there is no cover. Without it the tone's own mark is used. */
  icon?: ReactNode;
  /** 0..1 while the task reports progress. */
  progress?: number | null;
  tone?: TaskTone;
  actions?: readonly TaskAction[];
  /**
   * How much room the bubble takes. `small`: a one-line note as wide as its text. `regular`
   * (the default): a task with a cover and two lines. `large`: the task the listener reads and
   * acts on most, with a big cover and a title-size name (the playing song).
   */
  size?: TaskSize;
  /**
   * How long the bubble stays, in ms, before it rolls back down. Each kind of task chooses its
   * own: a song 5 s, a short note 3 s. 0 keeps it up until it is
   * dismissed: a pinned or opened bubble. Left out, the tone decides (see TASK_STAY_MS).
   */
  stay?: number;
  /** The bubble itself was clicked (not one of its actions). */
  onOpen?(): void;
  /**
   * Fuller content shown inside the bubble while it is expanded; the host draws the control
   * that expands it. With `replacesSummary` the cover, title and lines above are hidden while
   * the body is open, for a body that restates them.
   */
  body?: ReactNode;
  replacesSummary?: boolean;
  expanded?: boolean;
  onExpand?(expanded: boolean): void;
  /**
   * The task's own live controls, drawn as a row along the bottom of the bubble in both the
   * compact and the expanded form (the playing song's transport and progress, while the player
   * bar is away). The task supplies the controls; the row, its place and its spacing are the
   * host's. A task may give or take them while its bubble is up: the host unfolds the row open
   * and folds it away.
   */
  controls?: ReactNode;
  /**
   * The playing song this bubble is about. While the bubble is up and this changes, it rolls
   * down with the old song and rises with the new one on the song-change clock
   * (src/lib/songSwapMotion.ts), and it counts as a surface of that song.
   */
  song?: string | number;
  /** Esc dismisses it. For a bubble the user called up; never for a transient report. */
  escape?: boolean;
  /**
   * What the dismiss key says, and optionally shows, when rolling this bubble down does more
   * than put it away (the playing song while the player bar is away: 展开播放条). Left out, the
   * key is the host's plain 收起.
   */
  dismiss?: { label: string; icon?: ReactNode };
  /** Called once when the bubble starts to leave, whatever made it leave. */
  onDismiss?(reason: TaskDismissReason): void;
}

/** How long a bubble stays when its spec does not say. An error stays readable for longer. */
export const TASK_STAY_MS: Record<TaskTone, number> = { info: 5_000, success: 5_000, error: 10_000 };
/** More bubbles than this, and the oldest that are not kept up leave. */
export const TASK_VISIBLE_LIMIT = 3;
/** Covers drawn before the rest is counted. */
export const TASK_COVER_LIMIT = 3;

export function taskStay(spec: Pick<TaskBubbleSpec, "stay" | "tone">): number {
  return spec.stay ?? TASK_STAY_MS[spec.tone ?? "info"];
}
