import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download } from "lucide-react";
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
  bvid: string;
  title: string;
  author: string;
  cover: string;
  duration: number | null;
}

/**
 * 整组来源都是 B 站才当视频看。
 *
 * 混进了音乐平台的那种本质上是一首歌，B 站只是它可选的下载来源之一；
 * 按视频铺开反而会把"同一首歌有几家可选、默认走哪家"这件事藏起来。
 */
export function isVideoGroup(group: MergedGroup): boolean {
  return (
    group.sources.length > 0 && group.sources.every((source) => source.platform === "bilibili")
  );
}

export function videoSeedFromGroup(group: MergedGroup): VideoSeed {
  const source = group.sources[0];
  return {
    bvid: String(source?.payload?.bvid ?? source?.key ?? ""),
    title: group.title,
    author: group.artists.join(", "),
    cover: group.cover,
    duration: group.duration,
  };
}

export function videoSeedFromInfo(info: VideoInfo): VideoSeed {
  return {
    bvid: info.bvid,
    title: info.title,
    author: info.author,
    cover: info.cover,
    duration: info.duration,
  };
}

/** 解析结果按 bvid 缓存，避免滚回去又打一趟 B 站。 */
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
  /** @deprecated 保留兼容；请用 totalColumns。 */
  colSpan?: number;
}

/**
 * 搜索结果里的一条视频——外观对齐音频的 MergedGroupRow：
 * 封面 + 标题 / 艺人 / 时长 / 来源图标 / 下载自 / 音质，行首显示序号。
 * 分 P、画质、Offset 等细项挪到「下载队列」里逐条配置。
 */
export function VideoResultRow({
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
}: VideoResultRowProps) {
  const settings = useAppStore((state) => state.settings);
  const openQueuePanel = useAppStore((state) => state.openQueuePanel);
  const mergeTasks = useDownloadStore((state) => state.mergeTasks);
  const { widePlay, narrowPlay } = useTrackClickPrefs();
  const playClick = playClickForLayout({ widePlay, narrowPlay }, layout);

  const [info, setInfo] = useState<VideoInfo | null>(given ?? resolvedCache.get(bvid) ?? null);
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
        .videoResolve(bvid)
        .then((result) => {
          resolvedCache.set(bvid, result);
          if (alive) setInfo(result);
        })
        .catch(() => undefined);
    });
    observer.observe(node);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [bvid, info]);

  const buildRequest = useCallback((): VideoDownloadRequest => {
    return {
      bvid,
      page_index: 0,
      max_height: effectiveHeight,
      audio_only: false,
      transcode: true,
      title: title.trim() || undefined,
      artist: author.trim() || undefined,
      cover: cover.trim() || undefined,
    };
  }, [bvid, effectiveHeight, title, author, cover]);

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
        bvid,
        page_index: 0,
        max_height: effectiveHeight,
        audio_only: false,
        transcode: true,
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
          if (playClick === "double") requestVideoPreview({ bvid, title, author, page: 0, cover });
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          bindPointerDrag(event);
        }}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (!bvid) return;
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          // 窄屏单击即播，双点的第二个 click 必须吞掉，避免视频重新装载两次。
          if (playClick === "single" && event.detail > 1) return;
          if (playClick === "single") requestVideoPreview({ bvid, title, author, page: 0, cover });
        }}
        title={
          playClick === "single"
            ? "单击预览视频；点下载加入队列后可在队列里调分 P / 画质 / Offset"
            : "双击预览视频；点下载加入队列后可在队列里调分 P / 画质 / Offset"
        }
      >
        <td className="kd-selection-cell" {...cellDrag} />
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
                  <span className="kd-source-dots" title="B站">
                    <span className="kd-source-dot" data-platform="bilibili" data-active="true">
                      <PlatformMark id="bilibili" size={12} />
                    </span>
                  </span>
                </td>
              );
            case "from":
              return (
                <td key={column.key} className="kd-mono" data-col="from" {...cellDrag}>
                  B站
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
              void download();
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
