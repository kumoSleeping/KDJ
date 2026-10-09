import { create } from "zustand";
import { TASK_VISIBLE_LIMIT, taskStay, type TaskBubbleSpec, type TaskDismissReason } from "./taskBubbleSchema";

/** A bubble on screen. */
export interface TaskBubbleEntry {
  spec: TaskBubbleSpec;
  /** A new value restarts the bubble's stay. */
  token: number;
  /** When it first came up; newer bubbles sit nearer the player bar. */
  order: number;
  /** It is rolling down; the host removes it when that is over. */
  leaving: boolean;
}

let tokens = 0;

interface TaskBubbleStore {
  entries: TaskBubbleEntry[];
  show(spec: TaskBubbleSpec): void;
  update(id: string, patch: Partial<Omit<TaskBubbleSpec, "id">>): void;
  dismiss(id: string, reason?: TaskDismissReason): void;
  /** The host's: the exit of a bubble is over. */
  remove(id: string, token: number): void;
}

export const useTaskBubbles = create<TaskBubbleStore>((set, get) => ({
  entries: [],
  show(spec) {
    const before = get().entries;
    const current = before.find(entry => entry.spec.id === spec.id);
    const token = ++tokens;
    // A bubble that is up keeps its place; one that was leaving comes back as a new arrival.
    const entries = current && !current.leaving
      ? before.map(entry => entry === current ? { ...entry, spec, token } : entry)
      : [...before.filter(entry => entry !== current), { spec, token, order: token, leaving: false }];
    set({ entries });
    // Of the bubbles that leave by themselves, the oldest make room, an error after the others.
    // One that is kept up is not counted.
    const timed = entries.filter(entry => !entry.leaving && taskStay(entry.spec) > 0);
    const unread = (entry: TaskBubbleEntry) => entry.spec.tone === "error" ? 1 : 0;
    const crowded = timed.filter(entry => entry.spec.id !== spec.id)
      .sort((a, b) => unread(a) - unread(b) || a.order - b.order)
      .slice(0, Math.max(0, timed.length - TASK_VISIBLE_LIMIT));
    for (const entry of crowded) get().dismiss(entry.spec.id, "crowded");
  },
  update(id, patch) {
    if (!get().entries.some(entry => entry.spec.id === id && !entry.leaving)) return;
    set({ entries: get().entries.map(entry => entry.spec.id === id && !entry.leaving
      ? { ...entry, spec: { ...entry.spec, ...patch } } : entry) });
  },
  dismiss(id, reason = "caller") {
    const entry = get().entries.find(candidate => candidate.spec.id === id && !candidate.leaving);
    if (!entry) return;
    set({ entries: get().entries.map(candidate => candidate === entry ? { ...entry, leaving: true } : candidate) });
    entry.spec.onDismiss?.(reason);
  },
  remove(id, token) {
    set({ entries: get().entries.filter(entry => !(entry.spec.id === id && entry.token === token && entry.leaving)) });
  },
}));

/**
 * Show a task bubble, or change the one with the same id and start its stay over. This one
 * call is all a new kind of task needs.
 */
export function showTask(spec: TaskBubbleSpec): void {
  useTaskBubbles.getState().show(spec);
}

/** Change a bubble that is up without restarting its stay. Nothing happens when it is not up. */
export function updateTask(id: string, patch: Partial<Omit<TaskBubbleSpec, "id">>): void {
  useTaskBubbles.getState().update(id, patch);
}

/** Roll a bubble back down. */
export function dismissTask(id: string, reason: TaskDismissReason = "caller"): void {
  useTaskBubbles.getState().dismiss(id, reason);
}

export function taskIsUp(id: string): boolean {
  return useTaskBubbles.getState().entries.some(entry => entry.spec.id === id && !entry.leaving);
}
