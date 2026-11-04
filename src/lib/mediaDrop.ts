/**
 * Files and folders dropped on the main window from the computer (Finder, Explorer), as the
 * native shell reports them (`kdj:media-drop`, src-tauri/src/folder_drop.rs): the dropped folders
 * are imported into the library. A selection of files is left alone: it must never grow into its
 * parent folder or a scan of every root.
 */
import { useEffect } from "react";
import { getBridge } from "./bridge";
import { importFolders } from "./importFolders";
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

export function useMediaDrop(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let consumed = -1;
    let unlisten: (() => void) | undefined;
    void getBridge().onMediaDrop?.(event => {
      if (!alive) return;
      if (event.phase !== "drop") return;
      if (consumed === event.id) return;
      consumed = event.id;
      if (event.error) useToastStore.getState().show(event.error);
      void importFolders(event.folders ?? []).catch(error => useToastStore.getState().show(`导入失败：${String(error)}`));
    }).then(stop => {
      if (alive) unlisten = stop;
      else stop();
    }).catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [enabled]);
}
