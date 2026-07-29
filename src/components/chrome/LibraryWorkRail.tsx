import { BarChart3, Download, Music2, Pause, Play } from "lucide-react";
import type { ReactNode } from "react";
import { forgetQueuedAnalysis } from "../../lib/autoAnalyze";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { AnalysisGlyph } from "./ActivityRail";
import { WorkRail } from "./WorkRail";

function ScanGlyph() {
  return (
    <svg className="kd-activity-glyph kd-activity-glyph-scan" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="1.6" />
      <rect x="2" y="7.2" width="9" height="1.6" />
      <rect x="2" y="11.4" width="11" height="1.6" />
    </svg>
  );
}

/**
 * 主内容区的曲库工作条：空闲看数量，忙时显示导入/分析/下载进度。
 * 曲目多选放在本地列表自己的搜索栏位置，不占用这根全局任务条。
 *
 * `showDownloads`：搜索半栏没开时，下载进度暂挂这里，避免任务悬空。
 */
export function LibraryWorkRail({
  showDownloads = false,
  actions,
}: {
  showDownloads?: boolean;
  /** 详情、接播、账号和下载队列：放在分析工作条右端。 */
  actions?: ReactNode;
}) {
  const scan = useLibraryStore((state) => state.scan);
  const analyze = useLibraryStore((state) => state.analyze);
  const autoAnalyzeSuspended = useLibraryStore((state) => state.autoAnalyzeSuspended);
  const stats = useLibraryStore((state) => state.stats);
  const total = useLibraryStore((state) => state.total);
  const queueView = useLibraryStore((state) => state.queueView);
  const activeDownloads = useDownloadStore((state) => state.activeCount);
  const downloadList = useDownloadStore((state) => state.list);
  const running = downloadList.find((task) => task.state === "running");
  const autoAnalyze = useAppStore((state) => state.settings?.auto_analyze ?? true);
  const savingSettings = useAppStore((state) => state.savingSettings);
  const saveSettings = useAppStore((state) => state.saveSettings);

  const scanning = scan !== null && scan.phase !== "done";
  const downloading = showDownloads && activeDownloads > 0;
  const autoPaused = autoAnalyzeSuspended || !autoAnalyze;

  const toggleAutoAnalyze = () => {
    if (autoPaused) {
      // 取消过的 id 不能一直留在本会话去重集合里，否则恢复后它们不会再入队。
      forgetQueuedAnalysis();
      useLibraryStore.getState().setAutoAnalyzeSuspended(false);
      void saveSettings({ auto_analyze: true });
      return;
    }

    // 取消是协作式的：正在解码的一两首会安全收尾，之后不再接下一首。
    // 配置先落盘；后端扫描若恰好尚未结束，也会在 jobs.rs 再读这个开关。
    void Promise.all([
      saveSettings({ auto_analyze: false }),
      useLibraryStore.getState().cancelAnalyze(),
    ])
      // 保存设置自行回滚；取消请求失败也不能让这个点击留下未处理的 Promise。
      .catch(() => undefined)
      .finally(forgetQueuedAnalysis);
  };

  const glyphs: ReactNode[] = [];
  const texts: ReactNode[] = [];

  if (scanning && scan) {
    glyphs.push(<ScanGlyph key="scan" />);
    texts.push(
      <span key="scan" className="kd-activity-text" title={scan.current}>
        正在导入 {scan.done}/{scan.total}
        {scan.current ? ` · ${scan.current}` : ""}
      </span>,
    );
  }
  if (analyze !== null) {
    glyphs.push(<AnalysisGlyph key="analyze" />);
    texts.push(
      <span key="analyze" className="kd-activity-text" title={analyze.current}>
        正在分析 {analyze.done}/{analyze.total} 首
        {analyze.current ? ` · ${analyze.current}` : ""}
      </span>,
    );
  }
  if (downloading) {
    glyphs.push(
      <span key="dl" className="kd-activity-glyph kd-activity-glyph-dl" aria-hidden="true">
        <Download size={13} strokeWidth={2.25} />
      </span>,
    );
    texts.push(
      <span key="dl" className="kd-activity-text">
        {running
          ? `下载中 · ${running.title || running.id}`
          : `队列进行中 ${activeDownloads} 项`}
      </span>,
    );
  }

  if (!scanning && analyze === null && !downloading) {
    const trackTotal = stats?.total ?? total;
    const analyzed = stats?.analyzed ?? 0;
    const pending = Math.max(0, trackTotal - analyzed);
    glyphs.push(
      <span key="n" className="kd-activity-glyph" aria-hidden="true">
        <Music2 size={13} strokeWidth={2.25} />
      </span>,
    );
    texts.push(
      <span key="n" className="kd-activity-text">
        {queueView ? "临时列表" : "曲库"} {trackTotal} 首
      </span>,
    );
    glyphs.push(
      <span key="a" className="kd-activity-glyph" aria-hidden="true">
        <BarChart3 size={13} strokeWidth={2.25} />
      </span>,
    );
    texts.push(
      <span key="a" className="kd-activity-text">
        {pending === 0 ? "已全部分析" : `已分析 ${analyzed} · 未分析 ${pending}`}
      </span>,
    );
  }

  texts.push(
    <button
      key="auto-analyze"
      type="button"
      className="kd-activity-control"
      aria-pressed={!autoPaused}
      disabled={savingSettings}
      title={
        autoPaused
          ? "恢复后会分析新导入、正在播放和空闲时尚未分析的曲目"
          : "暂停自动分析；已开始分析的曲目会安全完成当前一首"
      }
      onClick={toggleAutoAnalyze}
    >
      {autoPaused ? <Play size={11} /> : <Pause size={11} />}
      自动分析：{autoPaused ? "已暂停" : "运行中"}
    </button>,
  );

  const idle = !scanning && analyze === null && !downloading;

  return (
    <WorkRail
      idle={idle}
      glyphs={glyphs}
      texts={texts}
      actions={actions}
      label={idle ? "曲库概况" : "曲库任务"}
    />
  );
}
