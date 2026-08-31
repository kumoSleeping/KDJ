import {
  ArrowLeft,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Download,
  ListCollapse,
  ListMusic,
} from "lucide-react";
import type { ReactNode } from "react";
import type { IntakeItem, Platform } from "../../types";
import type { CollectionPageWindow } from "../../lib/searchCollections";
import { useDownloadStore } from "../../stores/downloadStore";
import { Button, InlineNotice } from "../common";
import { SEARCH_PLATFORMS } from "../download/SearchBar";
import { PlatformMark } from "../download/PlatformMark";
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
  collectionWindow: CollectionPageWindow | null;
  canGoBack: boolean;
  onGoBack(): void;
  onCollectionPageChange(page: number): void;
  onDownloadCollection(): void;
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
}

/**
 * 搜索/下载半栏自己的工作条：空闲按平台汇总结果数；多选与入队占本条。
 */
export function SearchWorkRail({
  items,
  collection,
  collectionWindow,
  canGoBack,
  onGoBack,
  onCollectionPageChange,
  onDownloadCollection,
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
        <CheckSquare size={13} strokeWidth={2.25} />
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
              <label className="kd-muted" style={{ cursor: "pointer", fontSize: 11 }}>
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
    if (collection) {
      if (canGoBack) {
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
      glyphs.push(
        <span
          key="collection-platform"
          className="kd-collection-rail-platform"
          data-platform={collection.platform ?? undefined}
          title={collection.platform ? PLATFORM_LABEL[collection.platform] : undefined}
          aria-hidden="true"
        >
          {collection.platform ? (
            <PlatformMark id={collection.platform} size={13} />
          ) : (
            <ListMusic size={13} strokeWidth={2.25} />
          )}
        </span>,
      );
      const unit = collection.kind === "radio"
        ? "集"
        : collection.platform === "bilibili" || collection.platform === "youtube"
          ? "个视频"
          : "首";
      texts.push(
        <span
          key="opened-collection"
          className="kd-activity-text kd-collection-rail-title"
          title={collection.title || collection.entry}
        >
          {collection.title || collection.entry}
        </span>,
        <span key="opened-collection-count" className="kd-collection-rail-count">
          {collectionWindow?.total ?? collection.groups.length} {unit}
        </span>,
        <span
          key="opened-collection-download"
          className="kd-collection-rail-actions"
          data-kind={collection.kind}
        >
          <button
            type="button"
            className="kd-collection-rail-download"
            disabled={collection.groups.length === 0}
            aria-label={`全部下载「${collection.title || collection.entry}」`}
            title="全部下载"
            onClick={onDownloadCollection}
          >
            <Download size={13} strokeWidth={2.1} aria-hidden="true" />
            <span>全部下载</span>
          </button>
        </span>,
      );
    }

    if (activeDownloads > 0) {
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

    if (!collection && collections.length > 0) {
      const kinds = new Set(collections.map((item) => item.kind));
      const singleKind = kinds.size === 1 ? collections[0]!.kind : undefined;
      glyphs.push(
        <span
          key="collections"
          className="kd-activity-glyph kd-collection-search-glyph"
          data-kind={singleKind}
          aria-hidden="true"
        >
          <ListMusic size={13} strokeWidth={2.25} />
        </span>,
      );
      const kind = singleKind ? COLLECTION_LABEL[singleKind] : "集合";
      texts.push(
        <span key="collection-count" className="kd-activity-text">
          {collections.length} 个{kind}
        </span>,
      );
    }

    // 合集详情的来源与总数已由标题旁的品牌图标和曲目数表达；不再重复一份
    // “网易云 60”之类的平台统计。候选列表和普通歌曲搜索才展示来源汇总。
    const counts = collection ? {} : countSourcesByPlatform(items);
    const rows = PLATFORM_ORDER.filter((id) => (counts[id] ?? 0) > 0);
    if (
      rows.length === 0 &&
      activeDownloads === 0 &&
      !loading &&
      !collection &&
      collections.length === 0
    ) {
      glyphs.push(
        <span key="empty" className="kd-activity-glyph" aria-hidden="true">
          <Download size={13} strokeWidth={2.25} />
        </span>,
      );
      texts.push(
        <span key="empty" className="kd-activity-text">
          没有搜到可下载的结果
        </span>,
      );
    } else {
      for (const id of rows) {
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
    }
  }

  const idle = !selecting && !loading && activeDownloads === 0;

  return (
    <WorkRail
      idle={idle}
      glyphs={glyphs}
      texts={texts}
      actions={
        <>
          {!selecting && collection && collectionWindow && collectionWindow.pageCount > 1 ? (
            <span className="kd-collection-rail-actions" data-kind={collection.kind}>
              <span
                className="kd-collection-rail-pagination"
                aria-label={`第 ${collectionWindow.page} 页，共 ${collectionWindow.pageCount} 页`}
              >
                <button
                  type="button"
                  disabled={loading || collectionWindow.page <= 1}
                  aria-label="上一页"
                  title="上一页"
                  onClick={() => onCollectionPageChange(collectionWindow.page - 1)}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span>{collectionWindow.page} / {collectionWindow.pageCount}</span>
                <button
                  type="button"
                  disabled={loading || collectionWindow.page >= collectionWindow.pageCount}
                  aria-label="下一页"
                  title="下一页"
                  onClick={() => onCollectionPageChange(collectionWindow.page + 1)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </span>
            </span>
          ) : null}
          <button
            type="button"
            className="kd-chrome-btn"
            data-action="dismiss-results"
            aria-label="收起在线结果"
            title="收起在线结果"
            onClick={onClose}
          >
            <ListCollapse size={15} strokeWidth={2.15} />
          </button>
          {asideToggle}
        </>
      }
      label={
        selecting
          ? "搜索多选"
          : collection
            ? "合集详情"
            : loading
              ? "正在处理"
              : idle
                ? "搜索结果概况"
                : "下载任务"
      }
    />
  );
}
