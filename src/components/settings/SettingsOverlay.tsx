import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { usePanelViewport } from "../../lib/panelViewport";
import { SettingsPanel } from "./SettingsPanel";
import "./Preferences.css";

/** Main-window preferences cover the stage, leaving the chrome and player visible. */
export function SettingsOverlay() {
  const close = useAppStore(state => state.toggleSettingsPanel);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    usePanelViewport.getState().setExpandedPanel(null);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A modal <dialog> (e.g. the diagnostics report) owns its own Esc/cancel guard.
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [close]);
  return <section className="kd-preferences-overlay" role="dialog" aria-label="设置">
    <header className="kd-preferences-overlay-head">
      <span>设置</span>
      <button ref={closeRef} type="button" aria-label="关闭设置" title="关闭设置 · Esc" onClick={close}>
        <X size={16} />
      </button>
    </header>
    <SettingsPanel preferences />
  </section>;
}
