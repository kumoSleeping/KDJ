import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { api } from "../../lib/api";
import { copyText } from "../../lib/copyText";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import { rememberVideoEnqueue } from "../../lib/queueTaskDraft";
import { beginVideoPointerDrag } from "../../lib/searchDrag";
import { clearTextSelection } from "../../lib/textSelection";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { MergedGroup, VideoDownloadRequest, VideoInfo } from "../../types";
import { ContextMenu, InlineNotice } from "../common";
import { PlatformMark } from "./PlatformMark";
import { requestVideoPreview } from "./VideoPreview";
import { useTrackClickPrefs, playClickForLayout } from "../../lib/trackClickPrefs";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { CoverImage } from "../common/VinylPlaceholder";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @deprecated 请从 `lib/searchDrag` 引用；保留 re-export 以免旧 import 断掉。 */
export { VIDEO_DOWNLOAD_DND_TYPE } from "../../lib/searchDrag";

/**
 * 画出一行视频要的最少信息。
 *
 * 关键词搜出来的 B 站条目只有这些（`SongSource` 那条路不带分 P 和可用画质），
 * 贴链接解析出来的 `VideoInfo` 是它的超集，所以两条路共用同一个种子结构。
 */
export interface VideoSeed {
  platform: "bilibili" | "youtube";
  bvid: string;
  title: string;
  author: string;
  cover: string;
  duration: number | null;
}

/**
 * 整组来源都是同一种视频平台才按视频行展示。
 *
 * 混进了音乐平台的那种本质上是一首歌，视频只是它可选的下载来源之一；
 * 按视频铺开反而会把"同一首歌有几家可选、默认走哪家"这件事藏起来。
 */
export function isVideoGroup(group: MergedGroup): boolean {
  const platform = group.sources[0]?.platform;
  return (
    (platform === "bilibili" || platform === "youtube") &&
    group.sources.every((source) => source.platform === platform)
  );
}

export function videoSeedFromGroup(group: MergedGroup): VideoSeed {
  const source = group.sources[0];
  return {
    platform: source?.platform === "youtube" ? "youtube" : "bilibili",
    bvid: String(source?.payload?.bvid ?? source?.payload?.video_id ?? source?.key ?? ""),
    title: group.title,
    author: group.artists.join(", "),
    cover: group.cover,
    duration: group.duration,
  };
}

export function videoSeedFromInfo(info: VideoInfo): VideoSeed {
  return {
    platform: info.platform,
    bvid: info.bvid,
    title: info.title,
    author: info.author,
    cover: info.cover,
    duration: info.duration,
  };
}

/** 解析结果按平台 + 视频 ID 缓存。 */
const resolvedCache = new Map<string, VideoInfo>();

export interface VideoResultRowProps extends VideoSeed {
  /** 已经解析好的完整信息（贴链接那条路）。不给就等这行滚进视口自己去解析。 */
  info?: VideoInfo | null;
  /** 可见数据列（与 ResultTable / MergedGroupRow 同一套偏好）。 */
  columns: ReadonlyArray<{ key: string; align?: "num" }>;
  /** 整行单元格总数（勾选 + 动作 + 数据列），错误提示行用。 */
  totalColumns: number;
  /** 当前布局档位，决定单击/双击预览行为。 */
  layout: LayoutMode;
  /** 当前结果列表中的序号。 */
  rowNumber: number;
  /** 收藏夹/搜索返回的视频可进入与歌曲相同的全选和批量下载流程。 */
  selectable?: boolean;
  selected?: boolean;
  selectionMode?: boolean;
  onToggleSelect?(): void;
  onEnterSelection?(): void;
  /** 当前行位于现有选区内时，右键下载应交给整组选区入口。 */
  onDownloadSelected?(): void;
  /** @deprecated 保留兼容；请用 totalColumns。 */
  colSpan?: number;
}

/**
 * 搜索结果里的一条视频——外观对齐音频的 MergedGroupRow：
 * 封面 + 标题 / 艺人 / 时长 / 来源图标 / 下载自 / 音质，行首显示序号。
 * 分 P、画质、Offset 等细项挪到「下载队列」里逐条配置。
 */
