import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FolderTree as FolderTree_Icon,
  MousePointerClick,
  PanelRight,
  X,
} from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { formatBytes, formatDuration } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useNarrow } from "../../lib/useNarrow";
import {
  selectSelectedTrack,
  useLibraryStore,
  type TrackSort,
} from "../../stores/libraryStore";
import type { IntakeItem, Platform, Quality, SongSource, VideoInfo } from "../../types";
import { Button, EmptyState, InlineNotice, Sheet } from "../common";
import { QueuePanel } from "../download/QueuePanel";
import { ResultTable, selectableGroups, selectionKey } from "../download/ResultTable";
import { DEFAULT_PRIORITY, SearchBar, SearchPlatforms } from "../download/SearchBar";
import { FolderTree } from "../library/FolderTree";
import { AccountsPanel } from "../settings/AccountsPanel";
import { LibraryToolbar } from "../library/LibraryToolbar";
import { TrackDetail } from "../library/TrackDetail";
import { TrackTable } from "../library/TrackTable";

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * B 站输入的识别。音乐/视频不再是手动切的开关：
 * 贴的是 B 站链接或 BV 号，那就是要下视频，没有第二种解释。
 * 结果照样落在「搜索」标签里，只是那一条长得像视频（见 VideoResultRow）。
 */
const BILI_RE = /bilibili\.com|b23\.tv|^\s*(?:BV[0-9A-Za-z]{10}|av\d+)\s*$/i;

/** 「搜VJ(Bili)」从详情面板发过来：query 已经拼好（曲名 + 关键词）。 */
export const VJ_SEARCH_EVENT = "kd:vj-search";

