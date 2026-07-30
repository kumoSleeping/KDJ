import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BarChart3,
  CheckSquare,
  Copy,
  Download,
  LocateFixed,
  Music2,
  Pause,
  Play,
  Scissors,
  Search,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { forgetQueuedAnalysis } from "../../lib/autoAnalyze";
import { isOutsideFolder } from "../../lib/outsideFolder";
import {
  getPlayingTrack,
  subscribePlayingTrack,
} from "../../lib/playingTrack";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { Button } from "../common";
import { DETAIL_EVENT } from "../library/TrackTable";
import { AnalysisGlyph } from "./ActivityRail";
import { WorkRail, WorkRailSelection } from "./WorkRail";

function ScanGlyph() {
  return (
    <svg className="kd-activity-glyph kd-activity-glyph-scan" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="1.6" />
      <rect x="2" y="7.2" width="9" height="1.6" />
      <rect x="2" y="11.4" width="11" height="1.6" />
    </svg>
  );
}

function LibrarySearchField({
  inputRef,
  value,
  folder,
  onChange,
  onClear,
  onBlurEmpty,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  value: string;
  folder: string;
  onChange(value: string): void;
  onClear(): void;
  onBlurEmpty?: () => void;
}) {
  return (
    <label className="kd-activity-search kd-activity-search-expanded">
      <Search size={13} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={
          folder && !isOutsideFolder(folder) ? "在当前文件夹中搜索" : "在全部歌曲中搜索"
        }
        aria-label={
          folder && !isOutsideFolder(folder)
            ? "搜索当前文件夹的曲目名称"
            : folder
              ? "搜索目录外曲目的名称"
              : "搜索全部曲目的名称"
        }
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClear();
          }
        }}
        onBlur={() => {
          if (!value.trim()) onBlurEmpty?.();
        }}
      />
      <button
        type="button"
        aria-label="关闭曲目搜索"
        title="关闭曲目搜索"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClear}
      >
        <X size={12} />
      </button>
    </label>
  );
}

