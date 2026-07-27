import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  MousePointerClick,
  X,
} from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { formatBytes, formatDuration } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLayoutMode } from "../../lib/useLayoutMode";
import { useLibraryClipboard } from "../../lib/useLibraryClipboard";
import {
  selectSelectedTrack,
  useLibraryStore,
  type SelectMode,
} from "../../stores/libraryStore";
import type { IntakeItem, Platform, Quality, SongSource, VideoInfo } from "../../types";
import { Button, EmptyState, InlineNotice, Sheet } from "../common";
import { QueuePanel } from "../download/QueuePanel";
import { SongPreviewPanel } from "../download/SongPreviewPanel";
import { SONG_PREVIEW_EVENT, type SongPreviewRequest } from "../../lib/songPreview";
import {
  VIDEO_PREVIEW_EVENT,
  VideoPreview,
  type VideoPreviewRequest,
} from "../download/VideoPreview";
import { ResultTable, selectableGroups, selectionKey } from "../download/ResultTable";
import { DEFAULT_PRIORITY, SearchBar } from "../download/SearchBar";
import { FolderTree, NarrowFolderRail } from "../library/FolderTree";
import { DETAIL_EVENT } from "../library/TrackTable";
import { AccountsPanel } from "../settings/AccountsPanel";
import { DjPanel } from "../player/DjPanel";
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

