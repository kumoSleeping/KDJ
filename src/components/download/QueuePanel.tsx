import { useState } from "react";
import { Copy, FolderOpen, Inbox, PencilLine, Play, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { copyText } from "../../lib/copyText";
import { DASH, folderName, formatBytes, formatPercent, formatSpeed } from "../../lib/format";
import { SEARCH_QUEUE_DROP_ATTR } from "../../lib/folderDrop";
import {
  enqueueSearchQueuePayload,
  finishSearchDrop,
  isSearchDownloadDrag,
  readSearchDrop,
} from "../../lib/searchDrag";
import { forgetQueueDraft } from "../../lib/queueTaskDraft";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { DownloadTask, FolderNode, Quality, TaskPhase, TaskState } from "../../types";
import { Button, ContextMenu, EmptyState, InlineNotice, ProgressBar } from "../common";
import { PLATFORM_LABEL } from "./MergedGroupRow";
import { QueueRowConfig } from "./QueueRowConfig";

const STATE_LABEL: Record<TaskState, string> = {
  queued: "排队",
  running: "进行中",
  processing: "处理中",
  done: "完成",
  failed: "失败",
  canceled: "已取消",
};

const PHASE_LABEL: Record<TaskPhase, string> = {
  waiting: "排队",
  authorizing: "获取授权",
  resolving: "解析来源",
  downloading: "下载中",
  post_processing: "整理媒体",
  relocating: "移动文件",
  importing: "加入曲库",
  completed: "完成",
};

function stateLabel(task: DownloadTask): string {
  if (
    task.state === "queued" ||
    task.state === "running" ||
    task.state === "processing"
  ) {
    if (task.kind === "vj_export" && task.phase === "post_processing") return "导出中";
    return PHASE_LABEL[task.phase] ?? STATE_LABEL[task.state];
  }
  return STATE_LABEL[task.state];
}

function kindLabel(task: DownloadTask): string | null {
  if (task.kind === "vj_export") return "VJ";
  return null;
}

const STATE_TONE: Record<TaskState, "theme" | "ok" | "warn" | "danger"> = {
  queued: "warn",
  running: "theme",
  processing: "theme",
  done: "ok",
  failed: "danger",
  canceled: "warn",
};

/** 和视频结果行同一套高度阶梯：点一下切一档。 */
const VIDEO_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

function progressState(state: TaskState): "running" | "done" | "failed" {
  if (state === "done") return "done";
  if (state === "failed" || state === "canceled") return "failed";
  return "running";
}

function QueueRow({
  task,
  expanded,
  onToggle,
  onExpandId,
  onOpenTask,
}: {
  task: DownloadTask;
  expanded: boolean;
  onToggle(): void;
  onExpandId(id: string): void;
  onOpenTask(task: DownloadTask): void;
}) {
  const cancel = useDownloadStore((store) => store.cancel);
  const retry = useDownloadStore((store) => store.retry);
  const remove = useDownloadStore((store) => store.remove);
  /** 行内操作失败的原因，和任务自己的 error 共用行尾那一行。 */
  const [cancelError, setCancelError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const active =
    task.state === "queued" || task.state === "running" || task.state === "processing";
  // 后端拿不到 Content-Length 时 total_bytes 是 0，此时进度条走不确定态，
  // 否则会一直停在 0% 让人以为卡死了
  const unknownTotal = task.state === "running" && task.total_bytes <= 0;
  const kind = kindLabel(task);
  const configurable = task.kind === "video" || task.kind === "audio";

  return (
    <div
      className="kd-queue-row"
      data-expanded={expanded || undefined}
      data-configurable={configurable || undefined}
      onClick={() => {
        if (configurable) onToggle();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      title={configurable ? "下载配置" : undefined}
    >
      <span className="kd-queue-title" title={`${task.title} — ${task.artist}`}>
        {task.title}
      </span>
      <span className="kd-row" style={{ gap: "0.3rem" }} onClick={(event) => event.stopPropagation()}>
        {kind ? (
          <span className="kd-chip" data-tone="theme">
            {kind}
          </span>
        ) : null}
        {task.state === "failed" && task.kind === "audio" ? (
          <button
            type="button"
            className="kd-chip kd-chip-action"
            data-tone="danger"
            disabled={retrying}
            aria-label="重试下载"
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
            {retrying ? "重试中" : "重试"}
          </button>
        ) : (
          <span className="kd-chip" data-tone={STATE_TONE[task.state]}>
            {stateLabel(task)}
          </span>
        )}
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="取消"
            onClick={() => {
              setCancelError("");
              void cancel(task.id)
                .then(() => forgetQueueDraft(task.id))
                .catch((error: unknown) =>
                  setCancelError(`取消失败：${(error as Error).message}`),
                );
            }}
          >
            <X size={12} />
          </Button>
        ) : task.state === "done" && task.path ? (
          <button
            type="button"
            className="kd-text-action"
            aria-label={task.track_id == null ? "在访达中显示下载文件" : "在曲库中打开所在文件夹"}
            onClick={() => onOpenTask(task)}
          >
            {task.track_id == null ? "定位" : "打开"}
          </button>
        ) : null}
        {!active ? (
          <button
            type="button"
            className="kd-text-action"
            aria-label="移除队列记录"
            onClick={() =>
              void remove(task.id)
                .then(() => forgetQueueDraft(task.id))
                .catch((error: unknown) => setCancelError(`移除失败：${(error as Error).message}`))
            }
          >
            移除
          </button>
        ) : null}
      </span>

      <div className="kd-queue-meta">
        <span>{task.artist || DASH}</span>
        <span className="kd-faint">·</span>
        <span className="kd-mono">{PLATFORM_LABEL[task.platform] ?? task.platform}</span>
        {task.quality && <span className="kd-mono">{task.quality.toUpperCase()}</span>}
        {(task.output_dir || task.dest_dir)?.trim() ? (
          <>
            <span className="kd-faint">·</span>
            <span className="kd-mono" title={task.output_dir || task.dest_dir}>
              → {folderName(task.output_dir || task.dest_dir || "")}
            </span>
          </>
        ) : null}
        <span className="kd-toolbar-gap" />
        {task.state === "running" && <span>{formatSpeed(task.speed_bps)}</span>}
        {(task.state === "processing" || (task.state === "running" && task.phase !== "downloading")) && (
          <span className="kd-muted">{PHASE_LABEL[task.phase]}</span>
        )}
        {task.total_bytes > 0 && (
          <span>
            {formatBytes(task.downloaded_bytes)} / {formatBytes(task.total_bytes)}
          </span>
        )}
        {task.state === "running" && !unknownTotal && <span>{formatPercent(task.progress)}</span>}
      </div>

      {active && (
        <div style={{ gridColumn: "1 / -1" }} onClick={(event) => event.stopPropagation()}>
          <ProgressBar
            value={task.progress}
            state={progressState(task.state)}
            indeterminate={unknownTotal || task.state === "processing"}
          />
        </div>
      )}

      {task.error && (
        <div className="kd-queue-meta" style={{ color: "var(--kd-danger)" }} title={task.error}>
          <span className="kd-truncate">{task.error}</span>
        </div>
      )}
      {task.one_library_error && (
        <div className="kd-queue-meta" style={{ color: "var(--kd-danger)" }} title={task.one_library_error}>
          <span className="kd-truncate">{task.one_library_error}</span>
        </div>
      )}

      {/* 取消失败是"我按了但没反应"，必须留在这一条上：任务还在跑，
          光看进度条根本分不清是没点上还是后端拒绝了 */}
      {cancelError && (
        <div style={{ gridColumn: "1 / -1" }} onClick={(event) => event.stopPropagation()}>
          <InlineNotice text={cancelError} onDismiss={() => setCancelError("")} />
        </div>
      )}

      <div style={{ gridColumn: "1 / -1" }} onClick={(event) => event.stopPropagation()}>
        <QueueRowConfig
          task={task}
          open={expanded}
          onTaskReplaced={onExpandId}
        />
      </div>

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
        </ContextMenu>
      )}
    </div>
  );
}

