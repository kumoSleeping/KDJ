import type { PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Moon, Sun, Undo2 } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useNavStore } from "../../stores/navStore";

function startWindowDrag(event: ReactPointerEvent<HTMLElement>): void {
  // 只认主键；点到按钮/输入时不拖
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
  window.kdj?.windowControl("drag");
}

export interface AppChromeProps {
  /** 宽屏的主题键放在固定左栏；窄屏没有左栏时仍由主顶栏承载。 */
  showThemeToggle?: boolean;
}

export function ThemeToggle() {
  const theme = useAppStore((state) => state.settings?.theme ?? "dark");
  const saveSettings = useAppStore((state) => state.saveSettings);
  const resolvedTheme =
    theme === "system" ? (document.documentElement.dataset.theme ?? "dark") : theme;
  const isDark = resolvedTheme !== "light";

  return (
    <button
      type="button"
      className="kd-chrome-nav-btn"
      aria-label={isDark ? "切到日间模式" : "切到夜间模式"}
      title={isDark ? "日间模式" : "夜间模式"}
      onClick={() => void saveSettings({ theme: isDark ? "light" : "dark" })}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/**
 * 主栏眉头：固定的浏览历史在左，中间用于拖窗。
 * 右栏开关固定在分析工作条右端，避免开、关时跳到上下两处。
 * 宽屏主题键放在最左边的固定文件夹栏；窄屏没有文件夹栏时才放回这里。
 */
export function AppChrome({
  showThemeToggle = false,
}: AppChromeProps) {
  const canBack = useNavStore((s) => s.canBack);
  const canForward = useNavStore((s) => s.canForward);
  const canUndo = useNavStore((s) => s.canUndo);
  const back = useNavStore((s) => s.back);
  const forward = useNavStore((s) => s.forward);
  const undo = useNavStore((s) => s.undo);

  return (
    <header
      className="kd-app-chrome"
      data-tauri-drag-region
      onPointerDown={startWindowDrag}
    >
      <div className="kd-app-chrome-nav">
        {showThemeToggle ? (
          <>
            <ThemeToggle />
            <span className="kd-app-chrome-separator" aria-hidden="true" />
          </>
        ) : null}
        <div className="kd-app-chrome-history" role="group" aria-label="浏览历史">
        <button
          type="button"
          className="kd-chrome-nav-btn"
          aria-label="后退"
          title="后退到上一个打开的地方"
          disabled={!canBack}
          onClick={back}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className="kd-chrome-nav-btn"
          aria-label="前进"
          title="前进"
          disabled={!canForward}
          onClick={forward}
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          className="kd-chrome-nav-btn"
          aria-label="撤销"
          title="撤销：先恢复刚关掉的面板，否则后退一步"
          disabled={!canUndo}
          onClick={undo}
        >
          <Undo2 size={14} />
        </button>
        </div>
      </div>
      <div
        className="kd-app-chrome-drag"
        data-tauri-drag-region
        aria-hidden="true"
        onPointerDown={startWindowDrag}
      />
    </header>
  );
}
