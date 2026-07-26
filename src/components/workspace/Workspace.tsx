import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, MousePointerClick, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { formatBytes, formatDuration } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import {
  selectSelectedTrack,
  useLibraryStore,
  type TrackSort,
} from "../../stores/libraryStore";
import type { IntakeItem, Platform, Quality, SongSource } from "../../types";
import { Button, EmptyState } from "../common";
import { QueuePanel } from "../download/QueuePanel";
import { ResultTable, selectionKey } from "../download/ResultTable";
import { DEFAULT_PRIORITY, SearchBar, SearchPlatforms } from "../download/SearchBar";
import { FolderTree } from "../library/FolderTree";
import { AccountsPanel } from "../settings/AccountsPanel";
import { LibraryToolbar } from "../library/LibraryToolbar";
import { TrackDetail } from "../library/TrackDetail";
import { TrackTable } from "../library/TrackTable";
import { VideoPanel } from "../video/VideoPanel";

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * B 站输入的识别。音乐/视频不再是手动切的开关：
 * 贴的是 B 站链接或 BV 号，那就是要下视频，没有第二种解释。
 */
const BILI_RE = /bilibili\.com|b23\.tv|^\s*(?:BV[0-9A-Za-z]{10}|av\d+)\s*$/i;

/**
 * 唯一的工作台。没有"下载板块"和"曲库板块"之分。
 *
 * 平时它就是曲库：左边文件夹、中间曲目、右边详情。
 * 顶上那条大搜索框是"去网上搜歌来下"——一旦搜出结果，
 * 中间换成候选列表、右边换成下载队列，下完再关掉结果回到曲库。
 *
 * 这么排的理由：找歌 → 下载 → 进曲库 → 排 set 本来就是一条线上的动作，
 * 拆成两个并列板块之后，每做一步都要先想"我现在该在哪个板块"。
 */