export function requestVjSearch(query: string): void {
  window.dispatchEvent(new CustomEvent<string>(VJ_SEARCH_EVENT, { detail: query }));
}

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
  // 跨平台去重恒为开，开关已删：不合并的话搜一次出四条一模一样的结果，
  // 没有人会想要那个。留常量而不是把 true 写进调用点，是为了让
  // `/intake` 那个字段的语义在这里仍然看得见。
  const merge = true;
  const [quality, setQuality] = useState<Quality | "">("");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<IntakeItem[] | null>(null);
  /** 贴链接解析出来的那一个视频，置顶在结果列表最前面；关键词搜索会把它顶掉。 */
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [note, setNote] = useState("");
  /**
   * 三处失败各有各的现场，所以分成三条，不合并成一个全局的错误：
   * 搜索失败要顶在结果列表的摘要位、入队失败要贴在「加入队列」旁边、
   * 拖动排序失败要出现在曲目表上方。合成一条就总有两处放错地方。
   */
  const [searchError, setSearchError] = useState("");
  const [queueError, setQueueError] = useState("");
  const [reorderError, setReorderError] = useState("");

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
    setVideo(null);
    setNote("");
    setSearchError("");
    setQueueError("");
    setChosen(new Set());
    useAppStore.getState().setHasResults(false);
  }, []);

  const submit = useCallback(async () => {
    const text = query.trim();
    if (!text) return;

    // B 站链接/BV 号 → 解析成一条视频结果，和搜索结果同在「搜索」标签里。
    // 解析要往 B 站跑一趟，所以先切标签再等结果：不然按下回车后有一两秒
    // 界面上什么都不变，像是没接住这次输入。
    if (BILI_RE.test(text)) {
      setBusy(true);
      setSearchError("");
      setItems(null);
      setChosen(new Set());
      setHasResults(true);
      try {
        const info = await api.videoResolve(text);
        setVideo(info);
        setNote("1 个视频");
      } catch (error) {
        setVideo(null);
        setNote("");
        setSearchError(`解析失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    setVideo(null);
    setChosen(new Set());
    setExpandedGroups(new Set());
    setCollapsedItems(new Set());
    setSourceIndex({});
    setSearchError("");
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
      // 结果列表这时是空的，那条摘要位就腾出来写原因——
      // 另起一行会把列表顶下去，切来切去整块面板都在跳
      setSearchError(`处理失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
    // merge 是常量，不进依赖
  }, [query, platforms, batch, settings, setHasResults]);

  /* ------------------------------------------------------------ 窄屏 / 竖屏 */
  const narrow = useNarrow();
  /** 当前拉开的是哪个抽屉。null = 都收着。 */
  const [sheet, setSheet] = useState<"folders" | "aside" | null>(null);

  // 右栏那份内容只写一遍，宽屏塞进 <aside>、窄屏塞进抽屉——
  // 写两份的话，以后加一种面板必然漏改一处
  const asideLabel = showAccounts ? "账号管理" : listMode === "search" ? "下载队列" : "曲目详情";
  const asideHasContent = showAccounts || listMode === "search" || selected !== null;
  const asidePanel = showAccounts ? (
    <AccountsPanel />
  ) : listMode === "search" ? (
    <QueuePanel />
  ) : selected ? (
    <TrackDetail key={selected.id} track={selected} />
  ) : (
    <EmptyState
      icon={<MousePointerClick size={20} />}
      title="选一首看详情"
      hint="分析过的曲目会显示 BPM、调号轮，以及能接上的下一首。"
    />
  );

  // 窄屏下换了标签（曲库 ↔ 搜索）就把抽屉收起来：抽屉里装的内容会跟着变，
  // 留在屏幕上等于突然换了一块东西，比自己收起来更让人迷惑
  useEffect(() => {
    if (narrow) setSheet(null);
  }, [narrow, listMode]);

  // 点「账号管理」时窄屏没有右栏可以显示，直接把抽屉拉开
  useEffect(() => {
    if (narrow && showAccounts) setSheet("aside");
  }, [narrow, showAccounts]);

  /* ------------------------------------------------------------ 三栏拖宽 */
  const splitRef = useRef<HTMLDivElement | null>(null);

  // 打开时恢复上次拖的宽度。存 px：百分比在窗口缩放时会把"我调好的那栏"再挤变形
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    for (const side of ["left", "right"] as const) {
      const saved = localStorage.getItem(`kd-split-${side}`);
      if (saved) el.style.setProperty(`--kd-${side}`, `${saved}px`);
    }
  }, []);

  const COLUMN_BOUNDS = { left: [140, 420], right: [240, 600] } as const;

  const startColumnDrag = (side: "left" | "right") => (event: React.PointerEvent) => {
    const el = splitRef.current;
    if (!el) return;
    event.preventDefault();
    const startX = event.clientX;
    const target =
      side === "left" ? (el.firstElementChild as HTMLElement) : (el.lastElementChild as HTMLElement);
    const startWidth = target.getBoundingClientRect().width;
    const [min, max] = COLUMN_BOUNDS[side];
    const onMove = (move: PointerEvent) => {
      // 左把手往右拖 = 左栏变宽；右把手往右拖 = 右栏变窄
      const delta = side === "left" ? move.clientX - startX : startX - move.clientX;
      const width = Math.round(Math.min(max, Math.max(min, startWidth + delta)));
      el.style.setProperty(`--kd-${side}`, `${width}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const value = el.style.getPropertyValue(`--kd-${side}`).replace("px", "");
      if (value) localStorage.setItem(`kd-split-${side}`, value);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resetColumn = (side: "left" | "right") => {
    splitRef.current?.style.removeProperty(`--kd-${side}`);
    localStorage.removeItem(`kd-split-${side}`);
  };

  /**
   * 「搜VJ(Bili)」：详情面板把拼好的词发过来，这里代填搜索框、
   * 只勾 B 站、然后提交。提交不能在事件回调里直接调 submit()——
   * 那个闭包看到的还是旧 query——所以立一个"待发射"标记，
   * 等 state 落定后的渲染周期里再开枪。
   */
  const [vjPending, setVjPending] = useState("");
  useEffect(() => {
    const onVj = (event: Event) => {
      const q = (event as CustomEvent<string>).detail?.trim();
      if (!q) return;
      setQuery(q);
      setPlatforms(["bilibili"]);
      setListMode("search");
      setVjPending(q);
    };
    window.addEventListener(VJ_SEARCH_EVENT, onVj);
    return () => window.removeEventListener(VJ_SEARCH_EVENT, onVj);
  }, [setListMode]);
  useEffect(() => {
    if (vjPending && query === vjPending && platforms.length === 1 && platforms[0] === "bilibili") {
      setVjPending("");
      void submit();
    }
  }, [vjPending, query, platforms, submit]);

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
      // 视频行没有勾选框，别把它们悄悄勾上——那样底下会冒出一条
      // "已选 N 首"，但列表里根本找不到第 N 条被勾中的行
      const keys = selectableGroups(item).map((group) => selectionKey(index, group.group_id));
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
      selectableGroups(item).map((group) => selectionKey(index, group.group_id)),
    );
    setChosen((current) => (current.size >= allKeys.length ? new Set() : new Set(allKeys)));
  }, [items]);

  const resultCount = useMemo(
    () => (items ?? []).reduce((sum, item) => sum + item.groups.length, 0) + (video ? 1 : 0),
    [items, video],
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
    setQueueError("");
    try {
      // 不报"已加入 N 个任务"：右边那栏就是队列，任务当场排进去，
      // 而且勾选被清空、这条动作栏跟着收起来，做成了看得一清二楚
      await enqueue(chosenSources, { quality: quality === "" ? null : quality });
      setChosen(new Set());
      void refreshStats();
    } catch (error) {
      setQueueError(`加入队列失败：${errorText(error)}`);
    }
  }, [chosenSources, quality, enqueue, refreshStats]);

  /**
   * 本地列表里拖动换位：把整个文件夹的曲目顺序写回它的 .kumodeck.json。
   * 先按当前排序取全量（分页外的也要参与），再把拖动的块插到目标位置。
   */
  const reorderTracks = useCallback(
    async (ids: number[], targetId: number, before: boolean) => {
      const folder = filter.folder;
      if (!folder) return;
      setReorderError("");
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
        // 拖完之后列表会自己弹回原来的顺序，得说清楚这不是"拖歪了"
        setReorderError(`排序失败：${errorText(error)}`);
      }
    },
    [filter.folder, filter.sort, filter.order, setFilter],
  );

  const libraryNote =
    `${tracks.length} / ${total} 首` +
    (selectedIds.length > 1 ? ` · 选中 ${selectedIds.length}` : "") +
    (stats
      ? ` · 已分析 ${stats.analyzed} · ${formatDuration(stats.total_duration)} · ${formatBytes(stats.total_size)}`
      : "");

  /** 标签行右边那条摘要：搜索出错时由原因顶替，其余时候是统计。 */
  const headNote =
    listMode === "library" ? libraryNote : listMode === "search" ? searchError || note : "";

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
        soundcloudEnabled={settings?.soundcloud_enabled ?? false}
      />

      <div className="kd-section-body">
        <div className="kd-split" data-folders="true" data-narrow={narrow ? "true" : undefined} ref={splitRef}>
          {/* 窄屏（竖屏 / 手机）下左右两栏收进底部抽屉，只留中间的列表。
              列表是这个软件的脊柱：找歌、搜歌、看结果全在它上面，
              两侧那两栏都是"针对当前这一首/这一次搜索"的补充，按需拉出来就够。 */}
          {!narrow && <FolderTree />}

          {/* 三栏之间的两条把手：拖动改左/右栏宽度，中间吃剩余。宽度记在
              localStorage，下次打开还是你拉的样子。双击复位到默认。 */}
          {!narrow && (
            <div
              className="kd-split-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整文件夹栏宽度"
              onPointerDown={startColumnDrag("left")}
              onDoubleClick={() => resetColumn("left")}
            />
          )}

          <div className="kd-table-wrap">
            {/* 列表面板的"眉目"：两个标签常驻，随时可切，不等搜索了才出现。
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
              </nav>
              {/* 搜索失败时这条摘要就地变成失败原因（data-error 让它换个颜色），
                  不另起一行——列表上头多一条会把整块面板顶得跳一下 */}
              <span
                className="kd-list-note kd-truncate"
                data-error={listMode === "search" && searchError ? "true" : undefined}
                title={headNote || undefined}
              >
                {headNote}
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
              {/* 「账号管理」贴最右：切的是右栏（账号面板），不是中间列表 */}
              <nav className="kd-list-tabs" aria-label="账号">
                <button type="button" aria-pressed={showAccounts} onClick={toggleAccounts}>
                  账号管理
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
            {/* 拖动排序失败：贴在曲目表正上方，就是刚才拖的那张表 */}
            {listMode === "library" && (
              <InlineNotice
                text={reorderError}
                onDismiss={() => setReorderError("")}
                block
              />
            )}

            {listMode === "search" ? (
              <div className="kd-scroll">
                <ResultTable
                  items={items ?? []}
                  video={video}
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
                {/* 入队失败就摆在这颗按钮左边：勾选还在，重按一次就是重试 */}
                <InlineNotice text={queueError} onDismiss={() => setQueueError("")} />
                <Button variant="primary" onClick={() => void addToQueue()}>
                  <Download size={13} />
                  加入队列
                </Button>
              </div>
            )}
          </div>

          {!narrow && (
            <div
              className="kd-split-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整详情栏宽度"
              onPointerDown={startColumnDrag("right")}
              onDoubleClick={() => resetColumn("right")}
            />
          )}

          {/* 右栏：账号面板优先，其次搜索时是下载队列，曲库时是曲目详情。
              窄屏下同一份内容改由底部抽屉装（见下面的 asidePanel）。 */}
          {!narrow && <aside className="kd-split-aside kd-scroll">{asidePanel}</aside>}
        </div>
      </div>

      {/* ---------------- 窄屏：悬浮键 + 两个抽屉 ---------------- */}
      {narrow && (
        <>
          <div className="kd-fabs">
            <button
              type="button"
              className="kd-fab"
              aria-label="文件夹"
              title="文件夹"
              onClick={() => setSheet("folders")}
            >
              <FolderTree_Icon size={17} />
            </button>
            {/* 有选中的曲目 / 有队列内容时才点得亮：点开一个空面板是白跑一趟。
                data-dot 在有内容时点一个小红点，替代"自动弹出"——
                自动弹会在滚列表时不停打断，这个点只是告诉你"这里有东西可看"。 */}
            <button
              type="button"
              className="kd-fab"
              data-dot={asideHasContent ? "true" : undefined}
              aria-label={asideLabel}
              title={asideLabel}
              onClick={() => setSheet("aside")}
            >
              <PanelRight size={17} />
            </button>
          </div>

          <Sheet open={sheet === "folders"} title="文件夹" onClose={() => setSheet(null)}>
            <FolderTree />
          </Sheet>
          <Sheet open={sheet === "aside"} title={asideLabel} onClose={() => setSheet(null)}>
            {asidePanel}
          </Sheet>
        </>
      )}
    </section>
  );
}
