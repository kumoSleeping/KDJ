import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { clearTextSelection } from "../../lib/textSelection";
import {
  activeSearchDrag,
  claimActiveSearchDrag,
  enqueueSearchDrop,
  enqueueSearchPayload,
  enqueueSearchQueuePayload,
  finishSearchDrop,
  isSearchDownloadDrag,
  SEARCH_DRAG_STATE_EVENT,
} from "../../lib/searchDrag";
import {
  SEARCH_DROP_PATH_ATTR,
  searchDropPathAt,
  searchQueueDropAt,
} from "../../lib/folderDrop";
import { claimActiveTrackDragIds } from "../../lib/trackDrag";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import { useLibraryClipboard } from "../../lib/useLibraryClipboard";
import {
  selectSelectedTrack,
  useLibraryStore,
  type SelectMode,
} from "../../stores/libraryStore";
import type { IntakeItem, Platform, SongSource, VideoInfo } from "../../types";
import { InlineNotice, Sheet } from "../common";
import { AppChrome, ThemeToggle } from "../chrome/AppChrome";
import { AsideHead } from "../chrome/AsideHead";
import { ChromeActions } from "../chrome/ChromeActions";
import { LibraryWorkRail } from "../chrome/LibraryWorkRail";
import { SearchWorkRail } from "../chrome/SearchWorkRail";
import { QueuePanel } from "../download/QueuePanel";
import { isApplyingNav, readPlace, useNavStore } from "../../stores/navStore";
import { useVideoPip } from "../../lib/videoPip";
import { ResultTable, selectableGroups, selectionKey } from "../download/ResultTable";
import {
  DEFAULT_PRIORITY,
  normalizeSearchPlatforms,
  SearchBar,
} from "../download/SearchBar";
import { VideoPreview } from "../download/VideoPreview";
import { FolderTree } from "../library/FolderTree";
import { VjExportPanel } from "../library/VjExportPanel";
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

/** 常驻两栏的身份。右侧面板现在只在本地列表区内展开，不参与换位。 */
type ColumnId = "tree" | "list";
const COLUMN_ORDER_KEY = "kd-column-order";

export function requestVjSearch(query: string): void {
  window.dispatchEvent(new CustomEvent<string>(VJ_SEARCH_EVENT, { detail: query }));
}

/**
 * 唯一的工作台。没有"下载板块"和"曲库板块"之分。
 *
 * 平时它就是曲库：左边文件夹、中间曲目；右栏只在打开旁路面板
 *（详情 / 队列 / 账号…）时出现，空闲时列表吃满整宽。
 * 顶上那条大搜索框是"去网上搜歌来下"——一旦搜出结果，
 * 中间栏一分为二：左半继续是本地曲库，右半挂搜索候选。
 * 真正把歌加入下载（按钮 / 拖进文件夹）时，才把右栏切成下载队列。
 *
 * 这么排的理由：找歌 → 下载 → 进曲库 → 排 set 本来就是一条线上的动作，
 * 搜的时候本地还在眼前，也不被队列面板打断。
 */
