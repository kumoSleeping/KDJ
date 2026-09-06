import { useEffect, useState } from "react";

export const FOLDER_DND_TYPE = "application/x-kdj-folder";
const CHANGE_EVENT = "kd:folder-view-drag";
const DROP_SELECTOR = "[data-kd-temporary-folder-drop]";
let draggedFolder: string | null = null;
let prepareFolder: (() => void) | undefined;

export function beginTemporaryFolderDrag(path: string, prepare?: () => void): void {
  draggedFolder = path;
  prepareFolder = prepare;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function endTemporaryFolderDrag(): void {
  draggedFolder = null;
  prepareFolder = undefined;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Uses the same native drag as sidebar folder reordering; never moves a folder on disk. */
export function useTemporaryFolderDrop(open: (folder: string) => void, enabled: boolean) {
  const [offered, setOffered] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    let lastHit = false;
    const hitAt = (event: MouseEvent) => Boolean(document.elementFromPoint(event.clientX, event.clientY)?.closest(DROP_SELECTOR));
    const changed = () => {
      setOffered(enabled && draggedFolder !== null);
      if (!draggedFolder) { lastHit = false; setHovered(false); }
    };
    const over = (event: DragEvent) => {
      if (!enabled || !draggedFolder) return;
      lastHit = hitAt(event);
      setHovered(lastHit);
      if (!lastHit) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const accept = () => {
      const path = draggedFolder;
      const prepare = prepareFolder;
      endTemporaryFolderDrag();
      if (path) { prepare?.(); open(path); }
    };
    const drop = (event: DragEvent) => {
      if (!enabled || !draggedFolder || !hitAt(event)) return;
      event.preventDefault();
      event.stopPropagation();
      accept();
    };
    const pointerMove = (event: PointerEvent) => {
      if (!enabled || !draggedFolder) return;
      lastHit = hitAt(event);
      setHovered(lastHit);
    };
    const pointerUp = (event: PointerEvent) => {
      if (!draggedFolder) return;
      if (enabled && hitAt(event)) accept();
      else endTemporaryFolderDrag();
    };
    const end = (event: DragEvent) => {
      // WKWebView can swallow drop, and sometimes reports 0,0 at dragend.
      const hit = event.clientX === 0 && event.clientY === 0 ? lastHit : hitAt(event);
      if (enabled && draggedFolder && hit) accept();
      else endTemporaryFolderDrag();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") endTemporaryFolderDrag();
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget !== null) return;
      lastHit = false;
      setHovered(false);
    };
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener(CHANGE_EVENT, changed);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", end, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener(CHANGE_EVENT, changed);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [open, enabled]);
  return { offered, hovered };
}
