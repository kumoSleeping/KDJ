import { mediaProductionAvailable } from "../../lib/platformFeatures";
import { Clapperboard } from "lucide-react";
import { useLaneEditor } from "../../stores/laneEditorStore";

/** The top bar's key to the editor (剪辑): opens it as it was left, with its projects; again, puts it away. */
export function ChromeEditorKey() {
  const open = useLaneEditor(state => state.open);
  if (!mediaProductionAvailable()) return null;
  return <button type="button" className="kd-chrome-btn" title="剪辑" aria-label="剪辑"
    aria-pressed={open} data-open={open || undefined}
    onClick={() => { const editor = useLaneEditor.getState(); if (open) editor.close(); else editor.show(); }}>
    <Clapperboard size={16} />
  </button>;
}
