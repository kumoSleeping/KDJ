import { Clapperboard, Download, Moon, Settings, Sun, Upload } from "lucide-react";
import { formatPercent } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useUpdateStore } from "../../stores/updateStore";
import { useWorkshopStore } from "../../stores/workshopStore";

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
  onComposition?(): void;
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
  const updateReady = useUpdateStore((s) => Boolean(s.info?.newer));
  const compositionCount = useWorkshopStore((s) => s.projects.length);
  const workshopJobs = useWorkshopStore(s => s.jobs);
  const exporting = workshopJobs.filter(j => ["queued", "rendering", "validating", "committing", "importing"].includes(j.phase));
  const runningExports = exporting.filter(j => j.phase !== "queued").length;
  const exportProgress = taskProgressLabel(exporting, runningExports);
  const workshopLabel = exporting.length > 1
    ? `VJ 工坊，${runningExports} 个正在导出，共 ${exporting.length} 个待完成`
    : exportProgress !== null ? `VJ 工坊，导出 ${exportProgress}`
    : compositionCount > 0 ? `VJ 工坊，${compositionCount} 个任务` : "VJ 工坊";
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
  const saveSettings = useAppStore((state) => state.saveSettings);
  const resolvedTheme =
    theme === "system"
      ? document.documentElement.dataset.theme ??
        (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : theme;
  const isDark = resolvedTheme !== "light";
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
          aria-label={workshopLabel} title={workshopLabel}
          aria-pressed={compositionOpen} data-open={compositionOpen || undefined}
          onClick={onComposition ?? (() => useAppStore.getState().toggleCompositionPanel())}>
          <Clapperboard size={16} />
          {exportProgress !== null ? <span className="kd-chrome-export-progress">{exportProgress}</span> : compositionCount > 0 && <span className="kd-chrome-dot" aria-hidden="true" />}
        </button>
      <button
        type="button"
        className="kd-chrome-btn"
        aria-label={isDark ? "切到日间模式" : "切到夜间模式"}
        title={isDark ? "日间模式" : "夜间模式"}
        onClick={() => void saveSettings({ theme: isDark ? "light" : "dark" }).catch(() => undefined)}
      >
        {isDark ? <Sun size={16} /> : <Moon size={16} />}
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
