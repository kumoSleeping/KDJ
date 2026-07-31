import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
  SEARCH_DROP_PATH_ATTR,
  searchDropPathAt,
  searchQueueDropAt,
} from "../../lib/folderDrop";
import { claimActiveTrackDragIds } from "../../lib/trackDrag";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useUpdateStore } from "../../stores/updateStore";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import {
  shouldPinDetailOnClick,
  useTrackClickPrefs,
} from "../../lib/trackClickPrefs";
import { isPlatformEnabled, patchEnabledPlatform } from "../../lib/enabledPlatforms";
import { resolveLibraryPasteOp } from "../../lib/libraryPaste";
import { isOutsideFolder } from "../../lib/outsideFolder";
import { useLibraryClipboard } from "../../lib/useLibraryClipboard";
import {
  selectSelectedTrack,
  useLibraryStore,
  type SelectMode,
} from "../../stores/libraryStore";
import type { IntakeItem, MergedGroup, Platform, SongSource, VideoInfo } from "../../types";
import { InlineNotice, Sheet } from "../common";
import { AppChrome } from "../chrome/AppChrome";
import { AsideFaceSwitch, AsideHead, AsideToggleButton, type TrackAsideFace } from "../chrome/AsideHead";
import { useLyricsPrefs, type LyricsAsideFace } from "../../lib/lyricsPrefs";
import {
  EXPLORE_SEARCH_EVENT,
  type ExploreSearchDetail,
  type ExploreSearchPlatform,
} from "../../lib/vjSearch";
import type { SearchBurstTone } from "../download/SearchBurstFX";
import { ensureLyrics } from "../../stores/lyricsStore";
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
import { FolderTree, NarrowFolderRail } from "../library/FolderTree";
import { VjExportPanel } from "../library/VjExportPanel";
import { DETAIL_EVENT } from "../library/TrackTable";
import { LyricsView } from "../player/LyricsView";
import { SettingsPanel } from "../settings/SettingsPanel";
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

/** 常驻两栏的身份。右侧面板现在只在本地列表区内展开，不参与换位。 */
type ColumnId = "tree" | "list";
const COLUMN_ORDER_KEY = "kd-column-order";

