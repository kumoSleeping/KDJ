import { useEffect, type RefObject } from "react";
import { useWorkshopStore } from "../stores/workshopStore";
/** Keep ownership after pointer-captured drags or an input blur, without taking
 * text undo or shortcuts from the library and other panels. */
export function useWorkshopUndoShortcuts(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let owned = Boolean(root.current?.contains(document.activeElement));
    const track = (event: Event) => { owned = Boolean(root.current && (root.current.contains(event.target as Node) || (event.target as HTMLElement)?.closest?.(".vj-floating-preview"))); };
    const keydown = (event: KeyboardEvent) => {
      if (!owned || event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if ((event.target as Element)?.closest?.("input,select,textarea,[contenteditable]:not([contenteditable=false]),.vj-dialog")) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && !(key === "y" && event.ctrlKey)) return;
      event.preventDefault(); event.stopPropagation();
      if (key === "y" || event.shiftKey) useWorkshopStore.getState().redo();
      else useWorkshopStore.getState().undo();
    };
    document.addEventListener("pointerdown", track, true);
    document.addEventListener("focusin", track, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", track, true);
      document.removeEventListener("focusin", track, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [root]);
}
