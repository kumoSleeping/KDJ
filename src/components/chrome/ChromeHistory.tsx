import { ChevronLeft } from "lucide-react";
import { useNavStore } from "../../stores/navStore";

/**
 * The window's back key, at the top left of the bar (on a Mac, right after the traffic lights).
 * It walks the place history (stores/navStore.ts): the previous search or online list, the
 * local list, a folder, a side panel that was open.
 */
export function ChromeHistory() {
  const canBack = useNavStore((s) => s.canBack);
  const back = useNavStore((s) => s.back);
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
    </div>
  );
}