export function Workspace() {
  const settings = useAppStore((state) => state.settings);
  const listMode = useAppStore((state) => state.listMode);
  const hasResults = useAppStore((state) => state.hasResults);
  const openQueuePanel = useAppStore((state) => state.openQueuePanel);
  const openPreviewPanel = useAppStore((state) => state.openPreviewPanel);
  const setHasResults = useAppStore((state) => state.setHasResults);
  const videoPipMode = useVideoPip((state) => state.mode);
  const videoPipSession = useVideoPip((state) => state.session);
  const showTrackDetail = useAppStore((state) => state.showTrackDetail);
  const showAccounts = useAppStore((state) => state.showAccounts);
  const accountPanelEpoch = useAppStore((state) => state.accountPanelEpoch);
  const showDjPanel = useAppStore((state) => state.showDjPanel);
  const djPanelEpoch = useAppStore((state) => state.djPanelEpoch);
  const showQueue = useAppStore((state) => state.showQueue);
  const queuePanelEpoch = useAppStore((state) => state.queuePanelEpoch);
  const showPreview = useAppStore((state) => state.showPreview);
  const previewPanelEpoch = useAppStore((state) => state.previewPanelEpoch);
  const showFolders = useAppStore((state) => state.showFolders);
  const foldersPanelEpoch = useAppStore((state) => state.foldersPanelEpoch);
  const showVjExport = useAppStore((state) => state.showVjExport);
  const vjExportPanelEpoch = useAppStore((state) => state.vjExportPanelEpoch);
  const toggleAccounts = useAppStore((state) => state.toggleAccounts);
  const openDjPanel = useAppStore((state) => state.openDjPanel);
  const toggleQueuePanel = useAppStore((state) => state.toggleQueuePanel);
  const toggleFoldersPanel = useAppStore((state) => state.toggleFoldersPanel);
  const enqueue = useDownloadStore((state) => state.enqueue);
  const activeDownloads = useDownloadStore((state) => state.activeCount);

  const tracks = useLibraryStore((state) => state.tracks);
  const loading = useLibraryStore((state) => state.loading);
  const libError = useLibraryStore((state) => state.error);
  const filter = useLibraryStore((state) => state.filter);
  const selectedId = useLibraryStore((state) => state.selectedId);
  const selectedIds = useLibraryStore((state) => state.selectedIds);
  const selected = useLibraryStore(selectSelectedTrack);
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
  // 勾选与排序都进 settings.json：排序是 platform_priority，勾选是 search_platforms。
  const platforms = useMemo(
    () => normalizeSearchPlatforms(settings?.search_platforms),
    [settings?.search_platforms],
  );
  const saveSettings = useAppStore((state) => state.saveSettings);
  // 跨平台去重恒为开，开关已删：不合并的话搜一次出四条一模一样的结果，
  // 没有人会想要那个。留常量而不是把 true 写进调用点，是为了让
  // `/intake` 那个字段的语义在这里仍然看得见。
  const merge = true;
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<IntakeItem[] | null>(null);
  /** 贴链接解析出来的那一个视频，置顶在结果列表最前面；关键词搜索会把它顶掉。 */
  const [video, setVideo] = useState<VideoInfo | null>(null);
  /**
   * 三处失败各有各的现场，所以分成三条，不合并成一个全局的错误：
   * 搜索失败要顶在结果列表的摘要位、入队失败要贴在「加入队列」旁边、
   * 拖动排序失败要出现在曲目表上方。合成一条就总有两处放错地方。
   */
  const [searchError, setSearchError] = useState("");
  const [queueError, setQueueError] = useState("");
  const [reorderError, setReorderError] = useState("");
  const [folderDropError, setFolderDropError] = useState("");
  const [localDropActive, setLocalDropActive] = useState(false);
  const [searchDragActive, setSearchDragActive] = useState(() => Boolean(activeSearchDrag()));
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [searchSelectionMode, setSearchSelectionMode] = useState(false);
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

  useEffect(() => {
    if (hasResults) return;
    setChosen(new Set());
    setSearchSelectionMode(false);
  }, [hasResults]);

  useEffect(() => {
    const onSearchDragState = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setSearchDragActive(Boolean(detail?.active));
      if (!detail?.active) setLocalDropActive(false);
    };
    window.addEventListener(SEARCH_DRAG_STATE_EVENT, onSearchDragState);
    return () => window.removeEventListener(SEARCH_DRAG_STATE_EVENT, onSearchDragState);
  }, []);

  useEffect(() => {
    /**
     * WKWebView 能开始原生拖动，却偶尔不把 drop 送给左侧文件夹。
     * dragend 仍有松手坐标：命中文件夹时直接完成操作。claim 闩锁会挡住
     * 随后迟到的原生 drop，确保同一次拖动只执行一次。
     */
    let lastDropPath = "";
    let lastQueueDrop = false;
    const rememberDropTargetUnderPointer = (event: DragEvent) => {
      // 某些 WKWebView 的 dragend 坐标会退回 0,0；持续记录最后一次 dragover
      // 命中的文件夹、当前曲目表或下载队列，同时在指针移出时清掉旧目标。
      lastDropPath = searchDropPathAt(event.clientX, event.clientY);
      lastQueueDrop = searchQueueDropAt(event.clientX, event.clientY);
    };
    const onDragEndFallback = (event: DragEvent) => {
      const queueDrop = searchQueueDropAt(event.clientX, event.clientY) || lastQueueDrop;
      const dest = searchDropPathAt(event.clientX, event.clientY) || lastDropPath;
      lastDropPath = "";
      lastQueueDrop = false;

      // QueuePanel 的原生 drop 在 WKWebView 中也会偶发丢失。旧兜底只认识文件夹，
      // 所以第一次松在队列上毫无反应、再拖一次碰巧收到原生 drop 才成功。
      if (queueDrop) {
        const payload = claimActiveSearchDrag();
        if (payload) {
          void enqueueSearchQueuePayload(payload).catch((error: unknown) =>
            setFolderDropError(errorText(error)),
          );
        }
        return;
      }
      if (!dest) return;

      const ids = claimActiveTrackDragIds();
      if (ids.length > 0) {
        const op = event.altKey ? "move" : "link";
        void useLibraryStore
          .getState()
          .applyFolderOp(ids, dest, op)
          .then((result) => {
            const failed = Object.keys(result.errors).length;
            if (failed > 0) {
              setFolderDropError(
                `已${op === "link" ? "链接" : "移动"} ${result.track_ids.length} 首，${failed} 首失败`,
              );
            }
          })
          .catch((error: unknown) => setFolderDropError(errorText(error)));
        return;
      }

      const payload = claimActiveSearchDrag();
      if (payload) {
        void enqueueSearchPayload(payload, dest).catch((error: unknown) =>
          setFolderDropError(errorText(error)),
        );
      }
    };

    window.addEventListener("dragover", rememberDropTargetUnderPointer, true);
    window.addEventListener("dragend", onDragEndFallback, true);
    return () => {
      window.removeEventListener("dragover", rememberDropTargetUnderPointer, true);
      window.removeEventListener("dragend", onDragEndFallback, true);
    };
  }, []);

  const togglePlatform = useCallback(
    (platform: Platform) => {
      const current = normalizeSearchPlatforms(useAppStore.getState().settings?.search_platforms);
      const next = current.includes(platform)
        ? current.filter((item) => item !== platform)
        : [...current, platform];
      // 全关掉就搜不了——至少留一个；想换平台先勾上再去掉旧的。
      if (next.length === 0) return;
      void saveSettings({ search_platforms: next });
    },
    [saveSettings],
  );

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
      } catch (error) {
        setVideo(null);
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
    // local 已退出搜索平台条；旧状态/覆盖里若还带着，提交前剥掉。
    const orderedPlatforms = [...(platformsOverride ?? platforms)]
      .filter((id) => id !== "local")
      .sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
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
    } catch (error) {
      setItems([]);
      setHasResults(true);
      // 结果列表这时是空的，那条摘要位就腾出来写原因——
      // 另起一行会把列表顶下去，切来切去整块面板都在跳
      setSearchError(`处理失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
    // merge 是常量，不进依赖
  }, [query, platforms, batch, settings, setHasResults]);

  // 曲目表的 Cmd/Ctrl + C / X / V。挂在这里而不是 TrackTable 里：
  // 快捷键是全局的，要覆盖整个工作台（含搜索半栏开着时）。
  useLibraryClipboard();

  /* ------------------------------------------------------------ 布局档位 */
  const { columns: layout, chrome } = useLayoutSignals();
  // columns：wide 展开旁路栏，narrow 只收右侧旁路；左侧文件夹始终保留。
  // chrome：inline 一行搜索，stacked 竖屏两段式——见 useLayoutMode
  // 文件夹树是定位曲库的主导航，桌面窄窗 / 手机比例也不换成图标轨、更不消失。
  const showTree = true;
  /** 当前拉开的是哪个抽屉。null = 都收着。 */
  const [sheet, setSheet] = useState<"aside" | null>(null);
  /** 用户点曲目或「正在播」入口后钉住详情；关闭后下一次单击曲目会重新打开。 */
  const [detailPinned, setDetailPinned] = useState(false);

  const selectTrack = useCallback(
    (id: number, mode: SelectMode) => {
      select(id, mode);
      // 普通单击既选择曲目，也明确表达“查看这首”的意图。修饰键/勾选多选
      // 只维护选区，不能让详情抽屉跟着每次批量选择反复弹出。
      if (mode !== "replace") return;
      setDetailPinned(true);
      showTrackDetail();
      if (layout === "narrow") setSheet("aside");
    },
    [layout, select, showTrackDetail],
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
      setDetailPinned(true);
      showTrackDetail();
      if (layout === "narrow") setSheet("aside");
    };
    window.addEventListener(DETAIL_EVENT, onDetail);
    return () => window.removeEventListener(DETAIL_EVENT, onDetail);
  }, [layout, showTrackDetail]);

  // 网络视频：右栏面板档才拉开预览板块；浮动档要关掉这块，别占右栏
  useEffect(() => {
    if (videoPipMode === "panel" && videoPipSession?.source === "network") {
      if (!useAppStore.getState().showPreview) previewJumpRef.current = true;
      openPreviewPanel();
      if (layout === "narrow") setSheet("aside");
      return;
    }
    if (useAppStore.getState().showPreview) {
      useAppStore.getState().dismissOverlay();
    }
  }, [videoPipMode, videoPipSession, layout, openPreviewPanel]);

  // 右栏那份内容只写一遍，宽屏塞进 <aside>、窄屏塞进抽屉——
  // 写两份的话，以后加一种面板必然漏改一处
  // 下载队列只在显式打开 / 真正入队时出现；搜索半栏另看 hasResults。
  // 歌曲试听走主播放条；网络视频在「右栏面板」模式下才占这里。
  // 空闲不挂「选一首看详情」占位——没旁路内容时右栏整块消失，列表吃满宽。
  const queueAside = showQueue;
  const previewAside =
    showPreview && videoPipMode === "panel" && videoPipSession?.source === "network";
  const overlayAside =
    showFolders || showAccounts || showDjPanel || showVjExport || previewAside || queueAside;
  const detailAside = detailPinned && Boolean(selected) && !overlayAside;
  const hasAsideContent = overlayAside || detailAside;
  const showAside = layout === "wide" && hasAsideContent;

  const closeAside = useCallback(() => {
    setDetailPinned(false);
    setSheet(null);
    useAppStore.getState().dismissOverlay();
  }, []);

  // 右栏开关：有选中曲目就打开详情，否则打开始终有内容的下载队列。
  const openAside = useCallback(() => {
    if (selected) {
      setDetailPinned(true);
      showTrackDetail();
    } else {
      openQueuePanel();
    }
    if (layout === "narrow") setSheet("aside");
  }, [layout, openQueuePanel, selected, showTrackDetail]);

  /** 顶栏详情键：语义与播放条「正在播」相同，只是直接服务于当前选中曲目。 */
  const openSelectedDetail = useCallback(() => {
    if (!selected) return;
    if (useAppStore.getState().listMode !== "library") detailJumpRef.current = true;
    setDetailPinned(true);
    showTrackDetail();
    if (layout === "narrow") setSheet("aside");
  }, [layout, selected, showTrackDetail]);

  const asideLabel = showFolders
    ? "文件夹"
    : showAccounts
      ? "账号管理"
      : showDjPanel
        ? "接播设置"
        : showVjExport
          ? "导出 VJ"
          : previewAside
            ? "预览"
            : queueAside
              ? "下载队列"
              : detailAside
                ? "曲目详情"
                : "";
  const asidePanel = showFolders ? (
    <FolderTree />
  ) : showAccounts ? (
    <AccountsPanel />
  ) : showDjPanel ? (
    <DjPanel />
  ) : showVjExport ? (
    <VjExportPanel />
  ) : previewAside ? (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      {videoPipSession?.source === "network" ? (
        <VideoPreview
          key={`${videoPipSession.bvid}#${videoPipSession.page}`}
          req={{
            bvid: videoPipSession.bvid,
            title: videoPipSession.title,
            author: videoPipSession.author,
            page: videoPipSession.page,
            cover: videoPipSession.cover,
          }}
        />
      ) : null}
    </div>
  ) : queueAside ? (
    <QueuePanel />
  ) : detailAside && selected ? (
    <TrackDetail key={selected.id} track={selected} />
  ) : null;
  const queueOpen =
    showQueue && !showAccounts && !showDjPanel && !showFolders && !showPreview && !showVjExport;
  // 宽屏是真正的右栏，窄屏则是承载同一份内容的抽屉；按钮位置和开关语义保持一致。
  const asideOpen = layout === "wide" ? showAside : sheet === "aside" && hasAsideContent;

  // 窄屏下换了标签（曲库 ↔ 搜索）就把抽屉收起来：抽屉里装的内容会跟着变，
  // 留在屏幕上等于突然换了一块东西，比自己收起来更让人迷惑
  useEffect(() => {
    // 例外：「正在播」跳转刚切的标签，它正要用这个抽屉（见 detailJumpRef）
    if (detailJumpRef.current) {
      detailJumpRef.current = false;
      return;
    }
    if (previewJumpRef.current) {
      previewJumpRef.current = false;
      return;
    }
    setSheet(null);
  }, [layout, listMode]);

  // 旁路面板：窄屏没有右栏 → 拉开抽屉
  useEffect(() => {
    if (!(showAccounts || showDjPanel || showQueue || showPreview || showFolders || showVjExport)) {
      return;
    }
    if (layout === "narrow") setSheet("aside");
  }, [
    layout,
    showAccounts,
    showDjPanel,
    showQueue,
    showPreview,
    showFolders,
    showVjExport,
    accountPanelEpoch,
    djPanelEpoch,
    queuePanelEpoch,
    previewPanelEpoch,
    foldersPanelEpoch,
    vjExportPanelEpoch,
  ]);

  /* ------------------------------------------------------------ 三栏换位 */
  /** 常驻的文件夹 / 主栏顺序，长期保存。 */
  const [columnOrder, setColumnOrder] = useState<ColumnId[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COLUMN_ORDER_KEY) ?? "null");
      // 兼容旧的三栏存档：详情面板已改为在本地列表内展开，忽略旧的 aside 位。
      if (Array.isArray(saved)) {
        const columns = saved.filter((id): id is ColumnId => id === "tree" || id === "list");
        if (columns.length === 2) return columns;
      }
    } catch {
      // 存档坏了就用默认序，不值得为它报错
    }
    return ["tree", "list"];
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
      clearTextSelection();
      setDragCol(id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id); // Firefox 不设就不触发 drag
    },
    onDragEnd: () => setDragCol(null),
  });

  /* ------------------------------------------------------------ 三栏拖宽 */
  const splitRef = useRef<HTMLDivElement | null>(null);
  const localAsideRef = useRef<HTMLElement | null>(null);

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
    const target = side === "left" ? (el.firstElementChild as HTMLElement) : localAsideRef.current;
    if (!target) return;
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
      // 只撑开中间搜索半栏（submit → setHasResults）；不弹右栏下载队列。
      setVjPending(q);
    };
    window.addEventListener(VJ_SEARCH_EVENT, onVj);
    return () => window.removeEventListener(VJ_SEARCH_EVENT, onVj);
  }, []);
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
  const selectAllSearch = useCallback(() => {
    setChosen(
      new Set(
        (items ?? []).flatMap((item, index) =>
          selectableGroups(item).map((group) => selectionKey(index, group.group_id)),
        ),
      ),
    );
  }, [items]);

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
      await enqueue(chosenSources, { quality: settings?.default_quality ?? null });
      openQueuePanel();
      setChosen(new Set());
      setSearchSelectionMode(false);
      void refreshStats();
    } catch (error) {
      setQueueError(`加入队列失败：${errorText(error)}`);
    }
  }, [chosenSources, settings?.default_quality, enqueue, openQueuePanel, refreshStats]);

  /** 歌单/专辑父行的明确主动作：无需先全选再找顶部按钮，整包直接进下载队列。 */
  const downloadItem = useCallback(
    async (index: number) => {
      const item = items?.[index];
      if (!item) return;
      const seen = new Set<string>();
      const sources = selectableGroups(item).flatMap((group) => {
        const pickedIndex = sourceIndex[group.group_id] ?? group.best_source_index;
        const source = group.sources[pickedIndex] ?? group.sources[0];
        if (!source) return [];
        const key = `${source.platform}:${source.key}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [source];
      });
      if (!sources.length) return;
      setQueueError("");
      try {
        await enqueue(sources, { quality: settings?.default_quality ?? null });
        openQueuePanel();
        void refreshStats();
      } catch (error) {
        setQueueError(`整包下载失败：${errorText(error)}`);
      }
    },
    [items, sourceIndex, settings?.default_quality, enqueue, openQueuePanel, refreshStats],
  );

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

  // 主/副两级排序的三段式点击语义全在 store 里（cycleSort），
  // 这里只负责把点击转过去——判断逻辑放在组件里迟早会和别处的入口不一致
  const sortBy = useLibraryStore((state) => state.cycleSort);
  const queueView = useLibraryStore((state) => state.queueView);
  const commitNav = useNavStore((state) => state.commit);

  // 地点变化时写入浏览历史（应用历史时跳过，避免自己推自己）
  useEffect(() => {
    if (isApplyingNav()) return;
    const timer = window.setTimeout(() => commitNav(readPlace()), 40);
    return () => window.clearTimeout(timer);
  }, [
    commitNav,
    listMode,
    filter.folder,
    filter.folderDeep,
    queueView,
    selectedId,
    showAccounts,
    showDjPanel,
    showQueue,
    showPreview,
    showFolders,
    showVjExport,
  ]);

  return (
    <section className="kd-section">
      <div className="kd-section-body">
        <div
          className="kd-split"
          data-folders="true"
          data-layout={layout}
          data-tree={showTree ? "open" : undefined}
          data-aside={showAside ? "open" : "closed"}
          ref={splitRef}
        >
          {/* 左侧文件夹树始终在一条线上常驻；窄屏只把右侧详情等旁路内容收进抽屉。 */}
          {showTree && (
            <div
              className="kd-col-slot kd-tree-slot"
              style={{ order: orderOf("tree"), minWidth: 0 }}
              data-dragging={dragCol === "tree" ? "true" : undefined}
              {...dropProps("tree")}
            >
              <span {...gripProps("tree")} />
              {/* 左栏固定常驻；主题键靠右，其余区域用于拖动窗口。 */}
              <div
                className="kd-tree-chrome"
                data-tauri-drag-region
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) {
                    return;
                  }
                  window.kdj?.windowControl("drag");
                }}
              >
                <span className="kd-tree-chrome-drag" data-tauri-drag-region aria-hidden="true" />
                <ThemeToggle />
              </div>
              <FolderTree />
            </div>
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
            className="kd-main-slot"
            style={{ order: orderOf("list") }}
            data-dragging={dragCol === "list" ? "true" : undefined}
            {...dropProps("list")}
          >
            <span {...gripProps("list")} />
            <AppChrome showThemeToggle={!showTree} />
            <div className="kd-table-wrap">
            {/* 搜索在主栏眉头之下 */}
            <div className="kd-list-head" data-mode={listMode} data-chrome={chrome}>
              <SearchBar
                query={query}
                onQueryChange={setQuery}
                batch={batch}
                busy={busy}
                onSubmit={() => void submit()}
                platforms={platforms}
                onTogglePlatform={togglePlatform}
                soundcloudEnabled={settings?.soundcloud_enabled ?? false}
                stacked={chrome === "stacked"}
              />
            </div>

            {/*
              曲库状态和全局入口始终是一根完整横条。搜索结果、详情栏等内容只能在
              它下面分栏，不能与它并排后把横条从中间截断。
            */}
            <LibraryWorkRail
              showDownloads={!hasResults}
              actions={
                <ChromeActions
                  showFolders={layout === "narrow"}
                  foldersOpen={showFolders}
                  onFolders={toggleFoldersPanel}
                  detailOpen={detailAside}
                  detailAvailable={Boolean(selected)}
                  onDetail={openSelectedDetail}
                  djOpen={showDjPanel}
                  onDj={openDjPanel}
                  loginOpen={showAccounts}
                  onLogin={toggleAccounts}
                  queueOpen={queueOpen}
                  queueCount={activeDownloads}
                  onQueue={toggleQueuePanel}
                  asideOpen={asideOpen}
                  onAsideToggle={asideOpen ? closeAside : openAside}
                />
              }
            />

            {/*
              完整工作条以下分成「主内容 + 最右旁路栏」。主内容内部再按需拆成本地曲库
              和搜索结果；搜索面板从这里向下插入，不会上顶挤断工作条。
            */}
            <div className="kd-local-list-slot" data-aside={showAside ? "open" : "closed"}>
              <div
                className="kd-middle-split"
                data-search={hasResults ? "true" : "false"}
              >
                <div
                  className="kd-middle-local kd-download-dropzone"
                  data-drop-active={localDropActive ? "true" : undefined}
                  {...{
                    [SEARCH_DROP_PATH_ATTR]: !queueView && filter.folder.trim()
                      ? filter.folder.trim()
                      : undefined,
                  }}
                  onDragOver={(event) => {
                    if (!isSearchDownloadDrag(event)) return;
                    // 临时列表 / 全部曲目没有落点文件夹，仍放行指针反馈，松手时再报错。
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setLocalDropActive(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setLocalDropActive(false);
                    }
                  }}
                  onDrop={(event) => {
                    setLocalDropActive(false);
                    if (!isSearchDownloadDrag(event)) return;
                    event.preventDefault();
                    if (queueView) {
                      setFolderDropError("临时列表不能接下载，先打开一个文件夹");
                      return;
                    }
                    const dest = filter.folder.trim();
                    if (!dest) {
                      setFolderDropError("先打开一个文件夹，再拖进来");
                      return;
                    }
                    void enqueueSearchDrop(event, dest).catch((error: unknown) =>
                      setFolderDropError(error instanceof Error ? error.message : String(error)),
                    );
                  }}
                >
                  {searchDragActive && (
                    <div
                      className="kd-local-search-drop-overlay"
                      data-drop-active={localDropActive ? "true" : undefined}
                      onDragEnter={(event) => {
                        if (!isSearchDownloadDrag(event)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                        setLocalDropActive(true);
                      }}
                      onDragOver={(event) => {
                        if (!isSearchDownloadDrag(event)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                        setLocalDropActive(true);
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setLocalDropActive(false);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setLocalDropActive(false);
                        if (!isSearchDownloadDrag(event)) return;
                        if (queueView) {
                          finishSearchDrop();
                          setFolderDropError("临时列表不能接下载，先打开一个文件夹");
                          return;
                        }
                        const dest = filter.folder.trim();
                        if (!dest) {
                          finishSearchDrop();
                          setFolderDropError("先打开一个文件夹，再拖进来");
                          return;
                        }
                        void enqueueSearchDrop(event, dest).catch((error: unknown) =>
                          setFolderDropError(error instanceof Error ? error.message : String(error)),
                        );
                      }}
                    >
                      <span>{filter.folder ? "放入当前文件夹" : "先选择一个文件夹"}</span>
                    </div>
                  )}
                  <LibraryToolbar />
                  {libError && (
                    <div className="kd-toolbar" style={{ color: "var(--kd-danger)" }}>
                      {libError}
                    </div>
                  )}
                  <InlineNotice
                    text={reorderError}
                    onDismiss={() => setReorderError("")}
                    block
                  />
                  <InlineNotice
                    text={folderDropError}
                    onDismiss={() => setFolderDropError("")}
                    block
                  />
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
                </div>

                {hasResults && (
                  <>
                    <div className="kd-middle-divider" aria-hidden="true" />
                    <div className="kd-middle-search">
                      <SearchWorkRail
                        items={items ?? []}
                        selectionCount={chosen.size}
                        selecting={searchSelectionMode || chosen.size > 0}
                        onSelectAll={selectAllSearch}
                        onClear={() => setChosen(new Set())}
                        onDone={() => {
                          setChosen(new Set());
                          setSearchSelectionMode(false);
                        }}
                        onAddToQueue={() => void addToQueue()}
                        queueError={queueError}
                        onDismissQueueError={() => setQueueError("")}
                        chosenReady={chosenSources.length > 0}
                        onClose={() => {
                          setHasResults(false);
                          setChosen(new Set());
                          setSearchSelectionMode(false);
                        }}
                      />
                      <InlineNotice text={searchError} onDismiss={() => setSearchError("")} block />
                      <div className="kd-scroll">
                        <ResultTable
                          items={items ?? []}
                          video={video}
                          loading={busy}
                          searched={hasResults}
                          selected={chosen}
                          selectionMode={searchSelectionMode}
                          onSelectionModeChange={setSearchSelectionMode}
                          expandedGroups={expandedGroups}
                          collapsedItems={collapsedItems}
                          sourceIndex={sourceIndex}
                          onToggleSelect={toggleSelect}
                          onToggleExpand={toggleExpand}
                          onPickSource={pickSource}
                          onToggleItem={toggleItem}
                          onToggleItemAll={toggleItemAll}
                          onToggleAll={toggleAll}
                          onDownloadItem={(index) => void downloadItem(index)}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>

              {showAside && (
                <>
                  <div
                    className="kd-split-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整详情栏宽度"
                    onPointerDown={startColumnDrag("right")}
                    onDoubleClick={() => resetColumn("right")}
                  />
                  <aside className="kd-split-aside" ref={localAsideRef}>
                    <AsideHead title={asideLabel} />
                    <div className="kd-split-aside-body kd-scroll">{asidePanel}</div>
                  </aside>
                </>
              )}
            </div>

          </div>
          </div>

        </div>
      </div>

      {/* 单栏：右栏与文件夹都进同一套底部抽屉。 */}
      {layout === "narrow" && (
        <Sheet
          open={sheet === "aside" && hasAsideContent}
          title={asideLabel || "面板"}
          onClose={closeAside}
        >
          {asidePanel}
        </Sheet>
      )}
    </section>
  );
}
