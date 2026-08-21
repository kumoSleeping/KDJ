import { CheckSquare, Download, ListCollapse, ListMusic } from "lucide-react";
import type { ReactNode } from "react";
import type { IntakeItem, Platform } from "../../types";
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
  /** 勾选里有 B 站来源时才出现：批量下载只要音轨（m4a）。 */
  showBilibiliAudioOnly?: boolean;
  bilibiliAudioOnly?: boolean;
  onToggleBilibiliAudioOnly?(value: boolean): void;
  /** 本地面板不可见时，仍把右侧详情栏开关留在当前工作条。 */
  asideToggle?: ReactNode;
  onClose(): void;
}

/**
 * 搜索/下载半栏自己的工作条：空闲按平台汇总结果数；多选与入队占本条。
 */
export function SearchWorkRail({
  items,
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
  showBilibiliAudioOnly = false,
  bilibiliAudioOnly = false,
  onToggleBilibiliAudioOnly,
  asideToggle,
  onClose,
}: SearchWorkRailProps) {
  const activeDownloads = useDownloadStore((state) => state.activeCount);
  const downloadList = useDownloadStore((state) => state.list);
  const running = downloadList.find((task) => task.state === "running");

  const glyphs: ReactNode[] = [];
  const texts: ReactNode[] = [];

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
            {showBilibiliAudioOnly ? (
              <label className="kd-muted" style={{ cursor: "pointer", fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={bilibiliAudioOnly}
                  onChange={(event) => onToggleBilibiliAudioOnly?.(event.target.checked)}
                  style={{ marginRight: 4 }}
                />
                B站只下音频
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

    const openedCollection = items.find(
      (item) =>
        item.groups.length > 0 &&
        (item.kind === "playlist" || item.kind === "artist" || item.kind === "album"),
    );
    const collections = items.flatMap((item) => item.collections);
    if (openedCollection || collections.length > 0) {
      glyphs.push(
        <span key="collections" className="kd-activity-glyph" aria-hidden="true">
          <ListMusic size={13} strokeWidth={2.25} />
        </span>,
      );
      if (openedCollection) {
        texts.push(
          <span
            key="opened-collection"
            className="kd-activity-text kd-truncate"
            title={`${openedCollection.title} · ${openedCollection.groups.length} 首`}
          >
            {openedCollection.title} · {openedCollection.groups.length} 首
          </span>,
        );
      }
      if (collections.length > 0) {
        const kinds = new Set(collections.map((collection) => collection.kind));
        const kind = kinds.size === 1 ? COLLECTION_LABEL[collections[0]!.kind] : "集合";
        texts.push(
          <span key="collection-count" className="kd-activity-text">
            {collections.length} 个{kind}
          </span>,
        );
      }
    }

    const counts = countSourcesByPlatform(items);
    const rows = PLATFORM_ORDER.filter((id) => (counts[id] ?? 0) > 0);
    if (
      rows.length === 0 &&
      activeDownloads === 0 &&
      !loading &&
      !openedCollection &&
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
        selecting ? "搜索多选" : loading ? "正在处理" : idle ? "搜索结果概况" : "下载任务"
      }
    />
  );
}
