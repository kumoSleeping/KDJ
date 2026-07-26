import { useState } from "react";
import { Clapperboard, FolderOpen, Inbox, Music2, Trash2, X } from "lucide-react";
import { DASH, folderName, formatBytes, formatPercent, formatSpeed } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { DownloadTask, Settings, TaskState } from "../../types";
import { Button, EmptyState, InlineNotice, ProgressBar } from "../common";
import { PLATFORM_LABEL } from "./MergedGroupRow";

const STATE_LABEL: Record<TaskState, string> = {
  queued: "排队",
  running: "下载中",
  done: "完成",
  failed: "失败",
  canceled: "已取消",
};

const STATE_TONE: Record<TaskState, "theme" | "ok" | "warn" | "danger"> = {
  queued: "warn",
  running: "theme",
  done: "ok",
  failed: "danger",
  canceled: "warn",
};

function progressState(state: TaskState): "running" | "done" | "failed" {
  if (state === "done") return "done";
  if (state === "failed" || state === "canceled") return "failed";
  return "running";
}

function QueueRow({ task }: { task: DownloadTask }) {
  const cancel = useDownloadStore((store) => store.cancel);
  /** 取消这一条失败时的原因，和任务自己的 error 共用行尾那一行。 */
  const [cancelError, setCancelError] = useState("");
  const active = task.state === "queued" || task.state === "running";
  // 后端拿不到 Content-Length 时 total_bytes 是 0，此时进度条走不确定态，
  // 否则会一直停在 0% 让人以为卡死了
  const unknownTotal = task.state === "running" && task.total_bytes <= 0;

  return (
    <div className="kd-queue-row">
      <span className="kd-queue-title" title={`${task.title} — ${task.artist}`}>
        {task.title}
      </span>
      <span className="kd-row" style={{ gap: "0.3rem" }}>
        <span className="kd-chip" data-tone={STATE_TONE[task.state]}>
          {STATE_LABEL[task.state]}
        </span>
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="取消"
            onClick={() => {
              setCancelError("");
              void cancel(task.id).catch((error: unknown) =>
                setCancelError(`取消失败：${(error as Error).message}`),
              );
            }}
          >
            <X size={12} />
          </Button>
        ) : task.state === "done" && task.path ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="在文件夹中显示"
            onClick={() => void window.kumodeck?.revealPath(task.path)}
          >
            <FolderOpen size={12} />
          </Button>
        ) : null}
      </span>

      <div className="kd-queue-meta">
        <span>{task.artist || DASH}</span>
        <span className="kd-faint">·</span>
        <span className="kd-mono">{PLATFORM_LABEL[task.platform] ?? task.platform}</span>
        {task.quality && <span className="kd-mono">{task.quality.toUpperCase()}</span>}
        <span className="kd-toolbar-gap" />
        {task.state === "running" && <span>{formatSpeed(task.speed_bps)}</span>}
        {task.total_bytes > 0 && (
          <span>
            {formatBytes(task.downloaded_bytes)} / {formatBytes(task.total_bytes)}
          </span>
        )}
        {task.state === "running" && !unknownTotal && <span>{formatPercent(task.progress)}</span>}
      </div>

      {active && (
        <div style={{ gridColumn: "1 / -1" }}>
          <ProgressBar
            value={task.progress}
            state={progressState(task.state)}
            indeterminate={unknownTotal}
          />
        </div>
      )}

      {task.error && (
        <div className="kd-queue-meta" style={{ color: "var(--kd-danger)" }} title={task.error}>
          <span className="kd-truncate">{task.error}</span>
        </div>
      )}

      {/* 取消失败是"我按了但没反应"，必须留在这一条上：任务还在跑，
          光看进度条根本分不清是没点上还是后端拒绝了 */}
      {cancelError && (
        <div style={{ gridColumn: "1 / -1" }}>
          <InlineNotice text={cancelError} onDismiss={() => setCancelError("")} />
        </div>
      )}
    </div>
  );
}

