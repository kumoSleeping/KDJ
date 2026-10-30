import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { WINDOW_MAXIMIZE_TOGGLE_EVENT, WindowControls } from "./WindowControls";

function startWindowDrag(event: ReactPointerEvent<HTMLElement>): void {
  // 只认主键；点到按钮/输入时不拖
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
  window.kdj?.windowControl("drag");
}

export interface AppChromeProps {
  /** 浏览历史：排在顶栏最左（Mac 在红绿灯右边）。 */
  history?: ReactNode;
  actions?: ReactNode;
  /**
   * 非 Mac 桌面：关掉系统标题栏后，在右侧自绘最小化 / 最大化 / 关闭。
   * Mac 仍用 Overlay + 红绿灯，不传。
   */
  showWindowControls?: boolean;
  /** The drawer's head hangs from this bar's lower edge (wide window): no edge is drawn there. */
  drawerLip?: boolean;
}

/**
 * 整窗顶栏：左起历史导航、拖窗区、右侧全局动作。
 * 在线搜索在内容区顶上；设置与主题切换放在顶部右侧动作区。
 */
export function AppChrome({
  history,
  actions,
  showWindowControls = false,
  drawerLip = false,
}: AppChromeProps) {
  return (
    <header
      className="kd-app-chrome"
      data-window-controls={showWindowControls ? "true" : undefined}
      data-drawer-lip={drawerLip ? "true" : undefined}
      onPointerDown={startWindowDrag}
      onDoubleClick={(event) => {
        // Windows 习惯：双击标题栏切换最大化。点在按钮上不算。
        if (!showWindowControls) return;
        if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
        window.dispatchEvent(new Event(WINDOW_MAXIMIZE_TOGGLE_EVENT));
        window.kdj?.windowControl("maximize");
      }}
    >
      {history ? (
        <div className="kd-app-chrome-tree">
          {history}
        </div>
      ) : null}
      <div
        className="kd-app-chrome-drag"
        aria-hidden="true"
      />
      {actions || showWindowControls ? (
        <div className="kd-app-chrome-actions">
          {actions}
          {showWindowControls ? <WindowControls /> : null}
        </div>
      ) : null}
    </header>
  );
}
