import { create } from "zustand";
import { readLocalStorage, writeLocalStorageSoon } from "./storageWrite";

/**
 * How long a notice stays when it does not say (设置 → 通用 → 提示停留, docs/task-bubbles.md).
 * One length for all of them; the bubbles with a time of their own keep it (the playing song's
 * peek, a short note), downloads stay twice as long, errors too.
 */
export const TASK_STAY_CHOICES = [5, 10, 30, 60] as const;
export type TaskStaySeconds = (typeof TASK_STAY_CHOICES)[number];
const STORAGE_KEY = "kd-task-stay";
const DEFAULT: TaskStaySeconds = 30;

function read(): TaskStaySeconds {
  const value = Number(readLocalStorage(STORAGE_KEY));
  return (TASK_STAY_CHOICES as readonly number[]).includes(value) ? value as TaskStaySeconds : DEFAULT;
}

export const useTaskStayPref = create<{ seconds: TaskStaySeconds; setSeconds(seconds: TaskStaySeconds): void }>(set => ({
  seconds: read(),
  setSeconds: seconds => {
    set({ seconds });
    writeLocalStorageSoon(STORAGE_KEY, String(seconds));
  },
}));
