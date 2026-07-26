import { useState } from "react";
import { Clapperboard, FolderOpen, Inbox, Music2, Play, Trash2, X } from "lucide-react";
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
  const queuedCount = list.reduce((sum, task) => sum + (task.state === "queued" ? 1 : 0), 0);
  /**
   * 「开始下载」按得动的唯一情形：闸门关着，且真有人被它拦在外面。
   *
   * 后端只有 `auto_start_downloads` 这一个闸门（DownloadManager::set_auto_start），
   * 没有"只放行当前这批"的接口。而且 `wait_until_started` 过了之后还要抢并发额度——
   * 闸门已经开着时剩下的 queued 是在等额度，再按一次什么也推不动，所以那时候要灰掉。
   */
  const canStart = !autoStart && queuedCount > 0;
  /** 队列头上两个动作共用一条错误行：一次只按得动一个，堆两条只会把列表往下挤。 */
  const [actionError, setActionError] = useState("");

  return (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div className="kd-toolbar">
        <strong>下载队列</strong>
        {/* 右栏死死的 22rem，标题+计数+两颗按钮量下来只剩 314px 可用。
            计数压到 xs 还砍掉「总计」二字，是为了给三四位数的总量留出富余——
            队列一破百就换行的话，这一行白排了。「进行」贴在前一个数上，
            后一个数是什么不用再标 */}
        <span
          className="kd-muted"
          style={{ fontSize: "var(--kd-size-xs)" }}
          title={`${activeCount} 个在下 / 队列共 ${list.length} 个`}
        >
          {activeCount} 进行 / {list.length}
        </span>
        <span className="kd-toolbar-gap" />
        {/* 这一格里唯一的红：整个面板上"现在把东西下下来"就这一个动作 */}
        <Button
          variant="primary"
          size="sm"
          disabled={!canStart}
          title={
            canStart
              ? `开始下载排队中的 ${queuedCount} 个任务`
              : autoStart
                ? "已经在下了：排队中的任务在等并发额度，让完一个自动接一个"
                : "队列里没有排队中的任务"
          }
          onClick={() => {
            setActionError("");
            void (async () => {
              await saveSettings({ auto_start_downloads: true });
              // saveSettings 自己吞异常并回滚（见 appStore 里的注释），Promise 永远 resolve，
              // 所以"到底成没成"只能回头看状态。还是 false 就是 PUT /settings 挂了——
              // 队列纹丝不动而不吭声，按钮看起来就是坏的
              if (!useAppStore.getState().settings?.auto_start_downloads) {
                setActionError("开始下载失败：设置没保存上，检查后端连接");
              }
            })();
          }}
        >
          <Play size={12} />
          开始下载
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={finishedCount <= 0}
          title="清掉已完成 / 失败 / 已取消的记录，进行中的留着"
          onClick={() => {
            setActionError("");
            void clear().catch((error: unknown) =>
              setActionError(`清空失败：${(error as Error).message}`),
            );
          }}
        >
          <Trash2 size={12} />
          清空
        </Button>
      </div>

      {/* 就贴在动作那条工具条底下 */}
      <InlineNotice text={actionError} onDismiss={() => setActionError("")} block />

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
