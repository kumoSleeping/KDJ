import type { RefCallback } from "react";
import { Download, Radio, Moon, Settings, Sun, Upload, Palette } from "lucide-react";
import { cycleThemePack, OFFICIAL_THEMES, useThemePack } from "../../lib/themePack";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useUpdateStore } from "../../stores/updateStore";

export interface ChromeActionsProps {
  settingsOpen: boolean;
  onSettings(): void;
  compositionOpen: boolean;
  onComposition(mode: "workshop" | "live-vj"): void;
  /** 打开设置并定位到软件更新区；默认走 updateStore。 */
  onOpenUpdate?(): void;
  panelIndexTarget?: RefCallback<HTMLSpanElement>;
}

/** 顶栏提供设置及右侧编辑工作区入口。 */
export function ChromeActions({
  settingsOpen,
  onSettings,
  compositionOpen, onComposition,
  onOpenUpdate,
  panelIndexTarget,
}: ChromeActionsProps) {
  const queueOpen = useAppStore(state => state.showQueue);
  const downloads = useDownloadStore(state => state.list);
  const activeDownloads = downloads.filter(task => ["queued", "running", "processing"].includes(task.state)).length;
  const compositionMode = useAppStore(state => state.compositionMode);
  const updateReady = useUpdateStore((s) => Boolean(s.info?.newer));
  const latest = useUpdateStore((s) => s.info?.latest ?? "");
  const openUpdateSection = useUpdateStore((s) => s.openUpdateSection);
  const openUpdate = onOpenUpdate ?? openUpdateSection;
  const theme = useAppStore((state) => state.settings?.theme ?? "system");
  const resolvedTheme =
    theme === "system"
      ? document.documentElement.dataset.theme ??
        (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : theme;
  const activeTheme = useThemePack(state => state.active);
  const installingTheme = useThemePack(state => state.installing);
  const isDark = (activeTheme?.modes.length === 1 ? activeTheme.modes[0] : resolvedTheme) !== "light";
  const themeName = activeTheme
    ? OFFICIAL_THEMES.find(item => item.id === activeTheme.id)?.name ?? activeTheme.name
    : isDark ? "Dark" : "Shiro";
  return (
    <div className="kd-chrome-actions" role="group" aria-label="顶栏工具">
      {panelIndexTarget && <span ref={panelIndexTarget} style={{ display: "contents" }} />}
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
      <button type="button" className="kd-chrome-btn" title="下载" aria-label="下载"
        aria-pressed={queueOpen} data-open={queueOpen || undefined}
        onClick={() => useAppStore.getState().toggleQueuePanel()}><Download size={16} />
        {activeDownloads > 0 && <span className="kd-chrome-badge">{activeDownloads}</span>}
      </button>
      <button type="button" className="kd-chrome-btn" title="VJ 剪辑" aria-label="VJ 剪辑"
        aria-pressed={compositionOpen && compositionMode === "workshop"} data-open={compositionOpen && compositionMode === "workshop" || undefined}
        onClick={() => onComposition("workshop")}><span style={{ fontSize: 11, fontWeight: 700 }}>VJ</span></button>
      <button type="button" className="kd-chrome-btn" title="自动 VJ" aria-label="自动 VJ"
        aria-pressed={compositionOpen && compositionMode === "live-vj"} data-open={compositionOpen && compositionMode === "live-vj" || undefined}
        disabled={!['darwin', 'win32', 'linux'].includes(window.kdj?.platform ?? '')}
        onClick={() => onComposition("live-vj")}><Radio size={16} /></button>

      <button
        type="button"
        className="kd-chrome-btn"
        aria-label={`切换主题，当前 ${themeName}`}
        title={`切换主题 · ${themeName}`}
        disabled={installingTheme !== null}
        onClick={() => void cycleThemePack()}
      >
        {activeTheme ? <Palette size={16} /> : isDark ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </div>
  );
}