/**
 * 队列头两行工具条：
 * 1) 开始 / 清空 / 计数 / 音质 / 画质
 * 2) 音频和视频共用的默认保存目录（拖进文件夹时仍以目标文件夹为准）
 */
function QueuePrefsBar({
  canStart,
  canCancel,
  canClear,
  queuedCount,
  retryableCount,
  activeCount,
  totalCount,
  onStart,
  onCancel,
  onClear,
  onError,
}: {
  canStart: boolean;
  canCancel: boolean;
  canClear: boolean;
  queuedCount: number;
  retryableCount: number;
  activeCount: number;
  totalCount: number;
  onStart(): void;
  onCancel(): void;
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
  const startActions = [
    queuedCount > 0 ? `开始 ${queuedCount} 个排队任务` : "",
    retryableCount > 0 ? `重试 ${retryableCount} 个失败任务` : "",
  ]
    .filter(Boolean)
    .join("，");

  return (
    <div className="kd-download-prefs">
      <div className="kd-toolbar" data-slim="true">
        <Button
          variant="primary"
          size="sm"
          disabled={!canStart}
          title={canStart ? `${startActions}（下载 / 导出）` : "没有排队或可重试的任务"}
          onClick={onStart}
        >
          <Play size={12} />
          开始
        </Button>
        <button
          type="button"
          className="kd-text-action"
          disabled={!canCancel}
          title={canCancel ? `取消 ${activeCount} 个活动任务` : "没有活动任务"}
          onClick={onCancel}
        >
          <X size={12} />
          取消全部
        </button>
        <button
          type="button"
          className="kd-text-action"
          disabled={!canClear}
          title={
            canClear
              ? "清掉已完成、失败和已取消的记录"
              : "没有已结束的记录"
          }
          onClick={onClear}
        >
          <Trash2 size={12} />
          清空
        </button>

        <span
          className="kd-muted"
          style={{ fontSize: "var(--kd-size-xs)" }}
          title={`${activeCount} 个在下 / 队列共 ${totalCount} 个`}
        >
          {activeCount}/{totalCount}
        </span>

        <span className="kd-toolbar-gap" />

        <button
          type="button"
          className="kd-download-quality"
          title={`默认下载音质：${qualityLabel}。点击切换`}
          onClick={() =>
            void saveSettings({
              default_quality: qualities[(qualityIndex + 1 + qualities.length) % qualities.length],
            })
          }
        >
          {qualityLabel}
        </button>
        <button
          type="button"
          className="kd-download-quality"
          title={`默认视频画质上限：${heightLabel}。点击切换`}
          onClick={() => {
            const next =
              VIDEO_HEIGHTS[(heightIndex + 1 + VIDEO_HEIGHTS.length) % VIDEO_HEIGHTS.length] ?? 1080;
            void saveSettings({ video_max_height: next });
          }}
        >
          {heightLabel}
        </button>
      </div>

      <div className="kd-toolbar kd-download-prefs-dirs" data-slim="true">
        <button
          type="button"
          className="kd-save-dest"
          title={`打开默认下载文件夹：${downloadDir}`}
          disabled={!downloadDir}
          onClick={() => {
            if (!downloadDir) return;
            void window.kdj?.openPath(downloadDir).catch((error: unknown) =>
              onError(`打开下载文件夹失败：${(error as Error).message}`),
            );
          }}
        >
          <FolderOpen size={11} />
          <span className="kd-truncate">{downloadDir || "未设置"}</span>
        </button>
        <button
          type="button"
          className="kd-text-action"
          title="更改默认下载文件夹"
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
          更改
        </button>
      </div>
    </div>
  );
}

export function QueuePanel() {
  const list = useDownloadStore((store) => store.list);
  const activeCount = useDownloadStore((store) => store.activeCount);
  const clear = useDownloadStore((store) => store.clear);
  const cancelAll = useDownloadStore((store) => store.cancelAll);
  const [dropActive, setDropActive] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const folders = useLibraryStore((store) => store.folders);
  const setFilter = useLibraryStore((store) => store.setFilter);
  const setListMode = useAppStore((store) => store.setListMode);
  const finishedCount = list.length - activeCount;
  const queuedCount = list.reduce((sum, task) => sum + (task.state === "queued" ? 1 : 0), 0);
  const retryableCount = list.reduce(
    (sum, task) => sum + (task.state === "failed" && task.kind === "audio" ? 1 : 0),
    0,
  );
  const canClear = finishedCount > 0;
  /**
   * 「开始下载」同时放行当前队列并重试失败歌曲；以后新加的任务仍继续排队，
   * 不会因为点过一次「开始下载」就永久锁进自动下载模式。
   */
  const canStart = queuedCount > 0 || retryableCount > 0;
  /** 队列头上两个动作共用一条错误行：一次只按得动一个，堆两条只会把列表往下挤。 */
  const [actionError, setActionError] = useState("");

  const openTask = (task: DownloadTask) => {
    const path = task.path;
    // 没有曲库 id 说明它只是下到了默认视频目录，或入库失败。旧逻辑仍把应用
    // 筛选切到那个曲库外目录，得到一张空表，看起来就像文件消失；此时直接在
    // 系统文件管理器中定位成品才是可执行的答案。
    if (task.track_id == null) {
      void window.kdj?.revealPath(path).catch((error: unknown) =>
        setActionError(`定位下载文件失败：${(error as Error).message}`),
      );
      return;
    }
    const wanted = path.replaceAll("\\", "/").replace(/\/+$/, "");
    let best = "";
    const visit = (nodes: FolderNode[]) => {
      for (const node of nodes) {
        const folder = node.path.replaceAll("\\", "/").replace(/\/+$/, "");
        if (wanted === folder || wanted.startsWith(`${folder}/`)) {
          if (folder.length > best.length) best = node.path;
          visit(node.children);
        }
      }
    };
    visit(folders?.roots ?? []);
    setListMode("library");
    // 树刚启动尚未拉回来时，至少选文件所在的父目录；不能把文件本身
    // 当成 folder filter，否则中间列表会显示为空，看起来像下载丢了。
    const parent = path.replace(/[\\/][^\\/]*$/, "") || path;
    setFilter({ folder: best || parent, q: "" });
  };

  return (
    <div
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
        canCancel={activeCount > 0}
        canClear={canClear}
        queuedCount={queuedCount}
        retryableCount={retryableCount}
        activeCount={activeCount}
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
        onCancel={() => {
          setActionError("");
          void cancelAll().catch((error: unknown) =>
            setActionError(`取消全部失败：${(error as Error).message}`),
          );
        }}
        onClear={() => {
          setActionError("");
          void clear().catch((error: unknown) =>
            setActionError(`清空失败：${(error as Error).message}`),
          );
        }}
        onError={setActionError}
      />

      <InlineNotice text={actionError} onDismiss={() => setActionError("")} block />

      <div className="kd-scroll kd-grow" style={{ minHeight: 0 }}>
        {list.length === 0 ? (
          <EmptyState
            icon={<Inbox size={20} />}
            title="队列是空的"
            hint="把搜索结果拖进左边文件夹，或勾选后点「加入队列」。"
          />
        ) : (
          list.map((task) => (
            <QueueRow
              key={task.id}
              task={task}
              expanded={expandedId === task.id}
              onToggle={() => setExpandedId((current) => (current === task.id ? null : task.id))}
              onExpandId={setExpandedId}
              onOpenTask={openTask}
            />
          ))
        )}
      </div>
    </div>
  );
}
