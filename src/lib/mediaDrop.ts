/**
 * Files and folders dropped on the main window from the computer (Finder, Explorer), as the
 * native shell reports them (`kdj:media-drop`, src-tauri/src/folder_drop.rs). On Agent Mode's
 * row or key they become cards for the AI (aiAttachments.ts); anywhere else the dropped folders
 * are imported into the library. A selection of files dropped anywhere else is left alone: it
 * must never grow into its parent folder or a scan of every root.
 */
import { useEffect } from "react";
import { aiDropElementAt, fromFiles } from "./aiAttachments";
import { getBridge } from "./bridge";
import { importFolders } from "./importFolders";
import { useAiStore } from "../stores/aiStore";
import { useToastStore } from "../stores/toastStore";

/** One step of a drop from the computer, in the window's own coordinates. */
export interface NativeMediaDrop {
  id: number;
  phase: "enter" | "over" | "drop" | "leave";
  x: number;
  y: number;
  /** Media and image files only. */
  paths: string[];
  folders?: string[];
  error?: string | null;
}

/** Agent Mode under the drop lights the way an in-window drag lights it. */
function paint(x?: number, y?: number): void {
  document.querySelectorAll("[data-kd-pointer-ai-over]").forEach(node => node.removeAttribute("data-kd-pointer-ai-over"));
  if (x !== undefined && y !== undefined) aiDropElementAt(x, y)?.setAttribute("data-kd-pointer-ai-over", "");
}

export function useMediaDrop(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let consumed = -1;
    let unlisten: (() => void) | undefined;
    void getBridge().onMediaDrop?.(event => {
      if (!alive) return;
      if (event.phase === "leave") {
        paint();
        return;
      }
      if (event.phase !== "drop") {
        paint(event.x, event.y);
        return;
      }
      if (consumed === event.id) return;
      consumed = event.id;
      paint();
      if (event.error) useToastStore.getState().show(event.error);
      if (aiDropElementAt(event.x, event.y)) {
        useAiStore.getState().attach(fromFiles([...event.paths, ...(event.folders ?? [])]));
        return;
      }
      void importFolders(event.folders ?? []).catch(error => useToastStore.getState().show(`导入失败：${String(error)}`));
    }).then(stop => {
      if (alive) unlisten = stop;
      else stop();
    }).catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
      paint();
    };
  }, [enabled]);
}