export function VideoResultRow({
  platform,
  bvid,
  title,
  author,
  cover,
  duration,
  info: given,
  columns,
  totalColumns,
  layout,
  rowNumber,
  selectable = false,
  selected = false,
  selectionMode = false,
  onToggleSelect,
  onEnterSelection,
  onDownloadSelected,
}: VideoResultRowProps) {
  const settings = useAppStore((state) => state.settings);
  const openQueuePanel = useAppStore((state) => state.openQueuePanel);
  const mergeTasks = useDownloadStore((state) => state.mergeTasks);
  const { widePlay, narrowPlay } = useTrackClickPrefs();
  const playClick = playClickForLayout({ widePlay, narrowPlay }, layout);

  const cacheKey = `${platform}:${bvid}`;
  const [info, setInfo] = useState<VideoInfo | null>(given ?? resolvedCache.get(cacheKey) ?? null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => () => pointerDragCleanupRef.current?.(), []);

  const effectiveHeight = settings?.video_max_height ?? 1080;
  const qualityLabel = `${effectiveHeight}P`;

  useEffect(() => {
    if (info) return;
    const node = rowRef.current;
    if (!node) return;
    let alive = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void api
        .videoResolve(bvid, platform)
        .then((result) => {
          resolvedCache.set(cacheKey, result);
          if (alive) setInfo(result);
        })
        .catch(() => undefined);
    });
    observer.observe(node);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [bvid, cacheKey, info, platform]);

  const buildRequest = useCallback((): VideoDownloadRequest => {
    return {
      platform,
      bvid,
      page_index: 0,
      max_height: effectiveHeight,
      audio_only: false,
      transcode: settings?.video_transcode ?? false,
      title: title.trim() || undefined,
      artist: author.trim() || undefined,
      cover: cover.trim() || undefined,
    };
  }, [platform, bvid, effectiveHeight, settings?.video_transcode, title, author, cover]);

  const download = useCallback(async () => {
    setSending(true);
    setSendError("");
    try {
      const request = buildRequest();
      const task = await api.videoDownload(request);
      rememberVideoEnqueue(task.id, request);
      mergeTasks([
        {
          ...task,
          title: title.trim() || task.title,
          artist: author.trim() || task.artist,
          cover: cover.trim() || task.cover || undefined,
        },
      ]);
      openQueuePanel();
    } catch (error) {
      setSendError(`下载失败：${errorText(error)}`);
    } finally {
      setSending(false);
    }
  }, [buildRequest, title, author, cover, mergeTasks, openQueuePanel]);

  const bindPointerDrag = (event: React.PointerEvent) => {
    if (!bvid) return;
    pointerDragCleanupRef.current?.();
    pointerDragCleanupRef.current = beginVideoPointerDrag(
      event.nativeEvent,
      {
        platform,
        bvid,
        page_index: 0,
        max_height: effectiveHeight,
        audio_only: false,
        transcode: settings?.video_transcode ?? false,
      },
      { title, artist: author, cover },
      (error) => setSendError(`拖入失败：${errorText(error)}`),
      () => {
        suppressClickRef.current = true;
      },
    );
  };

  const cellDrag = {
    draggable: true as const,
    onDragStart: (event: React.DragEvent) => {
      // HTML5 drag 留给外层；WKWebView 里真正靠 pointer drag。
      event.preventDefault();
    },
  };

  return (
    <Fragment>
      <tr
        ref={rowRef}
        data-video="true"
        data-selecting={selectionMode ? "true" : undefined}
        aria-selected={selected}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          event.preventDefault();
          setRowMenu({ x: event.clientX, y: event.clientY });
        }}
        onDoubleClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (!bvid) return;
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          if (selectionMode) return;
          if (playClick === "double" && platform === "bilibili") {
            requestVideoPreview({ bvid, title, author, page: 0, cover });
          }
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          if (selectionMode) return;
          bindPointerDrag(event);
        }}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (!bvid) return;
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          if (selectable && (selectionMode || event.metaKey || event.ctrlKey)) {
            onToggleSelect?.();
            return;
          }
          if (selectionMode) return;
          // 窄屏单击即播，双点的第二个 click 必须吞掉，避免视频重新装载两次。
          if (playClick === "single" && event.detail > 1) return;
          if (playClick === "single" && platform === "bilibili") {
            requestVideoPreview({ bvid, title, author, page: 0, cover });
          }
        }}
        title={
          platform === "bilibili"
            ? playClick === "single"
              ? "单击预览视频；下载细项可在队列里调整"
              : "双击预览视频；下载细项可在队列里调整"
            : "YouTube Video；点下载后可在队列里选择音频或视频"
        }
      >
        <td
          className="kd-selection-cell"
          data-active={selectionMode ? "true" : undefined}
          {...cellDrag}
        >
          {selectionMode && selectable ? (
            <input
              type="checkbox"
              checked={selected}
              aria-label={`选择 ${title}`}
              onChange={() => onToggleSelect?.()}
              onClick={(event) => event.stopPropagation()}
            />
          ) : null}
        </td>
        <td className="kd-result-lead" data-col="index" {...cellDrag}>
          <span className="kd-result-index">{rowNumber}</span>
        </td>
        {columns.map((column) => {
          switch (column.key) {
            case "title":
              return (
                <td key={column.key} className="kd-td-strong" data-col="title" title={title} {...cellDrag}>
                  <span
                    className="kd-thumb"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      clearTextSelection();
                      bindPointerDrag(event);
                    }}
                  >
                    <CoverImage
                      src={cover ? thumbUrl(cover) : ""}
                      loading="lazy"
                      draggable={false}
                      referrerPolicy="no-referrer"
                    />
                  </span>
                  {title}
                </td>
              );
            case "artist":
              return (
                <td key={column.key} data-col="artist" title={author || undefined} {...cellDrag}>
                  {author || DASH}
                </td>
              );
            case "album":
              return (
                <td key={column.key} data-col="album" {...cellDrag}>
                  {DASH}
                </td>
              );
            case "duration":
              return (
                <td key={column.key} className="kd-td-num" data-col="duration" {...cellDrag}>
                  {formatDuration(duration ?? info?.duration ?? null)}
                </td>
              );
            case "sources":
              return (
                <td key={column.key} data-col="sources" {...cellDrag}>
                  <span className="kd-source-dots" title={platform === "youtube" ? "YouTube" : "B站"}>
                    <span className="kd-source-dot" data-platform={platform} data-active="true">
                      <PlatformMark id={platform} size={12} />
                    </span>
                  </span>
                </td>
              );
            case "from":
              return (
                <td key={column.key} className="kd-mono" data-col="from" {...cellDrag}>
                  {platform === "youtube" ? "YouTube" : "B站"}
                </td>
              );
            case "quality":
              return (
                <td key={column.key} className="kd-td-num kd-mono" data-col="quality" {...cellDrag}>
                  {qualityLabel}
                </td>
              );
            case "vip":
              return <td key={column.key} data-col="vip" style={{ width: "3rem" }} {...cellDrag} />;
            default:
              return <td key={column.key} {...cellDrag} />;
          }
        })}
      </tr>
      {sendError ? (
        <tr data-video="true">
          <td colSpan={totalColumns}>
            <InlineNotice text={sendError} onDismiss={() => setSendError("")} />
          </td>
        </tr>
      ) : null}
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
          <button
            type="button"
            disabled={sending || !bvid}
            onClick={() => {
              if (onDownloadSelected) onDownloadSelected();
              else void download();
              setRowMenu(null);
            }}
          >
            <Download size={12} />
            加入下载队列
          </button>
          <button
            type="button"
            onClick={() => {
              void copyText(title);
              setRowMenu(null);
            }}
          >
            <Copy size={12} />
            复制标题
          </button>
          {selectable ? (
            <button
              type="button"
              onClick={() => {
                onEnterSelection?.();
                if (!selected) onToggleSelect?.();
                setRowMenu(null);
              }}
            >
              <Check size={12} />
              选择
            </button>
          ) : null}
          {author ? (
            <button
              type="button"
              onClick={() => {
                void copyText(author);
                setRowMenu(null);
              }}
            >
              <Copy size={12} />
              复制 UP 主
            </button>
          ) : null}
          {bvid ? (
            <button
              type="button"
              onClick={() => {
                void copyText(bvid);
                setRowMenu(null);
              }}
            >
              <Copy size={12} />
              复制 BV 号
            </button>
          ) : null}
        </ContextMenu>
      )}
    </Fragment>
  );
}
