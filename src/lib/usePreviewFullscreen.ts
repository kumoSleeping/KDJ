import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useToastStore } from "../stores/toastStore";

/** Native window fullscreen with a preview overlay; never substitute CSS-only expansion. */
export function usePreviewFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  const state = useRef({ active: false, restore: false, disposed: false });
  const pending = useRef<Promise<boolean> | null>(null);

  const applyFullscreen = useCallback(function apply(next: boolean): Promise<boolean> {
    if (pending.current) return pending.current.then(() => apply(next));
    const current = state.current;
    if (current.disposed) return Promise.resolve(false);
    if (current.active === next) return Promise.resolve(true);
    const operation = (async () => {
      try {
        const window = getCurrentWindow();
        if (next) {
          current.restore = await window.isFullscreen();
          if (current.disposed) return false;
          // Cover the editor before the native transition; uncover only after exit.
          setFullscreen(true);
        }
        await window.setFullscreen(next || current.restore);
        current.active = next;
        if (!current.disposed) setFullscreen(next);
        return true;
      } catch (error) {
        if (!current.disposed) {
          setFullscreen(current.active);
          useToastStore.getState().show(`无法切换全屏：${error instanceof Error ? error.message : String(error)}`);
        }
        return false;
      }
    })();
    pending.current = operation;
    void operation.finally(() => { if (pending.current === operation) pending.current = null; });
    return operation;
  }, []);

  useEffect(() => {
    const current = { active: false, restore: false, disposed: false };
    state.current = current;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!current.active || current.disposed || pending.current) return;
        void getCurrentWindow().isFullscreen().then(nativeFullscreen => {
          if (!nativeFullscreen && current.active && !current.disposed && !pending.current) {
            current.active = false;
            setFullscreen(false);
          }
        }).catch(() => undefined);
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!current.active && !pending.current)) return;
      // Consume before the enclosing sheet can treat Esc as a request to close.
      event.preventDefault();
      event.stopImmediatePropagation();
      void applyFullscreen(false);
    };
    window.addEventListener("resize", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("keydown", escape, true);
    return () => {
      current.disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("keydown", escape, true);
      // Also cover unmount while the native enter request is still in flight.
      void Promise.resolve(pending.current).then(async () => {
        if (current.active) await getCurrentWindow().setFullscreen(current.restore);
      }).catch(error => useToastStore.getState().show(`无法还原全屏：${String(error)}`));
    };
  }, [applyFullscreen]);

  return { fullscreen, applyFullscreen };
}
