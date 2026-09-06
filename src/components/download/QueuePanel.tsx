import { useState } from "react";
import {
  CircleMinus,
  Copy,
  FolderOpen,
  Link2,
  Music2,
  PencilLine,
  RotateCcw,
  Trash2,
  Video,
} from "lucide-react";
import { api } from "../../lib/api";
import { copyText } from "../../lib/copyText";
import { copyShareContent, remoteArtwork } from "../../lib/shareClipboard";
import { formatShareText, platformShareLink } from "../../lib/shareLink";
import { useSharePrefs } from "../../lib/sharePrefs";
import { folderName, formatPercent, thumbUrl } from "../../lib/format";
import { SEARCH_QUEUE_DROP_ATTR } from "../../lib/folderDrop";
import {
  enqueueSearchQueuePayload,
  finishSearchDrop,
  isSearchDownloadDrag,
  readSearchDrop,
} from "../../lib/searchDrag";
import { forgetQueueDraft, patchVideoDraft, setQueueDraft } from "../../lib/queueTaskDraft";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { DownloadTask, Quality, TaskPhase, TaskState } from "../../types";
import { Button, ContextMenu, InlineNotice } from "../common";
import { QueueChoice, QueueCover, QueueFrame, QueueList, QueueOverview, QueueStateMark } from "../queue/QueuePrimitives";
import { PLATFORM_LABEL } from "./MergedGroupRow";
import { PlatformMark } from "./PlatformMark";

const STATE_LABEL: Record<TaskState, string> = {
  queued: "待开始",
  running: "进行中",
  processing: "处理中",
  done: "完成",
  failed: "上次下载失败",
  paused: "已暂停",
  canceled: "已取消",
};

const PHASE_LABEL: Record<TaskPhase, string> = {
  waiting: "待开始",
  authorizing: "获取授权",
  resolving: "解析来源",
  downloading: "下载中",
  post_processing: "整理媒体",
  relocating: "移动文件",
  importing: "加入曲库",
  completed: "完成",
};

function stateLabel(task: DownloadTask): string {
  if (task.state === "failed" && task.path.trim()) {
    return "已下载，入库失败";
  }
  if (
    task.state === "queued" ||
    task.state === "running" ||
    task.state === "processing"
  ) {
    return PHASE_LABEL[task.phase] ?? STATE_LABEL[task.state];
  }
  return STATE_LABEL[task.state];
}

/** 和视频结果行同一套高度阶梯：点一下切一档。 */
const VIDEO_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const AUDIO_QUALITIES: Quality[] = ["flac", "320", "128"];

function TaskStateMark({ task }: { task: DownloadTask }) {
  return <QueueStateMark state={task.state} />;
}

/**
 * 队列可能一次塞进几百首，只让滚动视口内的封面进入 DOM。
 * 固定尺寸外框始终保留，因此图片挂载/卸载不会推动文字或滚动位置。
 */
function QueueTaskCover({ task }: { task: DownloadTask }) {
  return <QueueCover artwork={task.cover?.trim() ? thumbUrl(task.cover, 96) : ""} video={task.kind === "video"} />;
}

/**
 * 质量既是信息也是配置：直接在原来的元数据位置切换，行高和排序都不动。
 */
