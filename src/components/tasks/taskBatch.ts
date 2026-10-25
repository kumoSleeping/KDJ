import type { TaskBubbleSpec, TaskCover } from "./taskBubbleSchema";
import { showTask, taskIsUp, updateTask } from "./taskBubbleStore";

/** One thing a batch bubble stands for, as its store shows it now. */
export interface BatchMember {
  key: string;
  title: string;
  covers: readonly TaskCover[];
  /** `gone`: cancelled, paused or removed — it leaves the batch without a word. */
  state: "active" | "done" | "failed" | "gone";
  progress: number;
  error: string;
  /** It started now, rather than being found already under way. */
  fresh: boolean;
  /** What a finished batch of this one alone says instead of the usual word, and its keys:
   *  where an export went and a key that shows it there. */
  outcome?: { detail: string; actions?: TaskBubbleSpec["actions"] };
}

interface BatchWords {
  id: string;
  kind: string;
  /** The counter of a title that stands for several: "X 等 3 首". */
  unit: string;
  started: string;
  running: string;
  finished: string;
  failed: string;
  icon?: TaskBubbleSpec["icon"];
  /** Where its bubble comes up; the bottom when left out. */
  placement?: TaskBubbleSpec["placement"];
  /** How long its bubble stays, when not the usual length (read when it comes up). */
  stay?(): number;
  /** The list this batch belongs to is open and showing it: a start need not be announced. */
  listed(): boolean;
  open(finished: boolean): void;
}

/** A start waits this long: a burst of starts becomes one bubble, and an entry that opens the
 *  list with the same action has done so by then. */
export const TASK_BATCH_SETTLE_MS = 700;
const PROGRESS_EVERY_MS = 250;

/**
 * One bubble for a run of like tasks. Starts within a moment of each other are announced
 * together and later ones join the same bubble; the bubble follows their progress while it is
 * up, says so when one fails, and comes back with the outcome when none is left running.
 */
export function createBatchReporter(words: BatchWords) {
  const batch = new Map<string, BatchMember>();
  let announce: number | null = null;
  let progressAt = 0;

  const spec = (phase: "started" | "running" | "failed" | "finished", subject?: BatchMember): TaskBubbleSpec => {
    const members = [...batch.values()];
    const failed = members.filter(member => member.state === "failed");
    const done = members.filter(member => member.state === "done");
    const closing = phase === "finished";
    const about = subject ? [subject] : closing && failed.length ? failed : members;
    const first = about[0];
    const title = !first ? "" : about.length === 1 ? first.title : `${first.title} 等 ${about.length} ${words.unit}`;
    const error = phase === "failed" || (closing && failed.length > 0);
    const covers = about.flatMap(member => member.covers);
    const outcome = closing && !error && about.length === 1 ? first?.outcome : undefined;
    const detail = error
      ? [words.failed, (subject ?? failed[0])?.error, closing && done.length ? `${done.length} ${words.unit}已完成` : ""].filter(Boolean).join(" · ")
      : closing ? outcome?.detail ?? words.finished
      : phase === "started" && done.length === 0 ? words.started
      : `${words.running} ${done.length + failed.length}/${members.length}`;
    return {
      id: words.id,
      kind: words.kind,
      title,
      detail,
      covers,
      count: about.length > covers.length ? about.length : undefined,
      icon: words.icon,
      actions: outcome?.actions,
      placement: words.placement,
      stay: words.stay?.(),
      tone: error ? "error" : closing ? "success" : "info",
      progress: closing || members.length === 0 ? null
        : members.reduce((sum, member) => sum + (member.state === "active" ? member.progress : 1), 0) / members.length,
      onOpen: () => words.open(closing && !error),
    };
  };

  return {
    /** Everything the store holds now. A member that is no longer listed has been removed. */
    report(listed: readonly BatchMember[]) {
      const present = new Set<string>();
      let started = false, failed: BatchMember | null = null;
      for (const member of listed) {
        present.add(member.key);
        const before = batch.get(member.key);
        if (member.state === "gone") { batch.delete(member.key); continue; }
        if (member.state === "active") {
          if (member.fresh && before?.state !== "active") started = true;
          batch.set(member.key, member);
        } else if (before?.state === "active") {
          batch.set(member.key, member);
          if (member.state === "failed") failed = member;
        }
      }
      for (const [key, member] of batch) if (!present.has(key) && member.state === "active") batch.delete(key);
      if (batch.size === 0) {
        if (announce !== null) window.clearTimeout(announce);
        announce = null;
        return;
      }
      if (![...batch.values()].some(member => member.state === "active")) {
        if (announce !== null) window.clearTimeout(announce);
        announce = null;
        showTask(spec("finished"));
        batch.clear();
        return;
      }
      if (failed) showTask(spec("failed", failed));
      if (started) {
        if (announce !== null) window.clearTimeout(announce);
        announce = window.setTimeout(() => {
          announce = null;
          if (batch.size > 0 && !words.listed()) showTask(spec("started"));
        }, TASK_BATCH_SETTLE_MS);
      } else if (!failed && taskIsUp(words.id) && performance.now() - progressAt >= PROGRESS_EVERY_MS) {
        progressAt = performance.now();
        const { progress, detail, covers, count } = spec("running");
        // The line of a failure stays as it is; only the bar moves under it.
        updateTask(words.id, [...batch.values()].some(member => member.state === "failed") ? { progress } : { progress, detail, covers, count });
      }
    },
    stop() {
      if (announce !== null) window.clearTimeout(announce);
      announce = null;
      batch.clear();
    },
  };
}
