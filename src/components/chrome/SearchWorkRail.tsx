import { LibrarySearchTools, WorkRailCollapse } from "./WorkRailControls";
import {
  ArrowLeft,
  Download,
  ListMusic,
  Search,
} from "lucide-react";
import type { ReactNode } from "react";
import type { IntakeItem, Platform, StreamPlaylist, VideoInfo } from "../../types";
import type { CollectionPageWindow } from "../../lib/searchCollections";
import { useDownloadStore } from "../../stores/downloadStore";
import { Button, InlineNotice } from "../common";
import { SEARCH_PLATFORMS } from "../download/SearchBar";
import { PlatformMark } from "../download/PlatformMark";
import { PickMark } from "../common/RowPick";
import { WorkRail, WorkRailSelection } from "./WorkRail";

const PLATFORM_ORDER = SEARCH_PLATFORMS.map((item) => item.id);
const PLATFORM_LABEL = Object.fromEntries(
  SEARCH_PLATFORMS.map((item) => [item.id, item.label]),
) as Record<Platform, string>;

const COLLECTION_LABEL = {
  playlist: "歌单",
  artist: "艺术家",
  album: "专辑",
  radio: "播客",
} as const;

function countSourcesByPlatform(items: IntakeItem[]): Partial<Record<Platform, number>> {
  const counts: Partial<Record<Platform, number>> = {};
  for (const item of items) {
    for (const group of item.groups) {
      const seen = new Set<Platform>();
      for (const source of group.sources) {
        if (seen.has(source.platform)) continue;
        seen.add(source.platform);
        counts[source.platform] = (counts[source.platform] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export interface SearchWorkRailProps {
  items: IntakeItem[];
  /** 唯一已打开的合集；非空时工作条切换为合集详情导航。 */
  collection: IntakeItem | null;
  /** Its `total` is the collection's size where the list holds only part of it (Bilibili). */
  collectionWindow?: CollectionPageWindow | null;
  /**
   * The online playlist / favourites folder opened from the sidebar. It is known before its
   * tracks are, so the strip names it while it loads, when it is empty and when it failed.
   */
  streamPlaylist?: StreamPlaylist | null;
  /** A pasted video link resolves to this one video instead of `items`. */
  video?: VideoInfo | null;
  canGoBack: boolean;
  onGoBack(): void;
  onDownloadCollection(): void;
  /** The search within the opened collection, and how many of its songs it keeps (null: none typed). */
  collectionFilter?: string;
  collectionMatches?: number | null;
  onCollectionFilterChange?(value: string): void;
  /** 查询仍在进行时，零条目不等于最终没有结果。 */
  loading: boolean;
  selectionCount: number;
  selecting: boolean;
  onSelectAll(): void;
  onClear(): void;
  onDone(): void;
  onAddToQueue(): void;
  queueError: string;
  onDismissQueueError(): void;
  chosenReady: boolean;
  /** 勾选里有视频来源时出现：批量下载只要音轨。 */
  showVideoAudioOnly?: boolean;
  videoAudioOnly?: boolean;
  onToggleVideoAudioOnly?(value: boolean): void;
  /** 本地面板不可见时，仍把右侧详情栏开关留在当前工作条。 */
  asideToggle?: ReactNode;
  onClose(): void;
  /** False while the online pane is hidden; see `WorkRail`. */
  shown?: boolean;
}

/** The platform's own mark, as the leading glyph of an online list. */
function platformGlyph(platform: Platform | null) {
  return (
    <span
      key={`platform:${platform ?? "none"}`}
      className="kd-collection-rail-platform"
      data-platform={platform ?? undefined}
      role={platform ? "img" : undefined}
      aria-label={platform ? PLATFORM_LABEL[platform] : undefined}
      aria-hidden={platform ? undefined : true}
      title={platform ? PLATFORM_LABEL[platform] : undefined}
    >
      {platform ? <PlatformMark id={platform} size={13} /> : <ListMusic size={13} strokeWidth={2.25} />}
    </span>
  );
}

/**
 * 搜索/下载半栏自己的工作条，和曲库工作条是同一条的两种情形：左端说清正在看的是什么
 * —— 哪个平台的哪个歌单 / 收藏夹 / 合集，或者哪一次搜索 —— 后面跟它的数量和动作
 * （全部下载）；多选与入队占本条。
 *
 * The name and its count are keyed by what is open, so another playlist turns them over; the
 * platform's mark stays while the platform does.
 */
export function SearchWorkRail({
  items,
  collection,
  collectionWindow,
  streamPlaylist = null,
  video = null,
  canGoBack,
  onGoBack,
  onDownloadCollection,
  collectionFilter = "",
  collectionMatches = null,
  onCollectionFilterChange,
  loading,
  selectionCount,
  selecting,
  onSelectAll,
  onClear,
  onDone,
  onAddToQueue,
  queueError,
  onDismissQueueError,
  chosenReady,
  showVideoAudioOnly = false,
  videoAudioOnly = false,
  onToggleVideoAudioOnly,
  asideToggle,
  onClose,
  shown = true,
}: SearchWorkRailProps) {
  const activeDownloads = useDownloadStore((state) => state.activeCount);
  const downloadList = useDownloadStore((state) => state.list);
  const running = downloadList.find((task) => task.state === "running");

  const glyphs: ReactNode[] = [];
  const texts: ReactNode[] = [];
  const collections = items.flatMap((item) => item.collections);

  if (selecting) {
    glyphs.push(
      <span key="sel" className="kd-activity-glyph kd-activity-glyph-sel" aria-hidden="true">
        <PickMark state="all" />
      </span>,
    );
    texts.push(
      <WorkRailSelection
        key="sel"
        count={selectionCount}
        onSelectAll={onSelectAll}
        onClear={onClear}
        onDone={onDone}
        actions={
          <>
            <InlineNotice text={queueError} onDismiss={onDismissQueueError} />
            {showVideoAudioOnly ? (
              <label className="kd-muted" style={{ cursor: "pointer", fontSize: "var(--kd-size-xs)" }}>
                <input
                  type="checkbox"
                  checked={videoAudioOnly}
                  onChange={(event) => onToggleVideoAudioOnly?.(event.target.checked)}
                  style={{ marginRight: 4 }}
                />
                视频只下音频
              </label>
            ) : null}
            <Button variant="primary" size="sm" disabled={!chosenReady} onClick={onAddToQueue}>
              <Download size={13} /> 加入队列
            </Button>
          </>
        }
      />,
    );
  } else {
    // An online folder is open: a resolved collection, or the sidebar's playlist while its
    // tracks are still on their way (or did not come).
    const opened = collection
      ? {
          id: collection.entry,
          platform: collection.platform,
          title: collection.title || collection.entry,
          kind: collection.kind,
          total: collectionWindow?.total
            ?? Math.max(collection.groups.length, streamPlaylist?.platform === "bilibili" ? streamPlaylist.count : 0),
        }
      : streamPlaylist
        ? {
            id: `${streamPlaylist.platform}:playlist:${streamPlaylist.key}`,
            platform: streamPlaylist.platform as Platform,
            title: streamPlaylist.title,
            kind: "playlist" as const,
            // The sidebar's number; a playlist that reports none is not counted before it has loaded.
            total: loading && streamPlaylist.count === 0 ? null : streamPlaylist.count,
          }
        : null;
    const named = items.filter((item) => item.groups.length > 0 || item.collections.length > 0);

    if (opened) {
      if (collection && canGoBack) {
        glyphs.push(
          <button
            key="collection-back"
            type="button"
            className="kd-collection-rail-back"
            data-kind={collection.kind}
            aria-label="返回合集搜索结果"
            title="返回合集搜索结果"
            onClick={onGoBack}
          >
            <ArrowLeft size={15} strokeWidth={2.15} aria-hidden="true" />
          </button>,
        );
      }
      glyphs.push(platformGlyph(opened.platform));
      const unit = opened.kind === "radio"
        ? "集"
        : opened.platform === "bilibili" || opened.platform === "youtube"
          ? "个视频"
          : "首";
      texts.push(
        <span
          key={`opened:${opened.id}`}
          className="kd-activity-text kd-collection-rail-title"
          title={opened.title}
        >
          {opened.title}
        </span>,
      );
      if (opened.total !== null) {
        texts.push(
          <span key={`opened-count:${opened.id}`} className="kd-collection-rail-count">
            {collectionMatches != null ? `${collectionMatches} / ` : ""}{opened.total} {unit}
          </span>,
        );
      }
      if (collection) {
        texts.push(
          <span
            key="opened-collection-download"
            className="kd-collection-rail-actions"
            data-kind={collection.kind}
          >
            <button
              type="button"
              className="kd-collection-rail-download"
              disabled={collection.groups.length === 0 || loading}
              aria-label={`全部下载「${opened.title}」`}
              title="全部下载"
              onClick={onDownloadCollection}
            >
              <Download size={13} strokeWidth={2.1} aria-hidden="true" />
              <span>全部下载</span>
            </button>
          </span>,
        );
      }
    } else if (named.length > 0) {
      // A search: what was asked, then what came back. One entry is named by its own text;
      // a batch by how many entries it has.
      const kinds = new Set(collections.map((item) => item.kind));
      const singleKind = kinds.size === 1 ? collections[0]!.kind : undefined;
      glyphs.push(
        collections.length > 0 ? (
          <span
            key="collections"
            className="kd-activity-glyph kd-collection-search-glyph"
            data-kind={singleKind}
            aria-hidden="true"
          >
            <ListMusic size={13} strokeWidth={2.25} />
          </span>
        ) : (
          <span key="search" className="kd-activity-glyph" aria-hidden="true">
            <Search size={13} strokeWidth={2.25} />
          </span>
        ),
      );
      const only = items.length === 1 ? items[0]! : null;
      const name = only ? only.title || only.entry : "批量搜索";
      texts.push(
        <span
          key={`search:${only ? only.entry : "batch"}`}
          className="kd-activity-text kd-collection-rail-title"
          title={name}
        >
          {name}
        </span>,
      );
      if (!only) {
        texts.push(
          <span key="search-count" className="kd-collection-rail-count">
            {items.length} 项
          </span>,
        );
      }
      if (collections.length > 0) {
        const kind = singleKind ? COLLECTION_LABEL[singleKind] : "集合";
        texts.push(
          <span key="collection-count" className="kd-collection-rail-count">
            {collections.length} 个{kind}
          </span>,
        );
      }
    } else if (video) {
      glyphs.push(platformGlyph(video.platform));
      texts.push(
        <span
          key={`video:${video.platform}:${video.bvid}`}
          className="kd-activity-text kd-collection-rail-title"
          title={video.title}
        >
          {video.title}
        </span>,
      );
    } else {
      glyphs.push(
        <span key="search" className="kd-activity-glyph" aria-hidden="true">
          <Search size={13} strokeWidth={2.25} />
        </span>,
      );
      texts.push(
        loading ? (
          <span key="searching" className="kd-activity-text">
            正在搜索
          </span>
        ) : (
          <span key="empty" className="kd-activity-text">
            没有搜到可下载的结果
          </span>
        ),
      );
    }

    // 合集详情的来源与总数已由标题旁的品牌图标和曲目数表达；不再重复一份
    // “网易云 60”之类的平台统计。候选列表和普通歌曲搜索才展示来源汇总。
    const counts = opened ? {} : countSourcesByPlatform(items);
    for (const id of PLATFORM_ORDER) {
      if (!counts[id]) continue;
      texts.push(
        <span
          key={id}
          className="kd-activity-plat"
          data-platform={id}
          title={`${PLATFORM_LABEL[id]} ${counts[id]}`}
          aria-label={`${PLATFORM_LABEL[id]} ${counts[id]} 条`}
        >
          <PlatformMark id={id} size={13} />
          <span className="kd-activity-plat-count">{counts[id]}</span>
        </span>,
      );
    }

    if (activeDownloads > 0) {
      texts.push(
        <span key="dl" className="kd-activity-text kd-rail-task">
          <span className="kd-activity-glyph kd-activity-glyph-dl" aria-hidden="true">
            <Download size={13} strokeWidth={2.25} />
          </span>
          <span>
            {running
              ? `下载中 · ${running.title || running.id}`
              : `队列进行中 ${activeDownloads} 项`}
          </span>
        </span>,
      );
    }
  }

  const idle = !selecting && !loading && activeDownloads === 0;

  return (
    <WorkRail
      idle={idle}
      glyphs={glyphs}
      texts={texts}
      trailing={
        collection && onCollectionFilterChange ? (
          <LibrarySearchTools
            key={`collection-search:${collection.entry}`}
            value={collectionFilter}
            folder=""
            selecting={selecting}
            placeholder={`在${COLLECTION_LABEL[collection.kind as keyof typeof COLLECTION_LABEL] ?? "列表"}中搜索`}
            onChange={onCollectionFilterChange}
          />
        ) : null
      }
      actions={
        <>
          <WorkRailCollapse label="收起在线结果" onClick={onClose} />
          {asideToggle}
        </>
      }
      label={
        selecting
          ? "搜索多选"
          : collection || streamPlaylist
            ? "在线列表"
            : loading
              ? "正在处理"
              : idle
                ? "搜索结果概况"
                : "下载任务"
      }
      shown={shown}
    />
  );
}
