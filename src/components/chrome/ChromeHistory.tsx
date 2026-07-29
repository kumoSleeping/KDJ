import { ChevronLeft, ChevronRight, Undo2 } from "lucide-react";
import { useNavStore } from "../../stores/navStore";

/**
 * 后退 / 前进 / 撤销。放在顶栏左侧「侧栏宽度」区内靠右，
 * 与文件夹栏右缘心里对齐，不和右侧全局动作抢位。
 */
export function ChromeHistory() {
  const canBack = useNavStore((s) => s.canBack);
  const canForward = useNavStore((s) => s.canForward);
  const canUndo = useNavStore((s) => s.canUndo);
  const back = useNavStore((s) => s.back);
  const forward = useNavStore((s) => s.forward);
  const undo = useNavStore((s) => s.undo);

  return (
    <div className="kd-chrome-history" role="group" aria-label="浏览历史">
      <button
        type="button"
        className="kd-chrome-nav-btn"
        aria-label="后退"
        title="后退到上一个打开的地方"
        disabled={!canBack}
        onClick={back}
      >
        <ChevronLeft size={15} />
      </button>
      <button
        type="button"
        className="kd-chrome-nav-btn"
        aria-label="前进"
        title="前进"
        disabled={!canForward}
        onClick={forward}
      >
        <ChevronRight size={15} />
      </button>
      <button
        type="button"
        className="kd-chrome-nav-btn"
        aria-label="撤销"
        title="撤销：先恢复刚关掉的面板，否则后退一步"
        disabled={!canUndo}
        onClick={undo}
      >
        <Undo2 size={13} />
      </button>
    </div>
  );
}