export function Workspace() {
  const settings = useAppStore((state) => state.settings);
  const pushToast = useAppStore((state) => state.pushToast);
  const listMode = useAppStore((state) => state.listMode);
  const hasResults = useAppStore((state) => state.hasResults);
  const setListMode = useAppStore((state) => state.setListMode);
  const setHasResults = useAppStore((state) => state.setHasResults);
  const showAccounts = useAppStore((state) => state.showAccounts);
  const toggleAccounts = useAppStore((state) => state.toggleAccounts);
  const enqueue = useDownloadStore((state) => state.enqueue);

  const tracks = useLibraryStore((state) => state.tracks);
  const total = useLibraryStore((state) => state.total);
  const loading = useLibraryStore((state) => state.loading);
  const libError = useLibraryStore((state) => state.error);
  const filter = useLibraryStore((state) => state.filter);
  const selectedId = useLibraryStore((state) => state.selectedId);
  const selectedIds = useLibraryStore((state) => state.selectedIds);
  const selected = useLibraryStore(selectSelectedTrack);
  const stats = useLibraryStore((state) => state.stats);
  const loadMore = useLibraryStore((state) => state.loadMore);
  const select = useLibraryStore((state) => state.select);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const refreshStats = useLibraryStore((state) => state.refreshStats);
  const refresh = useLibraryStore((state) => state.refresh);

  // 首次进来拉一次曲库；之后的刷新由筛选变化和 WS 事件驱动
  useEffect(() => {
    if (useLibraryStore.getState().tracks.length === 0) void refresh();
  }, [refresh]);

  const [query, setQuery] = useState("");
  const [platforms, setPlatforms] = useState<Platform[]>(["wyy", "qqm"]);
  const [merge, setMerge] = useState(true);
  const [quality, setQuality] = useState<Quality | "">("");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<IntakeItem[] | null>(null);
  const [note, setNote] = useState("");

  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [collapsedItems, setCollapsedItems] = useState<Set<number>>(new Set());
  const [sourceIndex, setSourceIndex] = useState<Record<string, number>>({});

  /**
   * 批量与否不再是一个要手动按的开关：贴进来的内容有换行、或一口气贴了
   * 好几条链接，那就是批量，没有第二种解释。SearchBar 在粘贴时会保住换行。
   */
  const batch = useMemo(
    () => query.includes("\n") || (query.match(/https?:\/\//gi)?.length ?? 0) > 1,
    [query],
  );

  const togglePlatform = useCallback((platform: Platform) => {
    setPlatforms((current) =>
      current.includes(platform)
        ? current.filter((item) => item !== platform)
        : [...current, platform],
    );
  }, []);

  /** 丢掉搜索结果，回到曲库标签。 */
  const closeResults = useCallback(() => {
    setItems(null);
    setNote("");
    setChosen(new Set());
    useAppStore.getState().setHasResults(false);
  }, []);

  const submit = useCallback(async () => {
    const text = query.trim();
    if (!text) return;

    // B 站链接/BV 号 → 切到常驻的「视频」标签解析。
    if (BILI_RE.test(text)) {
      useAppStore.getState().setListMode("video");
      // VideoPanel 沿 busy 的上升沿触发解析，解析进度它自己管
      setBusy(true);
      setTimeout(() => setBusy(false), 80);
      return;
    }

    setBusy(true);
    setChosen(new Set());
    setExpandedGroups(new Set());
    setCollapsedItems(new Set());
    setSourceIndex({});
    // 平台顺序 = 拖出来的优先级，决定同一首歌默认从哪家下。
    // 哔哩哔哩也参与关键词搜索。视频就是视频：下载保留完整视频文件，
    // 只在播放时取音轨（曲库对视频文件的统一行为）。
    const priority = settings?.platform_priority ?? (DEFAULT_PRIORITY as string[]);
    const orderedPlatforms = [...platforms].sort(
      (a, b) => priority.indexOf(a) - priority.indexOf(b),
    );
    try {
      // 单条也走 /intake：关键词、单曲链接、歌单链接是同一条路径，
      // 前端不必自己判断哪种输入该打哪个接口。
      const response = await api.intake({
        text,
        platforms: orderedPlatforms,
        limit: 30,
        merge,
        max_entries: batch ? 50 : 1,
      });
      setItems(response.items);
      setHasResults(true);
      const found = response.items.reduce((sum, item) => sum + item.groups.length, 0);
      setNote(
        `${response.items.length} 条输入 · ${found} 首` +
          (response.skipped > 0 ? ` · 超出上限丢弃 ${response.skipped} 条` : "") +
          ` · ${Math.round(response.elapsed_ms)} ms`,
      );
    } catch (error) {
      setItems([]);
      setHasResults(true);
      setNote("");
      pushToast("error", `处理失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }, [query, platforms, merge, batch, settings, pushToast, setHasResults]);

  const toggleSelect = useCallback((key: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  }, []);

  const toggleItem = useCallback((index: number) => {
    setCollapsedItems((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }, []);

  /** 勾选整个「包」：全选中就全清，否则补齐——和文件管理器里点父目录一个手感。 */
  const toggleItemAll = useCallback(
    (index: number) => {
      const item = items?.[index];
      if (!item) return;
      const keys = item.groups.map((group) => selectionKey(index, group.group_id));
      setChosen((current) => {
        const next = new Set(current);
        const allIn = keys.every((key) => next.has(key));
        for (const key of keys) {
          if (allIn) next.delete(key);
          else next.add(key);
        }
        return next;
      });
    },
    [items],
  );

  const pickSource = useCallback((groupId: string, index: number) => {
    setSourceIndex((current) => ({ ...current, [groupId]: index }));
  }, []);

  const toggleAll = useCallback(() => {
    const allKeys = (items ?? []).flatMap((item, index) =>
      item.groups.map((group) => selectionKey(index, group.group_id)),
    );
    setChosen((current) => (current.size >= allKeys.length ? new Set() : new Set(allKeys)));
  }, [items]);

  const resultCount = useMemo(
    () => (items ?? []).reduce((sum, item) => sum + item.groups.length, 0),
    [items],
  );

  const chosenSources = useMemo(() => {
    const picked: SongSource[] = [];
    const seen = new Set<string>();
    (items ?? []).forEach((item, index) => {
      for (const group of item.groups) {
        if (!chosen.has(selectionKey(index, group.group_id))) continue;
        const pickedIndex = sourceIndex[group.group_id] ?? group.best_source_index;
        const source = group.sources[pickedIndex] ?? group.sources[0];
        if (!source) continue;
        // 批量时同一首歌可能被多条关键词搜到，去重后再入队，免得下两遍
        const key = `${source.platform}:${source.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(source);
      }
    });
    return picked;
  }, [items, chosen, sourceIndex]);

  const addToQueue = useCallback(async () => {
    if (chosenSources.length === 0) return;
    try {
      const tasks = await enqueue(chosenSources, { quality: quality === "" ? null : quality });
      pushToast("info", `已加入 ${tasks.length} 个下载任务`);
      setChosen(new Set());
      void refreshStats();
    } catch (error) {
      pushToast("error", `加入队列失败：${errorText(error)}`);
    }
  }, [chosenSources, quality, enqueue, pushToast, refreshStats]);

  /**
   * 本地列表里拖动换位：把整个文件夹的曲目顺序写回它的 .kumodeck.json。
   * 先按当前排序取全量（分页外的也要参与），再把拖动的块插到目标位置。
   */
  const reorderTracks = useCallback(
    async (ids: number[], targetId: number, before: boolean) => {
      const folder = filter.folder;
      if (!folder) return;
      try {
        const page = await api.tracks({
          folder,
          sort: filter.sort,
          order: filter.order,
          limit: 2000,
          offset: 0,
        });
        const all = page.items;
        const moved = all.filter((t) => ids.includes(t.id));
        const rest = all.filter((t) => !ids.includes(t.id));
        const targetIndex = rest.findIndex((t) => t.id === targetId);
        if (moved.length === 0 || targetIndex < 0) return;
        const insertAt = before ? targetIndex : targetIndex + 1;
        const names = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)].map(
          (t) => t.filename,
        );
        await api.orderFolder(folder, names);
        // 手排完立刻按手排顺序看；setFilter 的防抖会触发 refresh
        setFilter({ sort: "custom" });
      } catch (error) {
        pushToast("error", `排序失败：${errorText(error)}`);
      }
    },
    [filter.folder, filter.sort, filter.order, setFilter, pushToast],
  );

  const libraryNote =
    `${tracks.length} / ${total} 首` +
    (selectedIds.length > 1 ? ` · 选中 ${selectedIds.length}` : "") +
    (stats
      ? ` · 已分析 ${stats.analyzed} · ${formatDuration(stats.total_duration)} · ${formatBytes(stats.total_size)}`
      : "");

  const sortBy = (column: TrackSort) => {
    // 点同一列切升降序，点新列默认降序（新加入、BPM 高的先看）
    setFilter(
      filter.sort === column
        ? { order: filter.order === "asc" ? "desc" : "asc" }
        : { sort: column, order: "desc" },
    );
  };

  return (
    <section className="kd-section">
      {/* —— 顶上永远是那条"搜歌来下"的大搜索框 —— */}
      <SearchBar
        query={query}
        onQueryChange={setQuery}
        batch={batch}
        busy={busy}
        onSubmit={() => void submit()}
        quality={quality}
        onQualityChange={setQuality}
        defaultQuality={settings?.default_quality ?? "flac"}
      />
      {/* 平台行永远在：搜完视频接着搜音乐是常见动作，
          这一行忽隐忽现会让整个头部跳来跳去。 */}
      <SearchPlatforms
        platforms={platforms}
        onTogglePlatform={togglePlatform}
        merge={merge}
        onMergeChange={setMerge}
        soundcloudEnabled={settings?.soundcloud_enabled ?? false}
      />

      <div className="kd-section-body">
        <div className="kd-split" data-folders="true">
          {/* 文件夹栏一直在：搜到的歌下载完就落进这些文件夹，看得见落点才知道下到哪了 */}
          <FolderTree />

          <div className="kd-table-wrap">
            {/* 列表面板的"眉目"：三个标签常驻，随时可切，不等搜索了才出现。
                激活态只是中性底色，不跟真正的动作按钮抢红色。 */}
            <div className="kd-list-head">
              <nav className="kd-list-tabs" aria-label="列表内容">
                <button
                  type="button"
                  aria-pressed={listMode === "library"}
                  onClick={() => setListMode("library")}
                >
                  曲库
                </button>
                <button
                  type="button"
                  aria-pressed={listMode === "search"}
                  onClick={() => setListMode("search")}
                >
                  搜索{resultCount > 0 && ` ${resultCount}`}
                </button>
                <button
                  type="button"
                  aria-pressed={listMode === "video"}
                  onClick={() => setListMode("video")}
                >
                  视频
                </button>
              </nav>
              <span className="kd-list-note kd-truncate">
                {listMode === "library" ? libraryNote : listMode === "search" ? note : ""}
              </span>
              <span className="kd-toolbar-gap" />
              {hasResults && listMode === "search" && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="丢掉搜索结果"
                  title="丢掉搜索结果"
                  onClick={closeResults}
                >
                  <X size={12} />
                </Button>
              )}
              {/* 「登录」贴最右：切的是右栏（账号面板），不是中间列表 */}
              <nav className="kd-list-tabs" aria-label="账号">
                <button type="button" aria-pressed={showAccounts} onClick={toggleAccounts}>
                  登录
                </button>
              </nav>
            </div>

            {/* 曲库的筛选条在面板**内部**：放在外面的话，切标签时它一出一没，
                整个中间区域会跳高度。 */}
            {listMode === "library" && <LibraryToolbar />}
            {listMode === "library" && libError && (
              <div className="kd-toolbar" style={{ color: "var(--kd-danger)" }}>
                {libError}
              </div>
            )}

            {listMode === "video" ? (
              <VideoPanel query={query} busy={busy} />
            ) : listMode === "search" ? (
              <div className="kd-scroll">
                <ResultTable
                  items={items ?? []}
                  loading={busy}
                  searched={hasResults}
                  selected={chosen}
                  expandedGroups={expandedGroups}
                  collapsedItems={collapsedItems}
                  sourceIndex={sourceIndex}
                  onToggleSelect={toggleSelect}
                  onToggleExpand={toggleExpand}
                  onPickSource={pickSource}
                  onToggleItem={toggleItem}
                  onToggleItemAll={toggleItemAll}
                  onToggleAll={toggleAll}
                />
              </div>
            ) : (
              <TrackTable
                tracks={tracks}
                loading={loading}
                selectedId={selectedId}
                selectedIds={selectedIds}
                sort={filter.sort}
                order={filter.order}
                onSelect={select}
                onSort={sortBy}
                onScrollEnd={() => void loadMore()}
                reorderable={Boolean(filter.folder) && !filter.folderDeep}
                onReorder={(ids, targetId, before) => void reorderTracks(ids, targetId, before)}
              />
            )}

            {/* 勾了歌才浮出来的动作条：整个面板唯一的红色按钮只在
                "已经有可入队的东西"这一刻出现，平时不占地方也不抢眼。 */}
            {listMode === "search" && chosenSources.length > 0 && (
              <div className="kd-picked-bar">
                <span className="kd-muted">已选 {chosenSources.length} 首</span>
                <Button variant="ghost" size="sm" onClick={() => setChosen(new Set())}>
                  清除
                </Button>
                <span className="kd-toolbar-gap" />
                <Button variant="primary" onClick={() => void addToQueue()}>
                  <Download size={13} />
                  加入队列
                </Button>
              </div>
            )}
          </div>

          {/* 右栏：齿轮呼出的登录面板优先，其次搜索/视频时是下载队列，曲库时是曲目详情 */}
          <aside className="kd-split-aside kd-scroll">
            {showAccounts ? (
              <AccountsPanel />
            ) : listMode !== "library" ? (
              <QueuePanel />
            ) : selected ? (
              <TrackDetail key={selected.id} track={selected} />
            ) : (
              <EmptyState
                icon={<MousePointerClick size={20} />}
                title="选一首看详情"
                hint="分析过的曲目会显示 BPM、调号轮，以及能接上的下一首。"
              />
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}