function QueueQualityControl({
  task,
  onError,
}: {
  task: DownloadTask;
  onError(message: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const editable =
    (task.state === "queued" || task.state === "paused" || task.state === "failed") &&
    Boolean(task.quality) &&
    !(task.kind === "video" && task.quality.toLowerCase() === "audio");
  const normalizedQuality = task.quality.toLowerCase();
  const videoHeight = Number.parseInt(task.quality, 10);
  const label =
    task.kind === "audio"
      ? normalizedQuality === "flac"
        ? "FLAC"
        : `${normalizedQuality}K`
      : Number.isFinite(videoHeight)
        ? `${videoHeight}p`
        : task.quality.toUpperCase();
  const icon = task.kind === "video" ? <Video size={10} /> : <Music2 size={10} />;

  if (!editable) {
    return (
      <span className="kd-download-task-quality kd-mono">
        {icon}
        {label}
      </span>
    );
  }

  const options =
    task.kind === "audio"
      ? AUDIO_QUALITIES.map((quality) => ({
          value: quality,
          label: quality === "flac" ? "FLAC" : `${quality}K`,
        }))
      : [
          ...(Number.isFinite(videoHeight) && !VIDEO_HEIGHTS.includes(videoHeight)
            ? [{ value: String(videoHeight), label: `${videoHeight}p` }]
            : []),
          ...VIDEO_HEIGHTS.map((height) => ({ value: String(height), label: `${height}p` })),
        ];

  return (
    <QueueChoice
      icon={icon}
      options={options}
      label={`本条${task.kind === "video" ? "视频画质" : "音质"}，当前 ${label}`}
        value={task.kind === "audio" ? normalizedQuality : String(videoHeight)}
        disabled={busy}
        onChange={(nextValue) => {
          setBusy(true);
          onError("");
          void (async () => {
            if (task.kind === "audio") {
              const next = nextValue as Quality;
              const updated = await api.updateDownloadQuality(task.id, next);
              useDownloadStore.getState().mergeTasks([updated]);
              setQueueDraft(task.id, { kind: "audio", quality: next });
              return;
            }

            const next = Number.parseInt(nextValue, 10);
            const updated = await api.updateDownloadHeight(task.id, next);
            useDownloadStore.getState().mergeTasks([updated]);
            patchVideoDraft(task.id, { request: { max_height: next } });
          })()
            .catch((error: unknown) =>
              onError(`更改本条质量失败：${(error as Error).message}`),
            )
            .finally(() => setBusy(false));
        }}
      />
  );
}

function QueueRow({
  task,
  order,
  onOpenTask,
}: {
  task: DownloadTask;
  order: string;
  onOpenTask(task: DownloadTask): void;
}) {
  const cancel = useDownloadStore((store) => store.cancel);
  const retry = useDownloadStore((store) => store.retry);
  const remove = useDownloadStore((store) => store.remove);
  const shareContentMode = useSharePrefs((state) => state.contentMode);
  /** 行内操作失败的原因，和任务自己的 error 共用行尾那一行。 */
  const [cancelError, setCancelError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const active =
    task.state === "queued" || task.state === "running" || task.state === "processing";
  // 没有总大小时无法给出真实百分比，只显示当前阶段，避免伪造一个一直不动的 0%。
  const showPercent =
    (task.state === "running" || task.state === "processing") && task.total_bytes > 0;
  const resolvedVideoPage =
    task.kind === "video" && task.platform === "bilibili" ? task.video_page : null;
  // 解析前先显示 P1；确认整条视频只有一 P 后收掉无意义的标记。
  const videoPage =
    resolvedVideoPage && (resolvedVideoPage.count !== 1 || resolvedVideoPage.index > 0)
      ? resolvedVideoPage
      : null;
  const pageLabel = videoPage
    ? `P${videoPage.index + 1}${videoPage.count > 1 ? `/${videoPage.count}` : ""}`
    : "";
  const shareLink = platformShareLink(
    task.platform,
    task.source_key?.trim() || "",
    videoPage
      ? { page_index: videoPage.index, page_count: videoPage.count }
      : undefined,
  );
  const recordedTarget = task.path.trim()
    ? task.path.replace(/[\\/][^\\/]*$/, "") || task.path
    : task.output_dir || task.dest_dir || "";

  return (
    <article
      className="kd-download-task"
      data-state={task.state}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="kd-download-task-head">
        <span
          className="kd-download-task-order kd-mono"
          aria-label={`队列第 ${Number.parseInt(order, 10)} 项`}
        >
          {order}
        </span>
        <div className="kd-download-task-summary">
          <QueueTaskCover task={task} />
          <span className="kd-download-task-copy">
            <span className="kd-download-task-title" title={`${task.title} — ${task.artist}`}>
              {task.title}
            </span>
            <span className="kd-download-task-artist kd-truncate">{task.artist}</span>
            <span className="kd-download-task-meta">
              <span className="kd-download-task-source">
                <PlatformMark id={task.platform} size={11} branded />
                <span>{PLATFORM_LABEL[task.platform] ?? task.platform}</span>
              </span>
              {videoPage ? (
                <span
                  className="kd-download-task-page kd-mono"
                  title={videoPage.title ? `${pageLabel} · ${videoPage.title}` : pageLabel}
                >
                  <strong>{pageLabel}</strong>
                  {videoPage.title ? <span>· {videoPage.title}</span> : null}
                </span>
              ) : null}
              {task.quality ? (
                <QueueQualityControl task={task} onError={setCancelError} />
              ) : null}
              {recordedTarget.trim() ? (
                <span
                  className="kd-download-task-target kd-mono"
                  title={recordedTarget}
                >
                  <FolderOpen size={10} />
                  {folderName(recordedTarget)}
                </span>
              ) : null}
            </span>
          </span>
          <span className="kd-download-task-state">
            <span className="kd-download-task-state-label">
              <TaskStateMark task={task} />
              <span className="kd-download-task-state-text">{stateLabel(task)}</span>
            </span>
            <span
              className="kd-download-task-percent kd-mono"
              data-visible={showPercent ? "true" : "false"}
              aria-hidden={!showPercent}
            >
              {showPercent ? formatPercent(task.progress) : "100%"}
            </span>
          </span>
        </div>

        <div className="kd-download-task-actions">
          {task.state === "failed" ? (
            <Button
              variant="primary"
              size="sm"
              disabled={retrying}
              aria-label="重试下载"
              title="重试下载"
              onClick={() => {
                setCancelError("");
                setRetrying(true);
                void retry(task.id)
                  .catch((error: unknown) =>
                    setCancelError(`重试失败：${(error as Error).message}`),
                  )
                  .finally(() => setRetrying(false));
              }}
            >
              <RotateCcw size={11} />
              {retrying ? "重试中" : "重试"}
            </Button>
          ) : null}
          {active ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="取消"
              title="取消这项"
              onClick={() => {
                setCancelError("");
                void cancel(task.id)
                  .then(() => forgetQueueDraft(task.id))
                  .catch((error: unknown) =>
                    setCancelError(`取消失败：${(error as Error).message}`),
                  );
              }}
            >
              <CircleMinus size={12} />
            </Button>
          ) : !active && task.path ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="在文件管理器中显示下载文件"
              title={`在文件管理器中显示：${task.path}`}
              onClick={() => onOpenTask(task)}
            >
              <FolderOpen size={12} />
            </Button>
          ) : null}
          {!active ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="移除队列记录"
              title="只移除队列记录，不删除下载文件"
              onClick={() =>
                void remove(task.id)
                  .then(() => forgetQueueDraft(task.id))
                  .catch((error: unknown) =>
                    setCancelError(`移除失败：${(error as Error).message}`),
                  )
              }
            >
              <Trash2 size={12} />
            </Button>
          ) : null}
        </div>
      </div>

      {task.error && task.error.trim() !== stateLabel(task) ? (
        <div className="kd-download-task-error" title={task.error}>
          <span className="kd-truncate">{task.error}</span>
        </div>
      ) : null}
      {/* 取消失败是"我按了但没反应"，必须留在这一条上：任务还在跑，
          光看状态根本分不清是没点上还是后端拒绝了 */}
      {cancelError && (
        <div className="kd-download-task-notice">
          <InlineNotice text={cancelError} onDismiss={() => setCancelError("")} />
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            onClick={() => {
              void copyText(task.title);
              setMenu(null);
            }}
          >
            <Copy size={12} />
            复制标题
          </button>
          {task.artist ? (
            <button
              type="button"
              onClick={() => {
                void copyText(task.artist);
                setMenu(null);
              }}
            >
              <Copy size={12} />
              复制艺人
            </button>
          ) : null}
          {shareLink ? (
            <button
              type="button"
              onClick={() => {
                void copyShareContent(
                  formatShareText(
                    shareLink,
                    { title: task.title, artists: task.artist },
                    shareContentMode,
                  ),
                  shareContentMode,
                  remoteArtwork(task.cover || ""),
                );
                setMenu(null);
              }}
            >
              <Link2 size={12} />
              复制分享内容
            </button>
          ) : null}
          {task.path.trim() ? (
            <button
              type="button"
              onClick={() => {
                void copyText(task.path);
                setMenu(null);
              }}
            >
              <Copy size={12} />
              复制文件路径
            </button>
          ) : null}
        </ContextMenu>
      )}
    </article>
  );
}