/**
 * 保存目录就放在队列头上：任务往哪落、想换个地方落，都是在看队列时冒出来的念头。
 * 音乐和视频各一个芯片，点开选目录，存回设置。原来塞在搜索框上的那个目录按钮删了——
 * 搜索的时候人在想"找什么"，不是"存哪里"。
 */
function SaveDirRow() {
  const settings = useAppStore((store) => store.settings);
  const saveSettings = useAppStore((store) => store.saveSettings);
  if (!settings) return null;

  const pick = (key: keyof Pick<Settings, "download_dir" | "video_download_dir">) => {
    void window.kumodeck?.pickFolder().then((dir) => {
      if (dir) void saveSettings({ [key]: dir });
    });
  };

  return (
    <div className="kd-toolbar" data-slim="true">
      <span className="kd-faint" style={{ fontSize: "var(--kd-size-xs)" }}>
        保存到
      </span>
      <button
        type="button"
        className="kd-path-chip"
        title={`音乐下载到 ${settings.download_dir}（点击更改）`}
        onClick={() => pick("download_dir")}
      >
        <Music2 size={11} />
        <span className="kd-truncate">{folderName(settings.download_dir) || "选择目录"}</span>
      </button>
      <button
        type="button"
        className="kd-path-chip"
        title={`视频下载到 ${settings.video_download_dir}（点击更改）`}
        onClick={() => pick("video_download_dir")}
      >
        <Clapperboard size={11} />
        <span className="kd-truncate">{folderName(settings.video_download_dir) || "选择目录"}</span>
      </button>
      <span className="kd-toolbar-gap" />
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="在访达中打开音乐下载目录"
        title="在访达中打开音乐下载目录"
        onClick={() => void window.kumodeck?.revealPath(settings.download_dir)}
      >
        <FolderOpen size={12} />
      </Button>
    </div>
  );
}

export function QueuePanel() {
  const list = useDownloadStore((store) => store.list);
  const activeCount = useDownloadStore((store) => store.activeCount);
  const clear = useDownloadStore((store) => store.clear);
  const autoStart = useAppStore((store) => store.settings?.auto_start_downloads ?? false);
  const saveSettings = useAppStore((store) => store.saveSettings);
  const finishedCount = list.length - activeCount;
  /** 清理失败：列表纹丝不动，不说一声就等于按钮坏了。 */
  const [clearError, setClearError] = useState("");

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-toolbar">
        <strong>下载队列</strong>
        <span className="kd-muted">
          {activeCount} 进行 / {list.length} 总计
        </span>
        <span className="kd-toolbar-gap" />
        {/* 关着 = 入队先攒着；拨开这一下就是"现在开始下"，攒着的全部放行 */}
        <label
          className="kd-check"
          title={
            autoStart
              ? "自动下载开着：加入队列立刻开始"
              : "自动下载关着：任务先攒在队列里，拨开开关才开始下"
          }
        >
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(event) => void saveSettings({ auto_start_downloads: event.target.checked })}
          />
          自动下载
        </label>
        <Button
          variant="ghost"
          size="sm"
          disabled={finishedCount <= 0}
          title="清掉已完成 / 失败 / 已取消的记录"
          onClick={() => {
            setClearError("");
            void clear().catch((error: unknown) =>
              setClearError(`清理失败：${(error as Error).message}`),
            );
          }}
        >
          <Trash2 size={12} />
          清理
        </Button>
      </div>

      {/* 就贴在「清理」这条工具条底下 */}
      <InlineNotice text={clearError} onDismiss={() => setClearError("")} block />

      <SaveDirRow />

      <div className="kd-scroll kd-grow" style={{ minHeight: 0 }}>
        {list.length === 0 ? (
          <EmptyState
            icon={<Inbox size={20} />}
            title="队列是空的"
            hint="在左边勾选歌曲，底部会出现「加入队列」。"
          />
        ) : (
          list.map((task) => <QueueRow key={task.id} task={task} />)
        )}
      </div>
    </div>
  );
}
