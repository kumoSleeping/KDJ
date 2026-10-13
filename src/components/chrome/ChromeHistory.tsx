import { ChevronLeft, ChevronRight } from "lucide-react";
import { useNavStore } from "../../stores/navStore";

/**
 * The window's back/forward keys, at the top left of the bar (on a Mac, after the traffic lights).
 * They walk the place history (stores/navStore.ts): the previous search or online list, the
 * local list, a folder, a side panel that was open.
 */
export function ChromeHistory() {
  const canBack = useNavStore((s) => s.canBack);
  const back = useNavStore((s) => s.back);
  const canForward = useNavStore((s) => s.canForward);
  const forward = useNavStore((s) => s.forward);
  return (
    <div className="kd-chrome-history" role="group" aria-label="浏览历史">
      <button
        type="button"
        className="kd-chrome-btn"
        data-action="history-back"
        aria-label="返回"
        title="返回上一个界面"
        disabled={!canBack}
        onClick={back}
      >
        <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="kd-chrome-btn"
        data-action="history-forward"
        aria-label="前进"
        title="前进到下一个界面"
        disabled={!canForward}
        onClick={forward}
      >
        <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
