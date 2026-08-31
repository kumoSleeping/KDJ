import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

/** 顶栏双击最大化时用来同步按钮图标。 */
export const WINDOW_MAXIMIZE_TOGGLE_EVENT = "kd-window-maximize-toggle";

/**
 * Windows / Linux 自绘标题栏按钮。Mac 用系统红绿灯，不渲染这组。
 * 系统 decorations 关掉后，没有这三颗键就关不了窗。
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const onToggle = () => setMaximized((current) => !current);
    window.addEventListener(WINDOW_MAXIMIZE_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(WINDOW_MAXIMIZE_TOGGLE_EVENT, onToggle);
  }, []);

  return (
    <div className="kd-window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="kd-window-btn"
        aria-label="最小化"
        title="最小化"
        onClick={() => window.kdj?.windowControl("minimize")}
      >
        <Minus size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="kd-window-btn"
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        onClick={() => {
          setMaximized((current) => !current);
          window.kdj?.windowControl("maximize");
        }}
      >
        {maximized ? (
          <Copy size={12} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Square size={12} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="kd-window-btn"
        data-close="true"
        aria-label="关闭"
        title="关闭"
        onPointerDown={(event) => {
          // WebView 媒体线程异常时 click 可能排在手势尾部迟迟不来；按下即把退出
          // 请求交给 Rust。键盘激活没有 pointerdown，仍由下面的 click 兜底。
          if (event.button !== 0) return;
          event.preventDefault();
          window.kdj?.windowControl("close");
        }}
        onClick={(event) => {
          if (event.detail === 0) window.kdj?.windowControl("close");
        }}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