/**
 * 队列概览只保留两层：当前真正可执行的动作，以及一条紧凑的默认参数带。
 * 开始 / 清记录始终占住固定位置；空队列时置灰，避免按钮随状态左右跳动。
 */
function QueuePrefsBar({
  canStart,
  canPause,
  canClear,
  queuedCount,
  pausedCount,
  failedCount,
  activeCount,
  clearableCount,
  totalCount,
  onStart,
  onPause,
  onClear,
  onError,
}: {
  canStart: boolean;
  canPause: boolean;
  canClear: boolean;
  queuedCount: number;
  pausedCount: number;
  failedCount: number;
  activeCount: number;
  clearableCount: number;
  totalCount: number;
  onStart(): void;
  onPause(): void;
  onClear(): void;
  onError(message: string): void;
}) {
  const settings = useAppStore((store) => store.settings);
  const saveSettings = useAppStore((store) => store.saveSettings);
  if (!settings) return null;

  const qualities: Quality[] = ["flac", "320", "128"];
  const quality = settings.default_quality;
  const qualityIndex = qualities.indexOf(quality);
  const qualityLabel = quality === "flac" ? "FLAC" : `${quality}K`;

  const height = settings.video_max_height;
  const heightIndex = VIDEO_HEIGHTS.indexOf(height);
  const heightLabel = `${height > 0 ? height : 1080}p`;
  const downloadDir = settings.download_dir;
  const pendingCount = queuedCount + pausedCount + failedCount;
  const startActions = [
    queuedCount > 0 ? `开始 ${queuedCount} 个排队任务` : "",
    pausedCount > 0 ? `继续 ${pausedCount} 个暂停任务` : "",
    failedCount > 0 ? `重新下载 ${failedCount} 个上次失败任务` : "",
  ]
    .filter(Boolean)
    .join("，");
  const workingCount = Math.max(0, activeCount - queuedCount);
  const summaryFacts = [
    workingCount > 0 ? { count: workingCount, label: "进行中", tone: "running" } : null,
    pendingCount > 0 ? { count: pendingCount, label: "待开始", tone: "queued" } : null,
  ].filter((fact): fact is { count: number; label: string; tone: string } => fact !== null);
  if (summaryFacts.length === 0 && totalCount > 0) {
    summaryFacts.push({ count: totalCount, label: "已结束", tone: "finished" });
  }
  return (
    <section className="kd-download-prefs" aria-label="下载队列概览">
      <QueueOverview facts={summaryFacts} total={totalCount} canStart={canStart} canSecondary={canPause || canClear}
        startTitle={canStart ? `${startActions}（下载 / 导出）` : "没有待开始的任务"}
        secondaryTitle={canPause ? "暂停当前整批下载" : `只清除 ${clearableCount} 条队列记录，不删除下载文件`}
        secondaryKind={canPause ? "pause" : "clear"} secondaryLabel={canPause ? "暂停" : "清记录"}
        onStart={onStart} onSecondary={canPause ? onPause : onClear} />

      <div className="kd-download-defaults" aria-label="默认下载参数">
        <span className="kd-download-defaults-label">默认</span>
        <button
          type="button"
          className="kd-download-default"
          title={`默认下载音质：${qualityLabel}。点击切换`}
          onClick={() =>
            void saveSettings({
              default_quality: qualities[(qualityIndex + 1 + qualities.length) % qualities.length],
            }).catch(() => undefined)
          }
        >
          <Music2 size={11} />
          <span>音频</span>
          <strong>{qualityLabel}</strong>
        </button>
        <button
          type="button"
          className="kd-download-default"
          title={`默认视频画质上限：${heightLabel}。点击切换`}
          onClick={() => {
            const next =
              VIDEO_HEIGHTS[(heightIndex + 1 + VIDEO_HEIGHTS.length) % VIDEO_HEIGHTS.length] ?? 1080;
            void saveSettings({ video_max_height: next }).catch(() => undefined);
          }}
        >
          <Video size={11} />
          <span>视频</span>
          <strong>{heightLabel}</strong>
        </button>
        <span className="kd-toolbar-gap" />
        {downloadDir ? (
          <button
            type="button"
            className="kd-download-destination"
            title={`打开默认下载文件夹：${downloadDir}`}
            onClick={() => {
              void window.kdj?.openPath(downloadDir).catch((error: unknown) =>
                onError(`打开下载文件夹失败：${(error as Error).message}`),
              );
            }}
          >
            <FolderOpen size={11} />
            <span className="kd-truncate">{folderName(downloadDir)}</span>
          </button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="kd-download-destination-edit"
          aria-label={downloadDir ? "更改默认下载文件夹" : "设置默认下载文件夹"}
          title={downloadDir ? "更改默认下载文件夹" : "设置默认下载文件夹"}
          onClick={() => {
            void window.kdj?.pickFolder()
              .then((dir) => {
                if (dir) return saveSettings({ download_dir: dir, video_download_dir: dir });
              })
              .catch((error: unknown) =>
                onError(`更改下载文件夹失败：${(error as Error).message}`),
              );
          }}
        >
          <PencilLine size={11} />
        </Button>
      </div>
    </section>
  );
}

export function QueuePanel() {
  const list = useDownloadStore((store) => store.list);
  const activeCount = useDownloadStore((store) => store.activeCount);
  const clear = useDownloadStore((store) => store.clear);
  const pauseAll = useDownloadStore((store) => store.pauseAll);
  const [dropActive, setDropActive] = useState(false);
  const queuedCount = list.reduce((sum, task) => sum + (task.state === "queued" ? 1 : 0), 0);
  const pausedCount = list.reduce((sum, task) => sum + (task.state === "paused" ? 1 : 0), 0);
  const failedCount = list.reduce(
    (sum, task) => sum + (task.state === "failed" ? 1 : 0),
    0,
  );
  const clearableCount = list.reduce(
    (sum, task) =>
      sum + (task.state === "running" || task.state === "processing" ? 0 : 1),
    0,
  );
  const canClear = clearableCount > 0;
  const canPause = list.some(
    (task) => task.state === "running" || task.state === "processing",
  );
  /**
   * 「开始下载」同时放行当前队列并重试失败歌曲；以后新加的任务仍继续排队，
   * 不会因为点过一次「开始下载」就永久锁进自动下载模式。
   */
  const canStart = queuedCount > 0 || pausedCount > 0 || failedCount > 0;
  /** 队列头上两个动作共用一条错误行：一次只按得动一个，堆两条只会把列表往下挤。 */
  const [actionError, setActionError] = useState("");

  const openTask = (task: DownloadTask) => {
    const path = task.path;
    // 入库失败等异常任务会保留最终落盘路径；直接让文件管理器选中成品，
    // 比切到一个可能尚未入库的目录筛选更可靠。
    void window.kdj?.revealPath(path).catch((error: unknown) =>
      setActionError(`定位下载文件失败：${(error as Error).message}`),
    );
  };

  return (
    <QueueFrame
      className="kd-col kd-download-dropzone"
      data-drop-active={dropActive ? "true" : undefined}
      {...{ [SEARCH_QUEUE_DROP_ATTR]: "true" }}
      style={{ height: "100%", minHeight: 0 }}
      onDragOver={(event) => {
        if (!isSearchDownloadDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        const payload = readSearchDrop(event.dataTransfer);
        finishSearchDrop();
        if (!payload) return;
        event.preventDefault();
        void enqueueSearchQueuePayload(payload).catch((error: unknown) =>
          setActionError(`加入队列失败：${(error as Error).message}`),
        );
      }}
    >
      <QueuePrefsBar
        canStart={canStart}
        canPause={canPause}
        canClear={canClear}
        queuedCount={queuedCount}
        pausedCount={pausedCount}
        failedCount={failedCount}
        activeCount={activeCount}
        clearableCount={clearableCount}
        totalCount={list.length}
        onStart={() => {
          setActionError("");
          void (async () => {
            try {
              await api.startDownloads();
            } catch (error: unknown) {
              setActionError(`开始下载失败：${(error as Error).message}`);
            }
          })();
        }}
        onPause={() => {
          setActionError("");
          void pauseAll().catch((error: unknown) =>
            setActionError(`暂停下载失败：${(error as Error).message}`),
          );
        }}
        onClear={() => {
          setActionError("");
          void clear().catch((error: unknown) =>
            setActionError(`清除记录失败：${(error as Error).message}`),
          );
        }}
        onError={setActionError}
      />

      <InlineNotice text={actionError} onDismiss={() => setActionError("")} block />

      <QueueList>
        {list.map((task, index) => (
          <QueueRow
            key={task.id}
            task={task}
            order={String(index + 1)}
            onOpenTask={openTask}
          />
        ))}
      </QueueList>
    </QueueFrame>
  );
}
