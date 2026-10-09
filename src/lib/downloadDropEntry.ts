import { SEARCH_QUEUE_ENTRY_SELECTOR } from "./folderDrop";
import { enqueueSearchQueuePayload, finishSearchDrop, isSearchDownloadDrag, readSearchDrop } from "./searchDrag";
import { useToastStore } from "../stores/toastStore";
import { isElement } from "../components/common/dragGhost";

const OVER_ATTR = "data-kd-pointer-search-over";

let installed = false;

/**
 * Lets the 下载 entries (the chrome button, the drawer's launcher) take a dragged search result
 * like the task list does: dropping one there queues it. The entries are found by selector, so
 * whichever component draws them needs no drop handlers of its own. Drags that follow the
 * pointer by hand already find the entries through `searchQueueDropElementAt`; this adds the
 * same for HTML5 drags.
 */
export function installDownloadEntryDrop(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const entryOf = (event: DragEvent) =>
    isElement(event.target) ? event.target.closest<HTMLElement>(SEARCH_QUEUE_ENTRY_SELECTOR) : null;
  let over: HTMLElement | null = null;
  const leave = () => {
    over?.removeAttribute(OVER_ATTR);
    over = null;
  };
  window.addEventListener("dragover", event => {
    const entry = entryOf(event);
    if (entry !== over) leave();
    if (!entry || !isSearchDownloadDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    over = entry;
    entry.setAttribute(OVER_ATTR, "queue");
  }, true);
  window.addEventListener("dragend", leave, true);
  window.addEventListener("drop", event => {
    const entry = entryOf(event);
    leave();
    if (!entry || !event.dataTransfer) return;
    const payload = readSearchDrop(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    finishSearchDrop();
    void enqueueSearchQueuePayload(payload).catch((error: unknown) =>
      useToastStore.getState().show(`加入队列失败：${error instanceof Error ? error.message : String(error)}`));
  }, true);
}
