import { dismissTask, showTask } from "../components/tasks/taskBubbleStore";
import type { TaskTone } from "../components/tasks/taskBubbleSchema";

/**
 * Plain messages from code that has nothing more to say than a sentence: each becomes a task
 * bubble (docs/task-bubbles.md). A report with a cover, progress or an action calls `showTask`
 * itself.
 */
const FAILURE = /失败|无法|失效|错误|出错|异常|不可用|放不了|过期|拒绝|需要/;

/** A sentence that reports a failure is shown, and stays, as an error. */
export function noticeTone(text: string): TaskTone {
  return FAILURE.test(text) ? "error" : "info";
}

const shown = new Set<string>();

/** Show one sentence as a bubble of its own; the same sentence again starts its stay over. */
export function showNotice(text: string, id = `notice:${text}`): void {
  const title = text.trim();
  if (!title) return;
  shown.add(id);
  showTask({ id, kind: "notice", title, tone: noticeTone(title), onDismiss: () => { shown.delete(id); } });
}

export const useToastStore = {
  getState: () => ({
    show: (text: string) => showNotice(text),
    /** Takes away the sentences shown through this store. */
    dismiss: () => { for (const id of [...shown]) dismissTask(id); },
  }),
};