/** 三栏的身份。顺序可拖动调整，存 localStorage。 */
type ColumnId = "tree" | "list" | "aside";
const COLUMN_ORDER_KEY = "kd-column-order";

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
  const showTrackDetail = useAppStore((state) => state.showTrackDetail);
  const showAccounts = useAppStore((state) => state.showAccounts);
  const toggleAccounts = useAppStore((state) => state.toggleAccounts);
  const showDjPanel = useAppStore((state) => state.showDjPanel);
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
  /** 正在预览的视频。开在右栏队列头上，不弹窗——弹窗盖住结果列表，看完还得找回去。 */
  const [preview, setPreview] = useState<VideoPreviewRequest | null>(null);
  const [songPreview, setSongPreview] = useState<SongPreviewRequest | null>(null);
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
    setPreview(null);
    setNote("");
    setSearchError("");
    setQueueError("");
    setChosen(new Set());
    useAppStore.getState().setHasResults(false);
  }, []);

  /**
   * `platformsOverride` 是一次性的：代搜（搜VJ）只搜 B 站，但**不动**搜索框上
   * 勾着的平台——那是用户为"下歌"调好的状态，程序替他搜一次不该顺手改掉。
   */
  const submit = useCallback(async (platformsOverride?: Platform[]) => {
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
    const orderedPlatforms = [...(platformsOverride ?? platforms)].sort(
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

  // 曲目表的 Cmd/Ctrl + C / X / V。挂在这里而不是 TrackTable 里：
  // 快捷键是全局的，而 TrackTable 在搜索结果模式下会整个消失
  useLibraryClipboard();

  /* ------------------------------------------------------------ 布局档位 */
  const layout = useLayoutMode();
  // 只有两档：wide 三栏全在，narrow 两侧一起收进抽屉。
  // 不做"只收左边"的中间态——见 useLayoutMode 的注释
  const showTree = layout === "wide";
  const showAside = layout === "wide";
  /** 当前拉开的是哪个抽屉。null = 都收着。 */
  const [sheet, setSheet] = useState<"aside" | null>(null);
  const [folderRailExpanded, setFolderRailExpanded] = useState(false);

  /**
   * narrow 下点一首歌**不再**顺手弹详情抽屉——那版试过：点一下的意图九成是
   * "放这首"，弹层却先把列表盖掉，每次都得先关抽屉才能点下一首。
   * 现在点一下 = 直接播放（见 TrackTable 行点击），要看详情就点播放条上的
   * 「正在播」块（封面+曲名那块），它发 DETAIL_EVENT，narrow 档在这里接住拉开抽屉。
   * wide 档不用接：右栏本来就在版面上，选中即可见。
   */
  const selectTrack = useCallback(
    (id: number, mode: SelectMode) => {
      showTrackDetail();
      select(id, mode);
    },
    [select, showTrackDetail],
  );

  /**
   * 「正在播」跳转自己切的标签，不该被下面"换标签收抽屉"的 effect 误伤——
   * 只有这一次的 listMode 变化要放行抽屉，所以立个一次性记号。
   */
  const detailJumpRef = useRef(false);
  const previewJumpRef = useRef(false);
  useEffect(() => {
    const onDetail = () => {
      // 人在搜索页时先跳回曲库页：详情装在曲库页的右栏/抽屉里，
      // 停在搜索页把抽屉拉开，底下的列表和这首歌对不上号
      if (useAppStore.getState().listMode !== "library") {
        detailJumpRef.current = true;
      }
      showTrackDetail();
      if (layout === "narrow") setSheet("aside");
    };
    window.addEventListener(DETAIL_EVENT, onDetail);
    return () => window.removeEventListener(DETAIL_EVENT, onDetail);
  }, [layout, showTrackDetail]);

  // 「预览」从结果行发过来：装进右栏（队列头上）。narrow 档没有右栏，
  // 顺手把抽屉拉开——点了预览却什么都没出现，才是真正的迷惑
  useEffect(() => {
    const onPreview = (event: Event) => {
      // 在线视频预览属于搜索页；显式点击预览时让账号/接播设置自动让位。
      if (useAppStore.getState().listMode !== "search") previewJumpRef.current = true;
      setListMode("search");
      setPreview((event as CustomEvent<VideoPreviewRequest>).detail);
      if (layout === "narrow") setSheet("aside");
    };
    window.addEventListener(VIDEO_PREVIEW_EVENT, onPreview);
    return () => window.removeEventListener(VIDEO_PREVIEW_EVENT, onPreview);
  }, [layout, setListMode]);
  useEffect(() => {
    const onSongPreview = (event: Event) => {
      if (useAppStore.getState().listMode !== "search") previewJumpRef.current = true;
      setListMode("search");
      setSongPreview((event as CustomEvent<SongPreviewRequest>).detail);
      if (layout === "narrow") setSheet("aside");
    };
    window.addEventListener(SONG_PREVIEW_EVENT, onSongPreview);
    return () => window.removeEventListener(SONG_PREVIEW_EVENT, onSongPreview);
  }, [layout, setListMode]);

  // 右栏那份内容只写一遍，宽屏塞进 <aside>、窄屏塞进抽屉——
  // 写两份的话，以后加一种面板必然漏改一处
  const asideLabel = showAccounts
    ? "账号管理"
    : showDjPanel
      ? "接播设置"
      : listMode === "search"
        ? "下载队列"
        : "曲目详情";
  const asidePanel = showAccounts ? (
    <AccountsPanel />
  ) : showDjPanel ? (
    <DjPanel />
  ) : listMode === "search" ? (
    // 预览叠在队列头上而不是顶替它：预览的同时照样往队列里加任务，
    // 两件事本来就会同时发生（看对了就点下载）
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      {preview && (
        <VideoPreview
          key={`${preview.bvid}#${preview.page}`}
          req={preview}
          onClose={() => setPreview(null)}
        />
      )}
      {songPreview && <SongPreviewPanel request={songPreview} onClose={() => setSongPreview(null)} />}
      <div className="kd-grow" style={{ minHeight: 0 }}>
        <QueuePanel />
      </div>
    </div>
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
    // 例外：「正在播」跳转刚切的标签，它正要用这个抽屉（见 detailJumpRef）
    if (detailJumpRef.current) {
      detailJumpRef.current = false;
      return;
    }
    // 点击搜索结果预览主动切页时，事件处理器已经拉开了右侧抽屉；
    // 这里不能紧接着又把它关掉。
    if (previewJumpRef.current) {
      previewJumpRef.current = false;
      return;
    }
    setSheet(null);
  }, [layout, listMode]);

  // 点「账号管理」/「DJ 接歌」时窄屏没有右栏可以显示，直接把抽屉拉开
  useEffect(() => {
    if (!showAside && (showAccounts || showDjPanel)) setSheet("aside");
  }, [showAside, showAccounts, showDjPanel]);

  /* ------------------------------------------------------------ 三栏换位 */
  /**
   * 三栏的左右顺序，长期保存。
   *
   * 用 CSS `order` 换位而不是重排 DOM：拖宽用的两条把手是按"左栏/右栏"
   * 绑定的，DOM 一动，把手拖的就不是它旁边那一栏了。`order` 只改视觉顺序，
   * 把手和它服务的那一栏始终是同一个元素。
   */
  const [columnOrder, setColumnOrder] = useState<ColumnId[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COLUMN_ORDER_KEY) ?? "null");
      if (Array.isArray(saved) && saved.length === 3) return saved as ColumnId[];
    } catch {
      // 存档坏了就用默认序，不值得为它报错
    }
    return ["tree", "list", "aside"];
  });
  const [dragCol, setDragCol] = useState<ColumnId | null>(null);

  // ×10 留出插空：两条拖宽把手要能落在自己那一栏的紧邻位置。
  // 直接用 0/1/2 的话，把手和栏 order 相同，只能按 DOM 顺序排，
  // 栏一换位把手就跑到另一边去了。
  const orderOf = (id: ColumnId) => columnOrder.indexOf(id) * 10;
  const moveColumn = (from: ColumnId, to: ColumnId) => {
    if (from === to) return;
    const next = columnOrder.filter((id) => id !== from);
    next.splice(next.indexOf(to), 0, from);
    localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(next));
    setColumnOrder(next);
  };
  /** 每栏都要接住拖放，所以把这几个 handler 抽出来。 */
  const dropProps = (id: ColumnId) => ({
    onDragOver: (event: React.DragEvent) => {
      if (dragCol && dragCol !== id) event.preventDefault();
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      if (dragCol) moveColumn(dragCol, id);
      setDragCol(null);
    },
  });
  /** 换位把手：只有它可拖，否则栏里的按钮、输入框全会被拖拽劫走。 */
  const gripProps = (id: ColumnId) => ({
    className: "kd-col-grip",
    draggable: true,
    "aria-label": "拖动调整这一栏的位置",
    title: "拖动调整这一栏的位置",
    onDragStart: (event: React.DragEvent) => {
      setDragCol(id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id); // Firefox 不设就不触发 drag
    },
    onDragEnd: () => setDragCol(null),
  });

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
   * 「搜VJ(Bili)」：详情面板把拼好的词发过来，这里代填搜索框、然后提交。
   * 提交不能在事件回调里直接调 submit()——那个闭包看到的还是旧 query——
   * 所以立一个"待发射"标记，等 state 落定后的渲染周期里再开枪。
   *
   * 只搜 B 站走的是 submit 的一次性覆盖参数，**不动**平台勾选：
   * 这是程序代搜，不是用户改了主意；搜完回来下歌，勾着的还是原来那几家。
   */
  const [vjPending, setVjPending] = useState("");
  useEffect(() => {
    const onVj = (event: Event) => {
      const q = (event as CustomEvent<string>).detail?.trim();
      if (!q) return;
      setQuery(q);
      setListMode("search");
      setVjPending(q);
    };
    window.addEventListener(VJ_SEARCH_EVENT, onVj);
    return () => window.removeEventListener(VJ_SEARCH_EVENT, onVj);
  }, [setListMode]);
  useEffect(() => {
    if (vjPending && query === vjPending) {
      setVjPending("");
      void submit(["bilibili"]);
    }
  }, [vjPending, query, submit]);

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
   * 本地列表里拖动换位：把整个文件夹的曲目顺序写回它的 .kdj.json。
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

  // 主/副两级排序的三段式点击语义全在 store 里（cycleSort），
  // 这里只负责把点击转过去——判断逻辑放在组件里迟早会和别处的入口不一致
  const sortBy = useLibraryStore((state) => state.cycleSort);

  return (
    <section className="kd-section">
      {/* macOS 红绿灯所在的 overlay 区单独留出来：下面的搜索栏只负责搜索，
          顶部空白区负责拖动窗口，两者不再在红绿灯底下交界。 */}
      <div className="kd-window-spacer" data-tauri-drag-region aria-hidden="true" />
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
        // 平台选择并进搜索框那一行（见 SearchBar 里的注释）
        platforms={platforms}
        onTogglePlatform={togglePlatform}
        soundcloudEnabled={settings?.soundcloud_enabled ?? false}
      />

      <div className="kd-section-body">
        <div className="kd-split" data-folders="true" data-layout={layout} ref={splitRef}>
          {/* 窄屏（竖屏 / 手机）下左右两栏收进底部抽屉，只留中间的列表。
              列表是这个软件的脊柱：找歌、搜歌、看结果全在它上面，
              两侧那两栏都是"针对当前这一首/这一次搜索"的补充，按需拉出来就够。 */}
          {showTree && (
            <div
              className="kd-col-slot"
              style={{ order: orderOf("tree"), minWidth: 0 }}
              data-dragging={dragCol === "tree" ? "true" : undefined}
              {...dropProps("tree")}
            >
              <span {...gripProps("tree")} />
              <FolderTree />
            </div>
          )}

          {/* 竖屏不把完整文件夹树压缩进主列表，而是保留一条窄的左侧栏。
              这样文件夹入口一直在眼前；详情面板则由播放栏当前曲目区域打开。 */}
          {layout === "narrow" && (
            <NarrowFolderRail
              expanded={folderRailExpanded}
              onToggle={() => setFolderRailExpanded((value) => !value)}
            />
          )}

          {/* 三栏之间的两条把手：拖动改左/右栏宽度，中间吃剩余。宽度记在
              localStorage，下次打开还是你拉的样子。双击复位到默认。 */}
          {showTree && (
            <div
              className="kd-split-handle"
              role="separator"
              aria-orientation="vertical"
              style={{ order: orderOf("tree") + 1 }}
              aria-label="调整文件夹栏宽度"
              onPointerDown={startColumnDrag("left")}
              onDoubleClick={() => resetColumn("left")}
            />
          )}

          <div
            className="kd-table-wrap"
            style={{ order: orderOf("list") }}
            data-dragging={dragCol === "list" ? "true" : undefined}
            {...dropProps("list")}
          >
            <span {...gripProps("list")} />
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
                  搜索{layout === "wide" && resultCount > 0 && ` ${resultCount}`}
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

            {/* 搜索结果的批量操作贴在列表顶部：选中前几首后无需滚到页面底部。 */}
            {listMode === "search" && chosenSources.length > 0 && (
              <div className="kd-picked-bar kd-picked-bar-top">
                <span className="kd-muted">已选 {chosenSources.length} 首</span>
                <Button variant="ghost" size="sm" onClick={() => setChosen(new Set())}>清除</Button>
                <span className="kd-toolbar-gap" />
                <InlineNotice text={queueError} onDismiss={() => setQueueError("")} />
                <Button variant="primary" onClick={() => void addToQueue()}>
                  <Download size={13} /> 加入队列
                </Button>
              </div>
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
                // 两行式排法的判据是"还剩几栏"，不是"这一栏被挤成多窄"，
                // 所以档位得一路传到表上（见 TrackTableProps.layout）
                layout={layout}
                selectedId={selectedId}
                selectedIds={selectedIds}
                sort={filter.sort}
                order={filter.order}
                onSelect={selectTrack}
                onSort={sortBy}
                sort2={filter.sort2}
                order2={filter.order2}
                onScrollEnd={() => void loadMore()}
                reorderable={Boolean(filter.folder) && !filter.folderDeep}
                onReorder={(ids, targetId, before) => void reorderTracks(ids, targetId, before)}
              />
            )}

          </div>

          {showAside && (
            <div
              className="kd-split-handle"
              role="separator"
              aria-orientation="vertical"
              style={{ order: orderOf("aside") - 1 }}
              aria-label="调整详情栏宽度"
              onPointerDown={startColumnDrag("right")}
              onDoubleClick={() => resetColumn("right")}
            />
          )}

          {/* 右栏：账号面板优先，其次搜索时是下载队列，曲库时是曲目详情。
              窄屏下同一份内容改由底部抽屉装（见下面的 asidePanel）。 */}
          {showAside && (
            <aside
              className="kd-split-aside kd-scroll"
              style={{ order: orderOf("aside") }}
              data-dragging={dragCol === "aside" ? "true" : undefined}
              {...dropProps("aside")}
            >
              <span {...gripProps("aside")} />
              {asidePanel}
            </aside>
          )}
        </div>
      </div>

      {/* 窄屏文件夹栏常驻且可在布局内展开；只有详情/队列继续使用底部抽屉。 */}
      {layout === "narrow" && (
        <Sheet open={sheet === "aside"} title={asideLabel} onClose={() => setSheet(null)}>
          {asidePanel}
        </Sheet>
      )}
    </section>
  );
}
