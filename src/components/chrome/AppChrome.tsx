import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

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
}

/**
 * 整窗顶栏：拖窗区 + 历史导航 + 右侧全局动作。
 * 在线搜索在内容区顶上；主题切换只放设置面板。
 */
export function AppChrome({
  history,
  actions,
  historyEnd = false,
}: AppChromeProps) {
  return (
    <header
      className="kd-app-chrome"
      data-history-end={historyEnd ? "true" : undefined}
      data-tauri-drag-region
      onPointerDown={startWindowDrag}
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
      {historyEnd || actions ? (
        <div className="kd-app-chrome-actions">
          {historyEnd ? history : null}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