/**
 * 唯一的工作台。没有"下载板块"和"曲库板块"之分。
 *
 * 平时它就是曲库：左边文件夹、中间曲目；右栏只在打开旁路面板
 *（详情 / 队列 / 账号…）时出现，空闲时列表吃满整宽。
 * 顶栏那条在线搜索是"去网上搜歌来下"——一旦搜出结果，
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
  const setHasResults = useAppStore((state) => state.setHasResults);
  const videoPipMode = useVideoPip((state) => state.mode);
  const videoPipSession = useVideoPip((state) => state.session);
  const showTrackDetail = useAppStore((state) => state.showTrackDetail);
  const showSettings = useAppStore((state) => state.showSettings);
  const settingsPanelEpoch = useAppStore((state) => state.settingsPanelEpoch);
  const showQueue = useAppStore((state) => state.showQueue);
  const queuePanelEpoch = useAppStore((state) => state.queuePanelEpoch);
  const showPreview = useAppStore((state) => state.showPreview);
  const showFolders = useAppStore((state) => state.showFolders);
  const foldersPanelEpoch = useAppStore((state) => state.foldersPanelEpoch);
  const showVjExport = useAppStore((state) => state.showVjExport);
  const vjExportPanelEpoch = useAppStore((state) => state.vjExportPanelEpoch);
  const showLyrics = useAppStore((state) => state.showLyrics);
  const lyricsPanelEpoch = useAppStore((state) => state.lyricsPanelEpoch);
  const openLyricsPanel = useAppStore((state) => state.openLyricsPanel);
  const setPreferredAsideFace = useLyricsPrefs((state) => state.setAsideFace);
  const toggleSettingsPanel = useAppStore((state) => state.toggleSettingsPanel);
  const toggleQueuePanel = useAppStore((state) => state.toggleQueuePanel);
  const playingTrack = useSyncExternalStore(
    subscribePlayingTrack,
    getPlayingTrack,
    getPlayingTrack,
  );
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
  // 未在设置里开启的源不能参与搜索勾选。
  const platforms = useMemo(() => {
    const selected = normalizeSearchPlatforms(settings?.search_platforms);
    return selected.filter((id) => isPlatformEnabled(settings, id));
  }, [settings]);
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
        // 「全部曲目」只接搜索下载，不接曲目搬家。
        if (dest === SEARCH_DEFAULT_DOWNLOAD_SENTINEL) return;
        const op = resolveLibraryPasteOp({
          settings: useAppStore.getState().settings,
          forceMove: event.altKey,
        });
        void useLibraryStore
          .getState()
          .applyFolderOp(ids, dest, op)
          .then((result) => {
            const failed = Object.keys(result.errors).length;
            if (failed > 0) {
              const verb = op === "move" ? "移动" : op === "copy" ? "复制" : "链接";
              setFolderDropError(`已${verb} ${result.track_ids.length} 首，${failed} 首失败`);
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
      const snap = useAppStore.getState().settings;
      if (!isPlatformEnabled(snap, platform)) return;
      const current = normalizeSearchPlatforms(snap?.search_platforms).filter((id) =>
        isPlatformEnabled(snap, id),
      );
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
   * `platformsOverride` 是一次性的：Explore 代搜只打目标平台，但**不动**搜索框上
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

  /* ------------------------------------------------------------ 布局档位 */
  const { columns: layout, chrome, portrait } = useLayoutSignals();
  // columns：wide 展开旁路栏，narrow 只收右侧旁路。
  // chrome：inline 一行搜索，stacked 竖屏两段式——见 useLayoutMode。
  // 文件夹导航在所有尺寸都常驻；竖屏只收成窄轨，避免手机状态下失去入口。
  const showTree = true;
  const [compactTreeExpanded, setCompactTreeExpanded] = useState(() => !portrait);
  useEffect(() => {
    // 进入竖屏默认收起；离开竖屏必须恢复完整侧栏，不能把手机轨道状态带到 1:1/横屏。
    setCompactTreeExpanded(!portrait);
  }, [portrait]);
  const [searchSplitPercent, setSearchSplitPercent] = useState(50);
  const searchSplitRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const key = portrait ? "kd-search-split-portrait" : "kd-search-split-regular";
    const saved = Number(localStorage.getItem(key));
    setSearchSplitPercent(Number.isFinite(saved) && saved > 0 ? saved : portrait ? 8 : 50);
  }, [portrait]);
  const startSearchSplitDrag = (event: React.PointerEvent) => {
    const host = searchSplitRef.current;
    if (!host) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = host.getBoundingClientRect();
    const min = portrait ? 5 : 15;
    const max = portrait ? 55 : 85;
    const update = (clientX: number) => {
      const next = Math.min(max, Math.max(min, ((clientX - rect.left) / rect.width) * 100));
      setSearchSplitPercent(next);
    };
    const onMove = (move: PointerEvent) => update(move.clientX);
    const onUp = (up: PointerEvent) => {
      update(up.clientX);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const key = portrait ? "kd-search-split-portrait" : "kd-search-split-regular";
      const final = Math.min(max, Math.max(min, ((up.clientX - rect.left) / rect.width) * 100));
      localStorage.setItem(key, String(final));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  /** 当前拉开的是哪个抽屉。null = 都收着。 */
  const [sheet, setSheet] = useState<"aside" | null>(null);
  /** 锁定只拦横屏里由歌曲/视频触发的自动展开；显式入口会解除锁定并强制打开。 */
  const [asideLocked, setAsideLocked] = useState(false);
  const asideLockedRef = useRef(false);
  useEffect(() => {
    asideLockedRef.current = asideLocked;
  }, [asideLocked]);
  /** 用户点曲目或「正在播」入口后钉住详情/歌词内容面；关闭后下一次单击曲目会重新打开。 */
  const [detailPinned, setDetailPinned] = useState(false);
  /** 歌词模式下右栏双极：详情 ↔ 歌词。关歌词模式时点歌仍只开详情。 */
  const [trackAsideFace, setTrackAsideFace] = useState<TrackAsideFace>(
    () => useLyricsPrefs.getState().asideFace,
  );
  const trackAsideFaceRef = useRef(trackAsideFace);
  useEffect(() => {
    trackAsideFaceRef.current = trackAsideFace;
  }, [trackAsideFace]);
  const prevShowLyricsRef = useRef(showLyrics);

  /** 点曲目只负责详情；歌词由右栏/播放器上的歌词入口显式打开。 */
  const faceForTrackPin = useCallback((): LyricsAsideFace => "detail", []);

  /**
   * 双击播放会先走一下单击（detail=1）再走 dblclick。单击「查看这首」的详情
   * 若当场弹出，快双击时版面会先挤一下再被播放手势接住——所以单击路径延迟
   * 一拍再钉住；第二下（detail>=2）取消延迟并立刻钉住，避免慢双击先开后关。
   */
  const detailTimerRef = useRef<number | null>(null);
  const clearDetailTimer = useCallback(() => {
    if (detailTimerRef.current !== null) {
      window.clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearDetailTimer, [clearDetailTimer]);

  const pinTrackAside = useCallback(
    (face: TrackAsideFace, trackId?: number) => {
      // 先写 ref，避免紧接着的 store 更新抢先 re-render 时误把内容面关掉。
      trackAsideFaceRef.current = face;
      setDetailPinned(true);
      setTrackAsideFace(face);
      if (face === "lyrics") {
        openLyricsPanel();
        const track =
          (trackId != null
            ? useLibraryStore.getState().tracks.find((item) => item.id === trackId)
            : null) ??
          selectSelectedTrack(useLibraryStore.getState()) ??
          getPlayingTrack();
        void ensureLyrics(track);
      } else {
        showTrackDetail();
      }
    },
    [openLyricsPanel, showTrackDetail],
  );

  const selectTrack = useCallback(
    (id: number, mode: SelectMode, clickCount = 1) => {
      select(id, mode);
      // 普通单击既选择曲目，也明确表达“查看这首”的意图。修饰键/勾选多选
      // 只维护选区，不能让详情抽屉跟着每次批量选择反复弹出。
      if (mode !== "replace") return;
      if (asideLockedRef.current) return;

      const face = faceForTrackPin();

      // 单栏、或单击已有明确动作（播放 / 加入下一首）时不抢详情；
      // 详情统一留给底部唱盘或用户再次单击（双击播放、无附加动作时）。
      if (!shouldPinDetailOnClick(useTrackClickPrefs.getState(), layout)) return;
      clearDetailTimer();
      if (clickCount >= 2) {
        // 双击播放：取消「单击查看」那一拍延迟即可，但内容面仍然钉住。
        // 以前这里会 unset，慢双击（第二下晚于 300ms）就会先弹出再被撤掉。
        pinTrackAside(face, id);
        return;
      }
      detailTimerRef.current = window.setTimeout(() => {
        detailTimerRef.current = null;
        pinTrackAside(face, id);
      }, 300);
    },
    [clearDetailTimer, faceForTrackPin, layout, pinTrackAside, select],
  );

  /**
   * 「正在播」跳转自己切的标签，不该被下面"换标签收抽屉"的 effect 误伤——
   * 只有这一次的 listMode 变化要放行抽屉，所以立个一次性记号。
   */
  const detailJumpRef = useRef(false);
  const previewJumpRef = useRef(false);
  useEffect(() => {
    const onDetail = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source;
      const isLocatePlaying = source === "locate-playing";
      const explicitLocate = source === "player-deck" || isLocatePlaying;
      // 竖屏只有显式定位（唱盘 / 「定位正在播」）可以拉开详情；被动事件不弹抽屉。
      if (portrait && !explicitLocate) return;
      // 横屏锁定只拦歌曲/视频的自动事件；显式定位必须强制打开。
      if (!explicitLocate && asideLockedRef.current) return;
      if (explicitLocate) setAsideLocked(false);
      // 人在搜索页时先跳回曲库页：详情装在曲库页的右栏/抽屉里，
      // 停在搜索页把抽屉拉开，底下的列表和这首歌对不上号
      if (useAppStore.getState().listMode !== "library") {
        detailJumpRef.current = true;
        showTrackDetail();
      }
      // 「定位正在播」只滚动列表到当前歌曲，不展开右栏/抽屉
      if (isLocatePlaying) return;
      // 唱盘 / 其他显式查看：钉住内容面
      pinTrackAside(faceForTrackPin());
      if (layout === "narrow") setSheet("aside");
    };
    window.addEventListener(DETAIL_EVENT, onDetail);
    return () => window.removeEventListener(DETAIL_EVENT, onDetail);
  }, [faceForTrackPin, layout, pinTrackAside, portrait, showTrackDetail]);

  // 播放条 / 自动显示：store 打开歌词 → 钉住内容面并切到歌词极。
  // 从歌词极关掉 store（播放条再点一次）→ 收起整块内容面。
  // 顶栏切到详情会清 showLyrics，但 face 已是 detail，不能误关面板。
  useEffect(() => {
    if (showLyrics) {
      setDetailPinned(true);
      setTrackAsideFace("lyrics");
    } else if (prevShowLyricsRef.current && trackAsideFaceRef.current === "lyrics") {
      setDetailPinned(false);
      setSheet(null);
    }
    prevShowLyricsRef.current = showLyrics;
  }, [showLyrics, lyricsPanelEpoch]);

  // 网络视频：右栏预览面板暂时关闭，不再自动拉开预览板块。
  useEffect(() => {
    if (videoPipMode === "panel" && videoPipSession?.source === "network") {
      if (useAppStore.getState().showPreview) useAppStore.getState().dismissOverlay();
    }
  }, [videoPipMode, videoPipSession]);

  // 右栏那份内容只写一遍，宽屏塞进 <aside>、窄屏塞进抽屉——
  // 写两份的话，以后加一种面板必然漏改一处
  // 下载队列只在显式打开 / 真正入队时出现；搜索半栏另看 hasResults。
  // 歌曲试听走主播放条；网络视频右栏预览暂时关闭。
  // 空闲不挂「选一首看详情」占位——没旁路内容时右栏整块消失。
  // 右栏打开时叠在列表右侧，不挤中间区，列宽与空白保持不动。
  // 歌词不再独占旁路槽：歌词模式下与详情同属内容面，顶栏双极切换。
  const queueAside = showQueue;
  // 暂时关掉右栏网络视频预览面板：细项改到下载队列里配；双击仍走浮动 / 系统 PiP。
  const previewAside = false;
  const realOverlayAside =
    showFolders || showSettings || showVjExport || previewAside || queueAside;
  const lyricsTrack = selected ?? playingTrack;
  // 有 showLyrics / 歌词极时也要挂面板：无曲时 LyricsView 自己显示空态，
  // 不能因为 lyricsTrack 为空就把整栏吞掉（看起来像点了没反应）。
  const lyricsAside =
    !realOverlayAside && detailPinned && trackAsideFace === "lyrics";
  const detailAside =
    !realOverlayAside && detailPinned && trackAsideFace === "detail" && Boolean(selected);
  const trackAside = lyricsAside || detailAside;
  const hasAsideContent = realOverlayAside || trackAside;
  const showAside = layout === "wide" && hasAsideContent;
  const showTrackFaceSwitch = trackAside;

  const closeAside = useCallback(() => {
    setDetailPinned(false);
    setSheet(null);
    useAppStore.getState().dismissOverlay();
  }, []);

  /** 竖屏 / 窄屏：点左侧文件夹后收起弹出面板，把列表让出来。 */
  const onFolderNavigate = useCallback(() => {
    if (portrait) setCompactTreeExpanded(false);
    if (layout === "narrow") closeAside();
  }, [portrait, layout, closeAside]);

  const toggleAside = useCallback(() => {
    if (showAside) {
      closeAside();
      return;
    }
    const track = selected ?? playingTrack;
    if (!track) return;
    pinTrackAside(showLyrics ? "lyrics" : faceForTrackPin(), track.id);
  }, [closeAside, faceForTrackPin, pinTrackAside, playingTrack, selected, showAside, showLyrics]);

  const asideToggle =
    layout === "wide" ? (
      <AsideToggleButton
        open={showAside}
        canOpen={Boolean(selected ?? playingTrack)}
        onToggle={toggleAside}
      />
    ) : null;

  const onTrackAsideFace = useCallback(
    (face: TrackAsideFace) => {
      trackAsideFaceRef.current = face;
      setTrackAsideFace(face);
      setPreferredAsideFace(face);
      if (face === "lyrics") {
        openLyricsPanel();
        void ensureLyrics(selectSelectedTrack(useLibraryStore.getState()) ?? getPlayingTrack());
        return;
      }
      showTrackDetail();
    },
    [openLyricsPanel, setPreferredAsideFace, showTrackDetail],
  );

  const asideLabel = showFolders
    ? "文件夹"
    : showSettings
      ? "设置"
      : showVjExport
        ? "导出 VJ"
        : previewAside
          ? "预览"
          : queueAside
            ? "下载队列"
            : showTrackFaceSwitch
              ? trackAsideFace === "lyrics"
                ? "歌词"
                : "曲目详情"
              : lyricsAside
                ? "歌词"
                : detailAside
                  ? "曲目详情"
                  : "";
  const asidePanel = showFolders ? (
    <FolderTree onNavigate={onFolderNavigate} />
  ) : showSettings ? (
    <SettingsPanel />
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
  ) : lyricsAside ? (
    <LyricsView track={lyricsTrack} />
  ) : detailAside && selected ? (
    <TrackDetail key={selected.id} track={selected} />
  ) : null;
  const queueOpen =
    showQueue &&
    !showSettings &&
    !showFolders &&
    !showPreview &&
    !showVjExport &&
    !showLyrics;

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

  // 显式旁路（设置 / 下载队列 / 文件夹…）打开时收起曲目详情，避免右栏叠两层内容。
  // 歌词属于曲目内容面（详情 ↔ 歌词），上面已有 effect 钉住；这里不能 unpin，
  // 否则一点「歌词」就被拆掉，看起来像弹不出来。
  useEffect(() => {
    if (!(showSettings || showFolders || showVjExport || showQueue)) return;
    setDetailPinned(false);
    setAsideLocked(false);
    if (layout === "narrow") setSheet("aside");
  }, [
    layout,
    showSettings,
    showQueue,
    showFolders,
    showVjExport,
    settingsPanelEpoch,
    foldersPanelEpoch,
    vjExportPanelEpoch,
    queuePanelEpoch,
  ]);

  const toggleQueueDrawer = useCallback(() => {
    const opening = !useAppStore.getState().showQueue;
    if (opening) setDetailPinned(false);
    toggleQueuePanel();
    if (opening) {
      setAsideLocked(false);
      if (layout === "narrow") setSheet("aside");
    }
  }, [layout, toggleQueuePanel]);

  const openSettingsFromChrome = useCallback(() => {
    setDetailPinned(false);
    toggleSettingsPanel();
  }, [toggleSettingsPanel]);

  const openUpdateFromChrome = useCallback(() => {
    setDetailPinned(false);
    useUpdateStore.getState().openUpdateSection();
  }, []);

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
  const shellRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const localAsideRef = useRef<HTMLElement | null>(null);

  // 打开时恢复上次拖的宽度。存 px：百分比在窗口缩放时会把"我调好的那栏"再挤变形
  // 写在 section-body：顶栏左区与侧栏共用 --kd-left。
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    for (const side of ["left", "right"] as const) {
      const saved = localStorage.getItem(`kd-split-${side}`);
      if (saved) el.style.setProperty(`--kd-${side}`, `${saved}px`);
    }
  }, []);

  const COLUMN_BOUNDS = { left: [140, 420], right: [240, 600] } as const;
  const LEFT_RAIL_WIDTH = 58;
  const LEFT_RAIL_SNAP = 112;

  const startColumnDrag = (side: "left" | "right") => (event: React.PointerEvent) => {
    const shell = shellRef.current;
    const el = splitRef.current;
    if (!shell || !el) return;
    event.preventDefault();
    const startX = event.clientX;
    const target = side === "left" ? (el.firstElementChild as HTMLElement) : localAsideRef.current;
    if (!target) return;
    const startWidth = target.getBoundingClientRect().width;
    const [min, max] = COLUMN_BOUNDS[side];
    let treeExpanded = compactTreeExpanded;
    const onMove = (move: PointerEvent) => {
      // 左把手往右拖 = 左栏变宽；右把手往右拖 = 右栏变窄
      const delta = side === "left" ? move.clientX - startX : startX - move.clientX;
      if (side === "left") {
        const rawWidth = startWidth + delta;
        if (rawWidth <= LEFT_RAIL_SNAP) {
          if (treeExpanded) {
            treeExpanded = false;
            setCompactTreeExpanded(false);
          }
          return;
        }
        if (!treeExpanded) {
          treeExpanded = true;
          setCompactTreeExpanded(true);
        }
      }
      const width = Math.round(Math.min(max, Math.max(min, startWidth + delta)));
      shell.style.setProperty(`--kd-${side}`, `${width}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (side === "left" && !treeExpanded) {
        // 最小轨道是一个布局状态，不把 58px 当作展开宽度存下来。
        shell.style.setProperty("--kd-left", `${Math.max(min, LEFT_RAIL_WIDTH)}px`);
        return;
      }
      const value = shell.style.getPropertyValue(`--kd-${side}`).replace("px", "");
      if (value) localStorage.setItem(`kd-split-${side}`, value);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resetColumn = (side: "left" | "right") => {
    shellRef.current?.style.removeProperty(`--kd-${side}`);
    localStorage.removeItem(`kd-split-${side}`);
  };

  /**
   * Explore 代搜：详情面板把拼好的词 + 目标平台发过来，这里代填搜索框再提交。
   * 提交不能在事件回调里直接调 submit()——那个闭包看到的还是旧 query——
   * 所以立一个"待发射"标记，等 state 落定后的渲染周期里再开枪。
   *
   * 只搜目标平台走的是 submit 的一次性覆盖参数，**不动**平台勾选：
   * 这是程序代搜，不是用户改了主意；搜完回来下歌，勾着的还是原来那几家。
   * B 站扫光粉、SoundCloud 扫光橙。
   */
  const [explorePending, setExplorePending] = useState<{
    query: string;
    platform: ExploreSearchPlatform;
  } | null>(null);
  const [searchBurstNonce, setSearchBurstNonce] = useState(0);
  const [searchBurstTone, setSearchBurstTone] = useState<SearchBurstTone>("rainbow");
  useEffect(() => {
    const onExplore = (event: Event) => {
      const detail = (event as CustomEvent<ExploreSearchDetail>).detail;
      const q = detail?.query?.trim();
      if (!q || !detail?.platform) return;
      setQuery(q);
      // 只撑开中间搜索半栏（submit → setHasResults）；不弹右栏下载队列。
      setExplorePending({ query: q, platform: detail.platform });
    };
    window.addEventListener(EXPLORE_SEARCH_EVENT, onExplore);
    return () => window.removeEventListener(EXPLORE_SEARCH_EVENT, onExplore);
  }, []);
  useEffect(() => {
    if (explorePending && query === explorePending.query) {
      const { platform } = explorePending;
      setExplorePending(null);
      setSearchBurstTone(platform === "soundcloud" ? "orange" : "pink");
      setSearchBurstNonce((n) => n + 1);
      // 目标源若还没在设置里开过，代搜时顺手启用（同平台条首次点击）。
      if (settings && !isPlatformEnabled(settings, platform)) {
        void saveSettings(patchEnabledPlatform(settings, platform, true));
      }
      void submit([platform]);
    }
  }, [explorePending, query, submit, settings, saveSettings]);

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

  // 曲目表 / 搜索结果：Cmd/Ctrl + A · C · X · V（Option+V 强制移动）。
  useLibraryClipboard({
    active: () => Boolean(hasResults && items && items.length > 0),
    selectAll: () => {
      setSearchSelectionMode(true);
      selectAllSearch();
    },
    chosenSources: () => chosenSources,
    enqueueChosen: () => addToQueue(),
  });

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

  /** 结果行首那颗小下载键：当前选中来源直接入队。 */
  const downloadGroup = useCallback(
    async (group: MergedGroup) => {
      const pickedIndex = sourceIndex[group.group_id] ?? group.best_source_index;
      const preferred = group.sources[pickedIndex] ?? group.sources[0];
      const source =
        preferred?.platform !== "local"
          ? preferred
          : group.sources.find((entry) => entry.platform !== "local");
      if (!source) return;
      setQueueError("");
      try {
        await enqueue([source], { quality: settings?.default_quality ?? null });
        openQueuePanel();
        void refreshStats();
      } catch (error) {
        setQueueError(`加入队列失败：${errorText(error)}`);
      }
    },
    [sourceIndex, settings?.default_quality, enqueue, openQueuePanel, refreshStats],
  );

  /**
   * 本地列表里拖动换位：把整个文件夹的曲目顺序写回它的 .kdj/manifest.json。
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
    showSettings,
    showQueue,
    showPreview,
    showFolders,
    showVjExport,
  ]);

  return (
    <section className="kd-section">
      <div
        className="kd-section-body"
        ref={shellRef}
        data-compact-tree={compactTreeExpanded ? "open" : "closed"}
      >
        <AppChrome
          // Mac 用 Overlay 红绿灯；Windows / Linux 关掉系统标题栏后自绘三键。
          showWindowControls={
            Boolean(window.kdj?.platform) &&
            window.kdj?.platform !== "darwin" &&
            window.kdj?.platform !== "android" &&
            window.kdj?.platform !== "ios"
          }
          actions={
            <ChromeActions
              settingsOpen={showSettings}
              onSettings={openSettingsFromChrome}
              queueOpen={queueOpen}
              queueCount={activeDownloads}
              onQueue={toggleQueueDrawer}
              onOpenUpdate={openUpdateFromChrome}
            />
          }
        />
        <div className="kd-stage">
        <div
          className="kd-split"
          data-folders="true"
          data-layout={layout}
          data-tree={showTree ? "open" : undefined}
          data-compact-tree={compactTreeExpanded ? "open" : "closed"}
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
              <NarrowFolderRail
                expanded={compactTreeExpanded}
                onNavigate={onFolderNavigate}
              />
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
            <div className="kd-table-wrap">
            {/*
              在线搜索只占主栏顶上，不盖左侧文件夹栏。曲库工作条在本地半栏里；
              搜索结果弹出时把它顶到左半边，与右半边 SearchWorkRail 同行对齐。
            */}
            <div className="kd-search-band">
              <SearchBar
                query={query}
                onQueryChange={setQuery}
                batch={batch}
                busy={busy}
                onSubmit={() => void submit()}
                burstNonce={searchBurstNonce}
                burstTone={searchBurstTone}
                platforms={platforms}
                onTogglePlatform={togglePlatform}
                stacked={chrome === "stacked"}
              />
            </div>
            <div className="kd-local-list-slot" data-aside={showAside ? "open" : "closed"}>
              <div
                ref={searchSplitRef}
                className="kd-middle-split"
                data-search={hasResults ? "true" : "false"}
                style={{ "--kd-local-share": `${searchSplitPercent}%` } as React.CSSProperties}
              >
                <div
                  className="kd-middle-local kd-download-dropzone"
                  data-drop-active={localDropActive ? "true" : undefined}
                  {...{
                    [SEARCH_DROP_PATH_ATTR]:
                      !queueView && !isOutsideFolder(filter.folder)
                        ? filter.folder.trim() || SEARCH_DEFAULT_DOWNLOAD_SENTINEL
                        : undefined,
                  }}
                  onDragOver={(event) => {
                    if (!isSearchDownloadDrag(event)) return;
                    // 临时列表没有落点；全部曲目落到默认下载文件夹。
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
                    if (isOutsideFolder(dest)) {
                      setFolderDropError("先打开一个文件夹，再拖进来");
                      return;
                    }
                    void enqueueSearchDrop(
                      event,
                      dest || SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
                    ).catch((error: unknown) =>
                      setFolderDropError(error instanceof Error ? error.message : String(error)),
                    );
                  }}
                >
                  <LibraryWorkRail
                    showDownloads={!hasResults}
                    asideToggle={showAside ? undefined : asideToggle}
                  />
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
                        if (isOutsideFolder(dest)) {
                          finishSearchDrop();
                          setFolderDropError("先打开一个文件夹，再拖进来");
                          return;
                        }
                        void enqueueSearchDrop(
                          event,
                          dest || SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
                        ).catch((error: unknown) =>
                          setFolderDropError(error instanceof Error ? error.message : String(error)),
                        );
                      }}
                    >
                      <span>
                        {filter.folder && !isOutsideFolder(filter.folder)
                          ? "放入当前文件夹"
                          : "先选择一个文件夹"}
                      </span>
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
                    reorderable={
                      Boolean(filter.folder) &&
                      !filter.folderDeep &&
                      !isOutsideFolder(filter.folder)
                    }
                    onReorder={(ids, targetId, before) => void reorderTracks(ids, targetId, before)}
                  />
                </div>

                {hasResults && (
                  <>
                    <div
                      className="kd-middle-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="调整本地曲库与网络搜索结果宽度"
                      onPointerDown={startSearchSplitDrag}
                    />
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
                          layout={layout}
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
                          onDownloadGroup={(group) => void downloadGroup(group)}
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
                  <aside className="kd-split-aside kd-pop-panel" ref={localAsideRef}>
                    <AsideHead
                      title={asideLabel}
                      face={showTrackFaceSwitch ? trackAsideFace : undefined}
                      onFaceChange={showTrackFaceSwitch ? onTrackAsideFace : undefined}
                      asideToggle={asideToggle}
                    />
                    <div className="kd-split-aside-body kd-scroll">{asidePanel}</div>
                  </aside>
                </>
              )}
            </div>

          </div>
          </div>

        </div>

        {/* 单栏：右栏进侧方抽屉，只盖中间舞台，不压顶栏/播放条。 */}
        {layout === "narrow" && (
          <Sheet
            open={sheet === "aside" && hasAsideContent}
            title={asideLabel || "面板"}
            heading={
              showTrackFaceSwitch ? (
                <AsideFaceSwitch face={trackAsideFace} onFaceChange={onTrackAsideFace} />
              ) : undefined
            }
            onClose={closeAside}
          >
            {asidePanel}
          </Sheet>
        )}
        </div>
      </div>
    </section>
  );
}