/**
 * 曲库半栏工作条，与搜索半栏 SearchWorkRail 同行对齐。
 *
 * - 平常：概况 + 右侧小搜索入口
 * - 点开搜索：整条换成搜索框；多选再顶掉搜索
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
  const maintenance = useLibraryStore((state) => state.maintenance);
  const autoAnalyzeSuspended = useLibraryStore((state) => state.autoAnalyzeSuspended);
  const stats = useLibraryStore((state) => state.stats);
  const total = useLibraryStore((state) => state.total);
  const queueView = useLibraryStore((state) => state.queueView);
  const filter = useLibraryStore((state) => state.filter);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const selectedIds = useLibraryStore((state) => state.selectedIds);
  const selectionMode = useLibraryStore((state) => state.selectionMode);
  const setSelectionMode = useLibraryStore((state) => state.setSelectionMode);
  const copyToClipboard = useLibraryStore((state) => state.copyToClipboard);
  const activeDownloads = useDownloadStore((state) => state.activeCount);
  const downloadList = useDownloadStore((state) => state.list);
  const running = downloadList.find((task) => task.state === "running");
  const autoAnalyze = useAppStore((state) => state.settings?.auto_analyze ?? true);
  const savingSettings = useAppStore((state) => state.savingSettings);
  const saveSettings = useAppStore((state) => state.saveSettings);

  const selecting = selectionMode || selectedIds.length > 1;
  const [searchOpen, setSearchOpen] = useState(() => Boolean(filter.q.trim()));
  const searchInputRef = useRef<HTMLInputElement>(null);
  const playingTrack = useSyncExternalStore(
    subscribePlayingTrack,
    getPlayingTrack,
    () => null,
  );
  const [locating, setLocating] = useState(false);

  const locatePlaying = async () => {
    if (!playingTrack || locating) return;
    setLocating(true);
    try {
      const store = useLibraryStore.getState();
      // 临时列表里找不到正在播的那首时，先回到曲库再定位。
      if (store.queueView && !store.tracks.some((track) => track.id === playingTrack.id)) {
        store.setQueueView(false);
      }
      store.selectTrack(playingTrack);
      await store.ensureTrackLoaded(playingTrack.id);
      window.dispatchEvent(
        new CustomEvent(DETAIL_EVENT, { detail: { source: "locate-playing" } }),
      );
    } finally {
      setLocating(false);
    }
  };

  // 多选顶掉搜索；有残留 query 时退出多选再把搜索展开回来。
  useEffect(() => {
    if (selecting) setSearchOpen(false);
    else if (filter.q.trim()) setSearchOpen(true);
  }, [selecting, filter.q]);

  useEffect(() => {
    if (!selecting && searchOpen) searchInputRef.current?.focus();
  }, [selecting, searchOpen]);

  const scanning = scan !== null && scan.phase !== "done";
  // maintenance 会在 store 里保留最终结果供诊断；工作条只展示仍在执行的升级。
  // 成功或带错误结束都属于已结束，不能把一次失败永久钉在主界面上。
  const activeMaintenance = maintenance.filter((item) => item.phase !== "done");
  const downloading = showDownloads && activeDownloads > 0;
  const autoPaused = autoAnalyzeSuspended || !autoAnalyze;
  const searchExpanded = !queueView && !selecting && searchOpen;

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

  const clearSearch = () => {
    setFilter({ q: "" });
    setSearchOpen(false);
  };

  if (selecting) {
    return (
      <WorkRail
        idle={false}
        glyphs={[
          <span key="sel" className="kd-activity-glyph kd-activity-glyph-sel" aria-hidden="true">
            <CheckSquare size={13} strokeWidth={2.25} />
          </span>,
        ]}
        texts={[
          <WorkRailSelection
            key="sel"
            count={selectedIds.length}
            onSelectAll={() => useLibraryStore.getState().selectAll()}
            onClear={() => useLibraryStore.getState().select(null)}
            onDone={() => {
              setSelectionMode(false);
              useLibraryStore.getState().select(null);
            }}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={selectedIds.length === 0}
                  onClick={() => copyToClipboard("link")}
                >
                  <Copy size={12} /> 复制
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={selectedIds.length === 0}
                  onClick={() => copyToClipboard("move")}
                >
                  <Scissors size={12} /> 剪切
                </Button>
              </>
            }
          />,
        ]}
        actions={actions}
        label="曲库多选"
      />
    );
  }

  if (searchExpanded) {
    return (
      <WorkRail
        idle
        glyphs={[]}
        texts={[]}
        trailing={
          <LibrarySearchField
            inputRef={searchInputRef}
            value={filter.q}
            folder={filter.folder}
            onChange={(value) => setFilter({ q: value })}
            onClear={clearSearch}
            onBlurEmpty={() => setSearchOpen(false)}
          />
        }
        actions={actions}
        label="曲库搜索"
      />
    );
  }

  const glyphs: ReactNode[] = [];
  const texts: ReactNode[] = [];

  for (const task of activeMaintenance) {
    glyphs.push(<ScanGlyph key={`maintenance-${task.kind}`} />);
    const label = task.kind === "waveform" ? "演奏波形" : "文件夹数据";
    texts.push(
      <span
        key={`maintenance-${task.kind}`}
        className="kd-activity-text"
        title={task.error || task.current}
      >
        {task.error
          ? `${label}升级未完全完成 · ${task.error}`
          : `正在准备${label} ${task.done}/${task.total}`}
        {!task.error && task.current ? ` · ${task.current}` : ""}
      </span>,
    );
  }
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

  if (activeMaintenance.length === 0 && !scanning && analyze === null && !downloading) {
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

  const idle = activeMaintenance.length === 0 && !scanning && analyze === null && !downloading;
  const locateButton = (
    <button
      type="button"
      className="kd-activity-search-toggle"
      aria-label="定位正在播放"
      title={
        playingTrack
          ? `定位正在播放：${playingTrack.title || playingTrack.filename}`
          : "当前没有正在播放的曲目"
      }
      disabled={!playingTrack || locating}
      onClick={() => {
        void locatePlaying();
      }}
    >
      <LocateFixed size={14} strokeWidth={2.25} />
    </button>
  );
  const trailing = (
    <span className="kd-activity-trailing-tools">
      {locateButton}
      {!queueView ? (
        <button
          type="button"
          className="kd-activity-search-toggle"
          aria-label="搜索曲目"
          title={
            filter.folder && !isOutsideFolder(filter.folder)
              ? "在当前文件夹中搜索"
              : "在全部歌曲中搜索"
          }
          onClick={() => setSearchOpen(true)}
        >
          <Search size={14} strokeWidth={2.25} />
        </button>
      ) : null}
    </span>
  );

  return (
    <WorkRail
      idle={idle}
      glyphs={glyphs}
      texts={texts}
      trailing={trailing}
      actions={actions}
      label={idle ? "曲库概况" : "曲库任务"}
    />
  );
}
