import { useEffect, type RefObject } from "react";
import { useWorkshopStore } from "../stores/workshopStore";
/** Keep ownership after pointer-captured drags or an input blur, without taking
 * text undo or shortcuts from the library and other panels. */
export function useWorkshopUndoShortcuts(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let owned = Boolean(root.current?.contains(document.activeElement));
    const inside = (target: EventTarget | null) => Boolean(root.current && (root.current.contains(target as Node) || (target as Element)?.closest?.(".vj-floating-preview,[data-workshop-toolbar]")));
    const track = (event: Event) => { owned = inside(event.target); };
    const editingText = (event: Event) => (event.target as Element)?.closest?.("input,select,textarea,[contenteditable]:not([contenteditable=false]),.vj-dialog");
    const keydown = (event: KeyboardEvent) => {
      if ((!owned && !inside(event.target)) || event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (editingText(event)) return;
      const key = event.code === "KeyZ" ? "z" : event.code === "KeyY" ? "y" : event.key.toLowerCase();
      if (key !== "z" && !(key === "y" && event.ctrlKey)) return;
      event.preventDefault(); event.stopPropagation();
      if (key === "y" || event.shiftKey) useWorkshopStore.getState().redo();
      else useWorkshopStore.getState().undo();
    };
    // WebKit can route native Edit-menu commands through beforeinput instead
    // of keydown. Canceled keydown emits no beforeinput, avoiding double undo.
    const beforeinput = (event: InputEvent) => {
      if ((!owned && !inside(event.target)) || event.defaultPrevented || !event.cancelable || editingText(event)) return;
      if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
      event.preventDefault(); event.stopPropagation();
      if (event.inputType === "historyUndo") useWorkshopStore.getState().undo();
      else useWorkshopStore.getState().redo();
    };
    document.addEventListener("beforeinput", beforeinput, true);
    document.addEventListener("pointerdown", track, true);
    document.addEventListener("focusin", track, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("beforeinput", beforeinput, true);
      document.removeEventListener("pointerdown", track, true);
      document.removeEventListener("focusin", track, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [root]);
}
