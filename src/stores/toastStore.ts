import { dismissTask, showTask } from "../components/tasks/taskBubbleStore";
import type { TaskPlacement, TaskTone } from "../components/tasks/taskBubbleSchema";

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

/**
 * Show one sentence as a bubble of its own; the same sentence again starts its stay over.
 * `placement` is `top` for the answer to something pressed or dropped in the window's top row.
 */
export function showNotice(text: string, id = `notice:${text}`, placement?: TaskPlacement): void {
  const title = text.trim();
  if (!title) return;
  shown.add(id);
  showTask({ id, kind: "notice", title, tone: noticeTone(title), placement, onDismiss: () => { shown.delete(id); } });
}

export const useToastStore = {
  getState: () => ({
    show: (text: string, placement?: TaskPlacement) => showNotice(text, undefined, placement),
    /** Takes away the sentences shown through this store. */
    dismiss: () => { for (const id of [...shown]) dismissTask(id); },
  }),
};
