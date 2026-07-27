import { useState } from "react";
import { Clapperboard, FolderOpen, Inbox, Music2, Play, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { DASH, folderName, formatBytes, formatPercent, formatSpeed } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { DownloadTask, FolderNode, Quality, Settings, SongSource, TaskState, VideoDownloadRequest } from "../../types";
import { Button, EmptyState, InlineNotice, ProgressBar } from "../common";
import { PLATFORM_LABEL, SEARCH_DOWNLOAD_DND_TYPE } from "./MergedGroupRow";
import { VIDEO_DOWNLOAD_DND_TYPE } from "./VideoResultRow";

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

function QueueRow({ task, onOpenFolder }: { task: DownloadTask; onOpenFolder(path: string): void }) {
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
            onClick={() => onOpenFolder(task.path)}
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

/** 保存目录是一个轻量路径按钮，不再渲染原生 select 和重复的下拉箭头。 */
function SaveDirButton({
  icon,
  what,
  value,
  onChange,
}: {
  icon: React.ReactNode;
  what: string;
  value: string;
  onChange: (dir: string) => void;
}) {
  return (
    <button
      type="button"
      className="kd-save-dest"
      title={`${what}下载到 ${value}；点击更换`}
      onClick={() => {
        void window.kdj?.pickFolder().then((dir) => {
          if (dir) onChange(dir);
        });
      }}
    >
      {icon}
      <span className="kd-truncate">{folderName(value) || value}</span>
    </button>
  );
}

/**
 * 保存目录就放在队列头上：任务往哪落、想换个地方落，都是在看队列时冒出来的念头。
 * 音乐和视频各一个下拉，选完存回设置。原来塞在搜索框上的那个目录按钮删了——
 * 搜索的时候人在想"找什么"，不是"存哪里"。
 */
function SaveDirRow({ onOpenFolder }: { onOpenFolder(path: string): void }) {
  const settings = useAppStore((store) => store.settings);
  const saveSettings = useAppStore((store) => store.saveSettings);
  if (!settings) return null;

  const save = (key: keyof Pick<Settings, "download_dir" | "video_download_dir">) => (dir: string) =>
    void saveSettings({ [key]: dir });
  const qualities: Quality[] = ["flac", "320", "128"];
  const quality = settings.default_quality;
  const qualityIndex = qualities.indexOf(quality);
  const qualityLabel = quality === "flac" ? "FLAC" : `${quality}K`;
  const sameDirectory = settings.download_dir === settings.video_download_dir;

  return (
    <div className="kd-toolbar kd-download-prefs" data-slim="true">
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
      {sameDirectory ? (
        <SaveDirButton
          icon={<span className="kd-row"><Music2 size={11} /><Clapperboard size={11} /></span>}
          what="音乐和视频"
          value={settings.download_dir}
          onChange={(dir) => void saveSettings({ download_dir: dir, video_download_dir: dir })}
        />
      ) : (
        <>
          <SaveDirButton
            icon={<Music2 size={11} />}
            what="音乐"
            value={settings.download_dir}
            onChange={save("download_dir")}
          />
          <SaveDirButton
            icon={<Clapperboard size={11} />}
            what="视频"
            value={settings.video_download_dir}
            onChange={save("video_download_dir")}
          />
        </>
      )}
      <span className="kd-toolbar-gap" />
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="在面板中打开音乐下载目录"
        title="在面板中打开音乐下载目录"
        onClick={() => onOpenFolder(settings.download_dir)}
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
  const enqueue = useDownloadStore((store) => store.enqueue);
  const mergeTasks = useDownloadStore((store) => store.mergeTasks);
  const settings = useAppStore((store) => store.settings);
  const [dropActive, setDropActive] = useState(false);
  const folders = useLibraryStore((store) => store.folders);
  const setFilter = useLibraryStore((store) => store.setFilter);
  const setQueueView = useLibraryStore((store) => store.setQueueView);
  const setListMode = useAppStore((store) => store.setListMode);
  const finishedCount = list.length - activeCount;
  const queuedCount = list.reduce((sum, task) => sum + (task.state === "queued" ? 1 : 0), 0);
  /**
   * 「开始下载」按得动的唯一情形：闸门关着，且真有人被它拦在外面。
   *
   * 后端用一次性 generation 放行点击前已经排队的任务；以后新加的任务继续排队，
   * 不会因为点过一次「开始下载」就永久锁进自动下载模式。
   */
  const canStart = queuedCount > 0;
  /** 队列头上两个动作共用一条错误行：一次只按得动一个，堆两条只会把列表往下挤。 */
  const [actionError, setActionError] = useState("");

  const openFolder = (path: string) => {
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
    setQueueView(false);
    // 树刚启动尚未拉回来时，至少选文件所在的父目录；不能把文件本身
    // 当成 folder filter，否则中间列表会显示为空，看起来像下载丢了。
    const parent = path.replace(/[\\/][^\\/]*$/, "") || path;
    setFilter({ folder: best || parent, q: "" });
  };

  return (
    <div
      className="kd-col kd-download-dropzone"
      data-drop-active={dropActive ? "true" : undefined}
      style={{ height: "100%", minHeight: 0 }}
      onDragOver={(event) => {
        const types = Array.from(event.dataTransfer.types);
        if (!types.includes(SEARCH_DOWNLOAD_DND_TYPE) && !types.includes(VIDEO_DOWNLOAD_DND_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        const videoRaw = event.dataTransfer.getData(VIDEO_DOWNLOAD_DND_TYPE);
        if (videoRaw) {
          event.preventDefault();
          try {
            const request = JSON.parse(videoRaw) as VideoDownloadRequest;
            void api
              .videoDownload(request)
              .then((task) => mergeTasks([task]))
              .catch((error: unknown) => setActionError(`加入视频队列失败：${(error as Error).message}`));
          } catch {
            setActionError("加入视频队列失败：拖动的数据无法识别");
          }
          return;
        }
        const raw = event.dataTransfer.getData(SEARCH_DOWNLOAD_DND_TYPE);
        if (!raw) return;
        event.preventDefault();
        try {
          const sources = JSON.parse(raw) as SongSource[];
          void enqueue(sources, { quality: settings?.default_quality ?? null }).catch(
            (error: unknown) => setActionError(`加入队列失败：${(error as Error).message}`),
          );
        } catch {
          setActionError("加入队列失败：拖动的数据无法识别");
        }
      }}
    >
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
              : "队列里没有排队中的任务"
          }
          onClick={() => {
            setActionError("");
            void (async () => {
              try {
                await api.startDownloads();
              } catch (error: unknown) {
                setActionError(`开始下载失败：${(error as Error).message}`);
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

      <SaveDirRow onOpenFolder={openFolder} />

      <div className="kd-scroll kd-grow" style={{ minHeight: 0 }}>
        {list.length === 0 ? (
          <EmptyState
            icon={<Inbox size={20} />}
            title="队列是空的"
            hint="在左边勾选歌曲，底部会出现「加入队列」。"
          />
        ) : (
          list.map((task) => <QueueRow key={task.id} task={task} onOpenFolder={openFolder} />)
        )}
      </div>
    </div>
  );
}
