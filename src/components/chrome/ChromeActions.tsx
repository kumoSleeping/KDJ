import { useEffect } from "react";
import { Download, Moon, Settings, Sun, Upload, Radio, Palette } from "lucide-react";
import { formatPercent } from "../../lib/format";
import { cycleThemePack, OFFICIAL_THEMES, useThemePack } from "../../lib/themePack";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useUpdateStore } from "../../stores/updateStore";
import { useWorkshopStore } from "../../stores/workshopStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { visualizerExportActive } from "../../lib/visualizerExportQueue";

/** 多项显示正在执行 / 待完成总数；单项才显示具体进度。 */
function taskProgressLabel(tasks: { progress: number }[], running: number): string | null {
  if (tasks.length === 0) return null;
  if (tasks.length > 1) return `${running}/${tasks.length}`;
  return formatPercent(tasks[0].progress);
}

export interface ChromeActionsProps {
  settingsOpen: boolean;
  onSettings(): void;
  queueOpen: boolean;
  queueCount: number;
  onQueue(): void;
  compositionOpen?: boolean;
  onComposition?(mode: "workshop" | "live-vj"): void;
  /** 打开设置并定位到软件更新区；默认走 updateStore。 */
  onOpenUpdate?(): void;
}

/** 主栏顶部右侧的工作模式、设置和下载入口。 */
export function ChromeActions({
  settingsOpen,
  onSettings,
  queueOpen,
  queueCount,
  onQueue,
  compositionOpen,
  onComposition,
  onOpenUpdate,
}: ChromeActionsProps) {
  const compositionMode = useAppStore(s => s.compositionMode);
  const updateReady = useUpdateStore((s) => Boolean(s.info?.newer));
  const visualizerTasks = useVisualizerExportStore(s => s.tasks);
  useEffect(() => { void useVisualizerExportStore.getState().initialize().catch(() => undefined); }, []);
  const workshopJobs = useWorkshopStore(s => s.jobs);
  const projectCount = useWorkshopStore(s => s.projects.length);
  const compositionCount = projectCount + visualizerTasks.length;
  const exporting = [...workshopJobs.filter(j => ["queued", "rendering", "validating", "committing", "importing"].includes(j.phase)),
    ...visualizerTasks.filter(visualizerExportActive)];
  const runningExports = exporting.filter(j => j.phase !== "queued").length;
  const exportProgress = taskProgressLabel(exporting, runningExports);
  const exportTasksLabel = exporting.length > 1
    ? `视频项目与导出，${runningExports} 个正在导出，共 ${exporting.length} 个待完成`
    : exportProgress !== null ? `视频项目与导出，导出 ${exportProgress}`
    : compositionCount > 0 ? `视频项目与导出，${compositionCount} 个任务` : "视频项目与导出";
  const downloadTasks = useDownloadStore(s => s.list);
  const downloading = downloadTasks.filter(t => ["queued", "running", "processing"].includes(t.state));
  const runningDownloads = downloading.filter(t => t.state !== "queued").length;
  const downloadProgress = taskProgressLabel(downloading, runningDownloads);
  const downloadLabel = downloading.length > 1
    ? `下载队列，${runningDownloads} 个正在下载，共 ${downloading.length} 个待完成`
    : downloadProgress !== null ? `下载队列，${downloadProgress}` : "下载队列";
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
      <button type="button" className="kd-chrome-btn" data-composition-hint={compositionCount > 0 ? "true" : undefined}
        aria-label="视频项目与导出" title={exportTasksLabel} aria-pressed={compositionOpen && compositionMode === "workshop"}
        data-open={compositionOpen && compositionMode === "workshop" || undefined}
        onClick={() => onComposition ? onComposition("workshop") : useAppStore.getState().openCompositionPanel()}>
        <span style={{fontSize: 11, fontWeight: 700}}>VJ</span>
        {exportProgress !== null ? <span className="kd-chrome-export-progress">{exportProgress}</span> : compositionCount > 0 && <span className="kd-chrome-dot" aria-hidden="true" />}
      </button>
      <button type="button" className="kd-chrome-btn" aria-label="自动 VJ" title="自动 VJ"
        disabled={!['darwin', 'win32', 'linux'].includes(window.kdj?.platform ?? '')}
        aria-pressed={compositionOpen && compositionMode === "live-vj"}
        data-open={compositionOpen && compositionMode === "live-vj" || undefined}
        onClick={() => onComposition ? onComposition("live-vj") : useAppStore.getState().openLiveVjPanel()}><Radio size={16} /></button>
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
      <button
        type="button"
        className="kd-chrome-btn"
        data-queue-hint={queueCount > 0 ? "true" : undefined}
        aria-label={downloadLabel}
        aria-pressed={queueOpen}
        data-open={queueOpen || undefined}
        title={downloadLabel}
        onClick={onQueue}
      >
        <Download size={16} />
        {downloadProgress !== null ? <span className="kd-chrome-export-progress">{downloadProgress}</span> : null}
      </button>
    </div>
  );
}
