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
            onClick={() => void window.kdj?.revealPath(task.path)}
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

/** 「浏览…」不是一个目录，用不可能撞路径的值当哨兵。 */
const BROWSE_SENTINEL = "\0browse";

/**
 * 「保存到」的下拉：把能一键选到的目录全摆出来——系统下载（默认落点）、
 * 已加入曲库的文件夹、当前值——「浏览…」才去开目录选择器。
 * 这样浏览器预览壳（没有原生对话框，pickFolder 只能退化成手输路径）
 * 也有正经可选的项，手输只剩最后一条兜底路。
 */
function SaveDirSelect({
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
  const settings = useAppStore((store) => store.settings);
  const defaultDir = settings?.default_download_dir ?? "";
  const libraryDirs = settings?.library_dirs ?? [];

  // 当前值排最前（select 要有它才显示得对），去重后系统下载、曲库文件夹依次排开
  const seen = new Set<string>();
  const options: { dir: string; hint: string }[] = [];
  const add = (dir: string, hint: string) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    options.push({ dir, hint });
  };
  add(value, "");
  add(defaultDir, "系统下载");
  for (const dir of libraryDirs) add(dir, "曲库");

  return (
    <label className="kd-row" style={{ gap: "0.3rem" }} title={`${what}下载到 ${value}`}>
      {icon}
      <select
        className="kd-select"
        data-size="sm"
        style={{ maxWidth: "9rem" }}
        value={value}
        onChange={(event) => {
          const picked = event.target.value;
          if (picked === BROWSE_SENTINEL) {
            // select 的值不能停在「浏览…」上；用户取消选择时 value 没变，
            // React 受控组件会自己把显示拉回当前目录
            void window.kdj?.pickFolder().then((dir) => {
              if (dir) onChange(dir);
            });
            return;
          }
          onChange(picked);
        }}
      >
        {options.map(({ dir, hint }) => (
          <option key={dir} value={dir} title={dir}>
            {folderName(dir) || dir}
            {dir === defaultDir ? " · 系统下载" : hint ? ` · ${hint}` : ""}
          </option>
        ))}
        <option value={BROWSE_SENTINEL}>浏览…</option>
      </select>
    </label>
  );
}

/**
 * 保存目录就放在队列头上：任务往哪落、想换个地方落，都是在看队列时冒出来的念头。
 * 音乐和视频各一个下拉，选完存回设置。原来塞在搜索框上的那个目录按钮删了——
 * 搜索的时候人在想"找什么"，不是"存哪里"。
 */
function SaveDirRow() {
  const settings = useAppStore((store) => store.settings);
  const saveSettings = useAppStore((store) => store.saveSettings);
  if (!settings) return null;

  const save = (key: keyof Pick<Settings, "download_dir" | "video_download_dir">) => (dir: string) =>
    void saveSettings({ [key]: dir });

  return (
    <div className="kd-toolbar" data-slim="true">
      <span className="kd-faint" style={{ fontSize: "var(--kd-size-xs)" }}>
        保存到
      </span>
      <SaveDirSelect
        icon={<Music2 size={11} />}
        what="音乐"
        value={settings.download_dir}
        onChange={save("download_dir")}
      />
      <SaveDirSelect
        icon={<Clapperboard size={11} />}
        what="视频"
        value={settings.video_download_dir}
        onChange={save("video_download_dir")}
      />
      <span className="kd-toolbar-gap" />
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="在访达中打开音乐下载目录"
        title="在访达中打开音乐下载目录"
        onClick={() => void window.kdj?.revealPath(settings.download_dir)}
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
