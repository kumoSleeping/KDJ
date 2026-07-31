import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { WINDOW_MAXIMIZE_TOGGLE_EVENT, WindowControls } from "./WindowControls";

function startWindowDrag(event: ReactPointerEvent<HTMLElement>): void {
  // 只认主键；点到按钮/输入时不拖
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
  window.kdj?.windowControl("drag");
}

export interface AppChromeProps {
  /** 浏览历史：默认塞在左侧栏宽内；竖屏改 `historyEnd` 并入右侧。 */
  history?: ReactNode;
  actions?: ReactNode;
  /** 历史键改到右侧与设置/下载同排；左侧空给红绿灯。 */
  historyEnd?: boolean;
  /**
   * 非 Mac 桌面：关掉系统标题栏后，在右侧自绘最小化 / 最大化 / 关闭。
   * Mac 仍用 Overlay + 红绿灯，不传。
   */
  showWindowControls?: boolean;
}

/**
 * 整窗顶栏：拖窗区 + 历史导航 + 右侧全局动作。
 * 在线搜索在内容区顶上；主题切换只放设置面板。
 */
export function AppChrome({
  history,
  actions,
  historyEnd = false,
  showWindowControls = false,
}: AppChromeProps) {
  return (
    <header
      className="kd-app-chrome"
      data-history-end={historyEnd ? "true" : undefined}
      data-window-controls={showWindowControls ? "true" : undefined}
      data-tauri-drag-region
      onPointerDown={startWindowDrag}
      onDoubleClick={(event) => {
        // Windows 习惯：双击标题栏切换最大化。点在按钮上不算。
        if (!showWindowControls) return;
        if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
        window.dispatchEvent(new Event(WINDOW_MAXIMIZE_TOGGLE_EVENT));
        window.kdj?.windowControl("maximize");
      }}
    >
      {history && !historyEnd ? (
        <div className="kd-app-chrome-tree">
          {history}
        </div>
      ) : null}
      <div
        className="kd-app-chrome-drag"
        data-tauri-drag-region
        aria-hidden="true"
        onPointerDown={startWindowDrag}
      />
      {historyEnd || actions || showWindowControls ? (
        <div className="kd-app-chrome-actions">
          {historyEnd ? history : null}
          {actions}
          {showWindowControls ? <WindowControls /> : null}
        </div>
      ) : null}
    </header>
  );
}
