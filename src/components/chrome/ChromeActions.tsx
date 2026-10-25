import { mediaProductionAvailable } from "../../lib/platformFeatures";
import { useEffect } from "react";
import { Moon, Settings, Sun, Upload, Palette, Download } from "lucide-react";
import { cycleThemePack, OFFICIAL_THEMES, useThemePack } from "../../lib/themePack";
import { useAppStore } from "../../stores/appStore";
import { useUpdateStore } from "../../stores/updateStore";
import { ChromeMiniPlayerKey } from "../player/MiniPlayer";
import { HintBulbIcon } from "../download/HintBulbIcon";
import { ChromeEditorKey } from "../editor/EditorKey";
import { greetTipsOnNewBuild, useTipsNudge } from "../../lib/tipsNudge";

export interface ChromeActionsProps {
  settingsOpen: boolean;
  onSettings(): void;
  /** 打开设置并定位到软件更新区；默认走 updateStore。 */
  onOpenUpdate?(): void;
  /** 下载与导出任务列表：固定在右栏，由这里开关。 */
  tasksOpen: boolean;
  onTasks(): void;
  /** 使用提示（小灯泡）：按功能分页的教学，由小鼠标演示。没有这个入口的窗口不传。 */
  tipsOpen?: boolean;
  onTips?(): void;
}

/** 顶栏的键：使用提示、下载与导出、剪辑、更新、设置、小窗和主题。 */
export function ChromeActions({
  settingsOpen,
  onSettings,
  onOpenUpdate,
  tasksOpen,
  onTasks,
  tipsOpen = false,
  onTips,
}: ChromeActionsProps) {
  const tipsFresh = useTipsNudge(state => state.fresh);
  useEffect(() => { if (onTips) greetTipsOnNewBuild(); }, [onTips]);
  const updateReady = useUpdateStore((s) => Boolean(s.info?.newer));
  const latest = useUpdateStore((s) => s.info?.latest ?? "");
  const openUpdateSection = useUpdateStore((s) => s.openUpdateSection);
  const openUpdate = onOpenUpdate ?? openUpdateSection;
  return (
    <div className="kd-chrome-actions" role="group" aria-label="顶栏工具">
      {onTips && <button type="button" className="kd-chrome-btn" title="使用提示" aria-label="使用提示"
        aria-pressed={tipsOpen} data-open={tipsOpen || undefined} data-fresh={tipsFresh || undefined} onClick={onTips}>
        <HintBulbIcon size={17} aria-hidden="true" />
      </button>}
      <button type="button" className="kd-chrome-btn" title={mediaProductionAvailable() ? "下载与导出" : "下载"} aria-label={mediaProductionAvailable() ? "下载与导出" : "下载"}
        data-kd-search-queue-drop="entry" aria-pressed={tasksOpen} data-open={tasksOpen || undefined} onClick={onTasks}><Download size={16} /></button>
      {/* Only the main window has the editor, as only it has the tips. */}
      {onTips && <ChromeEditorKey />}
      {updateReady ? (
        <button
          type="button"
          className="kd-chrome-btn"
          data-update="true"
          aria-label={latest ? `有新版本 v${latest} 待下载` : "有更新待下载"}
          title={latest ? `待下载：v${latest}` : "待下载更新"}
          data-open={settingsOpen || undefined}
          onClick={openUpdate}
        >
          {/* 经典「上箭头 + 底框」升级形；灰色，有更新只靠角点提示。 */}
          <Upload size={16} />
          <span className="kd-chrome-dot" aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        className="kd-chrome-btn"
        aria-label="设置"
        aria-pressed={settingsOpen}
        data-open={settingsOpen || undefined}
        title="设置"
        onClick={onSettings}
      >
        <Settings size={16} />
      </button>

      <ChromeMiniPlayerKey />
      <ChromeThemeButton />
    </div>
  );
}

/** The main window and editor windows share the same theme control. */
export function ChromeThemeButton() {
  const theme = useAppStore((state) => state.settings?.theme ?? "system");
  const resolvedTheme = theme === "system"
    ? document.documentElement.dataset.theme ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  const activeTheme = useThemePack(state => state.active);
  const installingTheme = useThemePack(state => state.installing);
  const isDark = (activeTheme?.modes.length === 1 ? activeTheme.modes[0] : resolvedTheme) !== "light";
  const themeName = activeTheme
    ? OFFICIAL_THEMES.find(item => item.id === activeTheme.id)?.name ?? activeTheme.name
    : isDark ? "Dark" : "Shiro";
  return <button type="button" className="kd-chrome-btn"
    aria-label={`切换主题，当前 ${themeName}`} title={`切换主题 · ${themeName}`}
    disabled={installingTheme !== null} onClick={() => void cycleThemePack()}>
    {activeTheme ? <Palette size={16} /> : isDark ? <Moon size={16} /> : <Sun size={16} />}
  </button>;
}
