import { PanelDockZone, PanelWideSearchZone, usePanelDock, toggleResponsivePanel } from "../common/panelDock";
import { PanelStack } from "../common/PanelStack";
import { useEffectiveTopPanels } from "../../lib/playbackPanelPrefs";
import { usePanelViewport } from "../../lib/panelViewport";
import { useResponsivePanels } from "../common/useResponsivePanels";
import { EditorDock } from "./EditorDock";
import { useStore } from "zustand";
import { createTemporaryLibrary, type TemporaryLibrary, type LibraryPaneStoreApi } from "../../stores/temporaryLibraryStore";
import { useTemporaryFolderDrop } from "../../lib/temporaryFolderDrag";
import { TemporaryFolderPane } from "../library/TemporaryFolderPane";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft } from "lucide-react";
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
  searchAudioSource,
  SEARCH_DRAG_STATE_EVENT,
} from "../../lib/searchDrag";
import {
  SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
  SEARCH_DROP_PATH_ATTR,
  searchDropPathAt,
  searchQueueDropAt,
} from "../../lib/folderDrop";
import {
  claimActiveTrackDragIds,
  dispatchStreamDeckDrop,
  dispatchTrackCoverDrop,
  trackDeckDropSideAt,
  TRACK_COVER_DROP_TARGET_ATTR,
} from "../../lib/trackDrag";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { useLyricsStore } from "../../stores/lyricsStore";
import {
  makePendingSongStreamTrack,
  streamTrackById,
} from "../../lib/streamTrack";
import {
  getSongPreviewState,
  retrySongPreview,
  subscribeSongPreviewState,
} from "../../lib/songPreview";
import { getPlayerSession, subscribePlayerSession } from "../../lib/playerSession";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { LiveVjPanel } from "../composition/LiveVjPanel";
import { PlaybackPanel } from "../player/PlaybackPanel";
import { useWorkshopStore } from "../../stores/workshopStore";
import { useAppStore } from "../../stores/appStore";
import { enqueueMediaDownloads } from "../../lib/mediaActions";
import { useUpdateStore } from "../../stores/updateStore";
import {
  STREAM_BROWSE_PLATFORMS,
  useStreamBrowseStore,
  type ActiveStreamPlaylist,
  type StreamBrowsePlatform,
} from "../../stores/streamBrowseStore";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import { isPlatformEnabled, patchEnabledPlatform } from "../../lib/enabledPlatforms";
import { resolveLibraryPasteOp } from "../../lib/libraryPaste";
import { isOutsideFolder } from "../../lib/outsideFolder";
import {
  MIDI_BROWSE_CURSOR_ATTR,
  MIDI_BROWSE_EVENT,
  MIDI_BROWSE_ID_ATTR,
  MIDI_BROWSE_ITEM_ATTR,
  MIDI_BROWSE_PANE_ATTR,
  MIDI_LOAD_DECK_EVENT,
  activateBrowseItem,
  currentBrowseIndex,
  nextBrowseIndex,
  paneForSidebarHint,
  toggleBrowseFocus,
  type MidiBrowseDetail,
  type MidiBrowseFocus,
} from "../../lib/midiLibraryNav";
import {
  moveWorkspacePane,
  normalizedWorkspacePaneFractions,
  resolveWorkspaceRequestedTrack,
  restoreWorkspacePaneState,
  visibleWorkspacePanes,
  type WorkspacePaneKind,
  type WorkspacePaneState,
} from "../../lib/workspacePanes";
import {
  readLocalStorage,
  removeLocalStorage,
  writeLocalStorageNow,
} from "../../lib/storageWrite";
import {
  ARROW_KEY_LIST_STEP_EVENT,
  type ArrowKeyListStepDetail,
} from "../../lib/arrowKeyControl";
import {
  readWorkspaceSession,
  setRestorableWorkspaceSource,
  updateLocalWorkspaceSession,
  updateStreamWorkspaceSession,
} from "../../lib/workspaceSession";
import {
  loadForegroundStreamOnce,
  type ForegroundStreamStartup,
} from "../../lib/streamStartup";
import {
  collectionPageWindow,
  openedCollectionItem,
  RESOLVED_COLLECTION_PAGE_SIZE,
  resolvedCollectionItem,
} from "../../lib/searchCollections";
import { useLibraryClipboard } from "../../lib/useLibraryClipboard";
import {
  selectSelectedTrack,
  useLibraryStore,
  type SelectMode,
} from "../../stores/libraryStore";
import type {
  CollectionResult,
  IntakeItem,
  MergedGroup,
  Platform,
  SearchKind,
  SongSource,
  StreamPlaylist,
  StreamPlaylistResponse,
  Track,
  VideoInfo,
} from "../../types";
import { Button, InlineNotice, Panel, Sheet } from "../common";
import { AppChrome } from "../chrome/AppChrome";
import { AsideHead } from "../chrome/AsideHead";
import {
  EXPLORE_SEARCH_EVENT,
  type ExploreSearchDetail,
} from "../../lib/vjSearch";
import { burstToneForPlatforms, type SearchBurstTone } from "../download/SearchBurstFX";
import { ChromeActions } from "../chrome/ChromeActions";
import { LibraryWorkRail } from "../chrome/LibraryWorkRail";
import { SearchWorkRail } from "../chrome/SearchWorkRail";
import { CompositionWorkshop } from "../composition/CompositionWorkshop";
import { DuplicateAnalysisPanel } from "../library/DuplicateAnalysisPanel";
import { isApplyingNav, readPlace, useNavStore } from "../../stores/navStore";
import { useVideoPip } from "../../lib/videoPip";
import { ResultTable, selectableGroups, selectionKey } from "../download/ResultTable";
import {
  DEFAULT_PRIORITY,
  normalizeSearchPlatforms,
  SearchBar,
} from "../download/SearchBar";
import { SearchTipsPanel } from "../download/SearchTipsPanel";
import { FolderTree, NarrowFolderRail } from "../library/FolderTree";
import { DETAIL_EVENT } from "../library/TrackTable";
import { NetworkVideoDetail } from "../player/NetworkVideoDetail";
import { SettingsOverlay } from "../settings/SettingsOverlay";
import { LibraryToolbar } from "../library/LibraryToolbar";
import { TrackDetail } from "../library/TrackDetail";
import { TrackPreviewPanel } from "../library/TrackPreviewPanel";
import { TrackTable } from "../library/TrackTable";

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function matchesEditableStreamOrigin(origin: StreamPlaylist["origin"]): boolean {
  return origin === "favorite" || origin === "created";
}

function streamPlaylistItem(
  playlist: StreamPlaylist,
  response: StreamPlaylistResponse,
): IntakeItem {
  const token = `${response.platform}:playlist:${response.key}`;
  return {
    entry: token,
    kind: "playlist",
    platform: response.platform,
    title: response.title || playlist.title,
    groups: response.sources.map((source, index) => ({
      group_id: `${token}:${source.key}:${index}`,
      title: source.title,
      artists: source.artists,
      album: source.album,
      duration: source.duration,
      cover: source.cover || playlist.cover,
      sources: [source],
      best_source_index: 0,
      score: 0,
    })),
    collections: [],
    errors: {},
    error: "",
  };
}

/** 视频链接识别：单视频直接进视频行；B 站收藏夹和 YouTube 播放列表
 * 走通用集合解析。music.youtube.com 则始终归 YouTube Music。 */
const BILI_RE = /bilibili\.com|b23\.tv|^\s*(?:BV[0-9A-Za-z]{10}|av\d+)\s*$/i;
const BILI_FAVLIST_RE = /\/favlist(?:[/?#]|$)[^\s]*[?&]fid=\d+|^\s*\d{6,}\s*$/i;
const YOUTUBE_VIDEO_RE = /(?:^|\.)youtube\.com|youtu\.be/i;
const YOUTUBE_MUSIC_RE = /music\.youtube\.com/i;
const YOUTUBE_PLAYLIST_RE = /youtube\.com\/playlist\?/i;

const LOCAL_PANE_PIN_KEY = "kd-workspace-local-pane-pinned-v1";
const WORKSPACE_PANES_KEY = "kd-workspace-panes-v2";
const LEGACY_WORKSPACE_PANES_KEY = "kd-workspace-panes-v1";

const WORKSPACE_PANE_LABELS: Record<WorkspacePaneKind, string> = {
  local: "本地曲库",
  search: "在线内容",
};

type WorkspacePaneWeights = Record<WorkspacePaneKind, number>;
type MovableWorkspacePaneKind = Exclude<WorkspacePaneKind, "local">;

interface CollectionSearchSnapshot {
  items: IntakeItem[];
  video: VideoInfo | null;
  scrollTop: number;
  scrollLeft: number;
}

interface OpenStreamPlaylistOptions {
  startup?: ForegroundStreamStartup;
}

function storedJson(key: string): unknown {
  try {
    return JSON.parse(readLocalStorage(key) ?? "null") as unknown;
  } catch {
    return null;
  }
}

function loadWorkspacePanes(): WorkspacePaneState {
  const restored = restoreWorkspacePaneState(
    storedJson(WORKSPACE_PANES_KEY),
    storedJson(LEGACY_WORKSPACE_PANES_KEY),
  );
  const session = readWorkspaceSession();
  const active = session.source === "stream" && session.stream.playlist
    ? "search"
    : "local";
  return { ...restored, active };
}

const VisualizerStudioPanel = lazy(() => import("../composition/VisualizerStudioPanel"));

/**
 * 唯一的工作台。没有"下载板块"和"曲库板块"之分。
 *
 * 平时它就是曲库：左边固定本地来源导航，右边的统一舞台承载本地曲目、
 * 在线内容。本地曲库钉住时同时显示两块；否则新内容覆盖当前板块。
 * 详情 / 队列 / 账号等旁路面板仍按需在最右侧出现。
 * 真正把歌加入下载（按钮 / 拖进文件夹）时，才把右栏切成下载队列。
 *
 * 这么排的理由：找歌 → 下载 → 进曲库 → 排 set 本来就是一条线上的动作，
 * 搜的时候本地还在眼前，也不被队列面板打断。
 */
export function Workspace() {
  const rightRevealRevision = usePanelDock(state => state.rightRevealRevision);
  const rightHasPanels = usePanelDock(state => state.rightHasPanels);
  const panelPlacements = usePanelDock(state => state.placements);
  const compositionMode = useAppStore(state => state.compositionMode);
  const visualizerTrackOpen = useVisualizerStudioStore(state => state.track !== null);
  const inlineVisualizerSettings = useVisualizerStudioStore(state => state.inlineSettings);
  const setVisualizerSettingsTarget = useVisualizerStudioStore(state => state.setSettingsTarget);
  const liveVjOpen = compositionMode === "live-vj";
  const settings = useAppStore((state) => state.settings);
  const searchCapabilities = useAppStore((state) => state.searchCapabilities);
  const listMode = useAppStore((state) => state.listMode);
  const hasResults = useAppStore((state) => state.hasResults);
  const setHasResults = useAppStore((state) => state.setHasResults);
  const videoPipMode = useVideoPip((state) => state.mode);
  const videoPipSession = useVideoPip((state) => state.session);
  const setVideoPanelTarget = useVideoPip((state) => state.setPanelTarget);
  const showTrackDetail = useAppStore((state) => state.showTrackDetail);
  const showSettings = useAppStore((state) => state.showSettings);
  const expandedPanelId = usePanelViewport((state) => state.expandedPanelId);
  const settingsPanelEpoch = useAppStore((state) => state.settingsPanelEpoch);
  const showQueue = useAppStore((state) => state.showQueue);
  const queuePanelEpoch = useAppStore((state) => state.queuePanelEpoch);
  const showComposition = useAppStore((state) => state.showComposition);
  const [detailRestoreTarget, setDetailRestoreTarget] = useState<HTMLSpanElement | null>(null);
  const [panelIndexTarget, setPanelIndexTarget] = useState<HTMLSpanElement | null>(null);
  const showPreview = useAppStore((state) => state.showPreview);
  const previewPanelEpoch = useAppStore((state) => state.previewPanelEpoch);
  const showFolders = useAppStore((state) => state.showFolders);
  const foldersPanelEpoch = useAppStore((state) => state.foldersPanelEpoch);
  const showDuplicates = useAppStore((state) => state.showDuplicates);
  const duplicateFolders = useAppStore((state) => state.duplicateFolders);
  const duplicateAll = useAppStore((state) => state.duplicateAll);
  const duplicateIncludeSubfolders = useAppStore(
    (state) => state.duplicateIncludeSubfolders,
  );
  const duplicatesPanelEpoch = useAppStore((state) => state.duplicatesPanelEpoch);
  const showLyrics = useAppStore((state) => state.showLyrics);
  const lyricsPanelEpoch = useAppStore((state) => state.lyricsPanelEpoch);
  const toggleSettingsPanel = useAppStore((state) => state.toggleSettingsPanel);
  const songPreviewState = useSyncExternalStore(
    subscribeSongPreviewState,
    getSongPreviewState,
    getSongPreviewState,
  );
  const playerSession = useSyncExternalStore(
    subscribePlayerSession,
    getPlayerSession,
    getPlayerSession,
  );
  const previewPendingStatus =
    songPreviewState.phase === "resolving"
      ? "resolving"
      : songPreviewState.trackId === playerSession.trackId &&
          (playerSession.status === "resolving" ||
            playerSession.status === "loading" ||
            playerSession.status === "buffering")
        ? playerSession.status
        : null;
  const streamAccountKeys = useStreamBrowseStore((state) => state.accountKeys);
  const startupForeground = useStreamBrowseStore((state) => state.startupForeground);
  const { columns: layout, chrome, portrait } = useLayoutSignals();
  const panelWorkspace = useRef<HTMLDivElement | null>(null);
  const panelViewport = usePanelViewport();
  const panelsAtTop = panelViewport.narrow || panelViewport.compact;
  useResponsivePanels(panelWorkspace, layout === "narrow");

  const total = useLibraryStore((state) => state.total);
  const loading = useLibraryStore((state) => state.loading);
  const libError = useLibraryStore((state) => state.error);
  const filter = useLibraryStore((state) => state.filter);
  const selectedId = useLibraryStore((state) => state.selectedId);
  const selectedIds = useLibraryStore((state) => state.selectedIds);
  const selected = useLibraryStore(selectSelectedTrack);
  const refreshStats = useLibraryStore((state) => state.refreshStats);
  const refresh = useLibraryStore((state) => state.refresh);

  // 首次进来拉一次曲库；之后的刷新由筛选变化和 WS 事件驱动
  useEffect(() => {
    if (useLibraryStore.getState().orderedIds.length === 0) void refresh();
  }, [refresh]);

  const [query, setQuery] = useState("");
  const [searchKind, setSearchKind] = useState<SearchKind>("song");
  // 勾选与排序都进 settings.json：排序是 platform_priority，勾选是 search_platforms。
  // 未在设置里开启的源不能参与搜索勾选。
  const platforms = useMemo(() => {
    const selected = normalizeSearchPlatforms(settings?.search_platforms);
    return selected.filter((id) => isPlatformEnabled(settings, id));
  }, [settings]);
  const searchKinds = useMemo<readonly SearchKind[]>(() => {
    const order: SearchKind[] = ["song", "playlist", "artist", "album", "radio"];
    // 类型选择展示所有已选来源的能力并集。真正提交时再只请求支持该类型的来源，
    // 这样网易云在已选来源中时也会出现播客，不必先手动关掉其它平台。
    const supported = new Set<SearchKind>(["song"]);
    for (const platform of platforms) {
      for (const kind of searchCapabilities[platform] ?? ["song"]) supported.add(kind);
    }
    return order.filter((kind) => supported.has(kind));
  }, [platforms, searchCapabilities]);
  useEffect(() => {
    if (!searchKinds.includes(searchKind)) setSearchKind("song");
  }, [searchKind, searchKinds]);
  const saveSettings = useAppStore((state) => state.saveSettings);
  // 同曲跨平台聚合仍恒为开启；顶栏开关只负责给主列表腾出/还回搜索框高度。
  const merge = true;
  const topPanelsEnabled = useEffectiveTopPanels();
  const [aggregateSearchOpen, setAggregateSearchOpen] = useState(true);
  const [aggregateSearchRevealed, setAggregateSearchRevealed] = useState(true);
  const openAggregateSearch = useCallback(() => {
    const viewport = usePanelViewport.getState();
    if (viewport.compact) toggleResponsivePanel("kd-activity-panels:search");
    setAggregateSearchRevealed(false);
    setAggregateSearchOpen(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setAggregateSearchRevealed(true));
    });
  }, []);
  useEffect(() => {
    if (aggregateSearchOpen) {
      setAggregateSearchRevealed(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAggregateSearchRevealed(true));
      });
      return;
    }
    setAggregateSearchRevealed(false);
  }, [aggregateSearchOpen]);
  const [busy, setBusy] = useState(() => Boolean(startupForeground));
  const restoredLocalPanePinnedRef = useRef(
    readLocalStorage(LOCAL_PANE_PIN_KEY) === "1",
  );
  const restoredWorkspaceSessionRef = useRef(readWorkspaceSession());
  const [items, setItems] = useState<IntakeItem[] | null>(null);
  /** 从合集候选进入详情时保存上一页；返回只恢复这一次搜索现场。 */
  const [collectionSearchSnapshot, setCollectionSearchSnapshot] =
    useState<CollectionSearchSnapshot | null>(null);
  const [collectionPage, setCollectionPage] = useState(1);
  const [activeStreamPlaylist, setActiveStreamPlaylist] = useState<ActiveStreamPlaylist | null>(
    () => startupForeground
      ? {
          platform: startupForeground.playlist.platform as StreamBrowsePlatform,
          key: startupForeground.playlist.key,
        }
      : null,
  );
  const activeStreamPlaylistRef = useRef(activeStreamPlaylist);
  activeStreamPlaylistRef.current = activeStreamPlaylist;
  const [openedStreamPlaylist, setOpenedStreamPlaylist] = useState<StreamPlaylist | null>(
    () => startupForeground?.playlist ?? null,
  );
  const [removingStreamGroupIds, setRemovingStreamGroupIds] = useState<Set<string>>(
    new Set(),
  );
  const [inspectedOnlineGroup, setInspectedOnlineGroup] = useState<string | null>(null);
  /** 贴链接解析出来的那一个视频，置顶在结果列表最前面；关键词搜索会把它顶掉。 */
  const [video, setVideo] = useState<VideoInfo | null>(null);
  /**
   * 两处失败各有各的现场，所以分开显示：搜索失败要顶在结果列表的摘要位，
   * 入队失败要贴在「加入队列」旁边。
   */
  const [searchError, setSearchError] = useState("");
  const [queueError, setQueueError] = useState("");
  /** B 站批量下载的「只要音频」：入队时盖进来源 payload，后端据此下 m4a。 */
  const [videoAudioOnly, setVideoAudioOnly] = useState(false);
  const [folderDropError, setFolderDropError] = useState("");
  const [localDropActive, setLocalDropActive] = useState(false);
  const [searchDragActive, setSearchDragActive] = useState(() => Boolean(activeSearchDrag()));
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [searchSelectionMode, setSearchSelectionMode] = useState(false);
  const [loadingCollections, setLoadingCollections] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [collapsedItems, setCollapsedItems] = useState<Set<number>>(new Set());
  const [sourceIndex, setSourceIndex] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!activeStreamPlaylist) {
      setOpenedStreamPlaylist(null);
      setRemovingStreamGroupIds(new Set());
    }
  }, [activeStreamPlaylist]);
  /**
   * 两种列表共用同一套板块状态。钉住本地曲库时最多同时挂两块；未钉住只显示
   * 当前板块。切换只改变可见性，不卸载结果与排序偏好。
   */
  const [localPanePinned, setLocalPanePinned] = useState(
    () => restoredLocalPanePinnedRef.current,
  );
  const [temporaryLibrary, setTemporaryLibrary] = useState<TemporaryLibrary | null>(null);
  const temporarySelected = useStore(temporaryLibrary?.store ?? useLibraryStore, (state) => state.selectedTrack);
  const [workspacePaneState, setWorkspacePaneState] =
    useState<WorkspacePaneState>(loadWorkspacePanes);
  const [browseFocus, setBrowseFocus] = useState<MidiBrowseFocus>("pane");
  const browseFocusRef = useRef(browseFocus);
  browseFocusRef.current = browseFocus;
  const browseCursorIdRef = useRef<string | null>(null);
  useEffect(() => {
    writeLocalStorageNow(LOCAL_PANE_PIN_KEY, localPanePinned ? "1" : "0");
  }, [localPanePinned]);
  useEffect(() => {
    writeLocalStorageNow(WORKSPACE_PANES_KEY, JSON.stringify(workspacePaneState));
  }, [workspacePaneState]);
  const activateWorkspacePane = useCallback((kind: WorkspacePaneKind) => {
    setWorkspacePaneState((current) =>
      current.active === kind ? current : { ...current, active: kind },
    );
  }, []);
  const focusWorkspacePane = useCallback((kind: WorkspacePaneKind) => {
    if (kind === "local") setRestorableWorkspaceSource("local");
    else if (activeStreamPlaylist) setRestorableWorkspaceSource("stream");
    setWorkspacePaneState((current) =>
      current.active === kind ? current : { ...current, active: kind },
    );
  }, [activeStreamPlaylist]);
  const workspacePaneAvailability = useMemo(
    () => ({
      local: true,
      search: hasResults || temporaryLibrary !== null,
    }),
    [hasResults, temporaryLibrary],
  );
  const visiblePaneOrder = useMemo(
    () => visibleWorkspacePanes(
      workspacePaneState,
      localPanePinned && layout === "wide",
      workspacePaneAvailability,
    ),
    [layout, localPanePinned, workspacePaneAvailability, workspacePaneState],
  );
  const activeWorkspacePane = workspacePaneAvailability[workspacePaneState.active]
    ? workspacePaneState.active
    : visiblePaneOrder[0] ?? "local";
  // 不把“暂时尚未挂载”写回 active：在线内容会先切意图，再异步提供内容。
  // 单栏布局当前先安全显示本地页，目标内容一可用便自动成为唯一可见板块。
  const paneOrder = (kind: WorkspacePaneKind) =>
    Math.max(0, visiblePaneOrder.indexOf(kind)) * 2;
  const revealSearchPane = useCallback(() => {
    setTemporaryLibrary(null);
    activateWorkspacePane("search");
    setHasResults(true);
  }, [activateWorkspacePane, setHasResults]);
  const searchScrollRef = useRef<HTMLDivElement>(null);
  const openedCollection = useMemo(
    () => openedCollectionItem(items ?? []),
    [items],
  );
  const openedCollectionWindow = useMemo(
    () => {
      if (!openedCollection) return null;
      const total = openedStreamPlaylist?.platform === "bilibili"
        ? Math.max(openedCollection.groups.length, openedStreamPlaylist.count)
        : openedCollection.groups.length;
      return collectionPageWindow(total, collectionPage);
    },
    [collectionPage, openedCollection, openedStreamPlaylist],
  );
  const changeCollectionPage = useCallback((requestedPage: number) => {
    if (!openedCollection) return;
    const playlist = openedStreamPlaylist;
    const total = playlist?.platform === "bilibili"
      ? Math.max(openedCollection.groups.length, playlist.count)
      : openedCollection.groups.length;
    const window = collectionPageWindow(total, requestedPage);
    const scrollTop = () => requestAnimationFrame(() => {
      searchScrollRef.current?.scrollTo({ top: 0, left: 0 });
    });
    if (
      playlist?.platform !== "bilibili"
      || window.end <= openedCollection.groups.length
    ) {
      setCollectionPage(window.page);
      scrollTop();
      return;
    }

    const requestId = ++resultRequestSeqRef.current;
    setBusy(true);
    setSearchError("");
    void api
      .streamPlaylist(playlist, window.end)
      .then((response) => {
        if (requestId !== resultRequestSeqRef.current) return;
        const resolved = streamPlaylistItem(playlist, response);
        const reachedEnd = response.sources.length < window.end;
        const actualTotal = reachedEnd
          ? response.sources.length
          : Math.max(playlist.count, response.sources.length);
        setOpenedStreamPlaylist({ ...playlist, count: actualTotal });
        setItems([resolved]);
        setCollectionPage(collectionPageWindow(actualTotal, window.page).page);
        scrollTop();
      })
      .catch((error) => {
        if (requestId === resultRequestSeqRef.current) {
          setSearchError(`载入下一页失败：${errorText(error)}`);
        }
      })
      .finally(() => {
        if (requestId === resultRequestSeqRef.current) setBusy(false);
      });
  }, [openedCollection, openedStreamPlaylist]);
  const revealLoadedCollection = useCallback(() => {
    revealSearchPane();
    // 搜索面板可能刚从另一栏恢复；等它挂载并完成结果表布局后再回到新集合顶部。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => searchScrollRef.current?.scrollTo({ top: 0, left: 0 }));
    });
  }, [revealSearchPane]);
  const localPaneVisible = visiblePaneOrder.includes("local");
  const searchPaneVisible = visiblePaneOrder.includes("search");
  const [dragWorkspacePane, setDragWorkspacePane] = useState<WorkspacePaneKind | null>(null);
  const [workspacePaneDropTarget, setWorkspacePaneDropTarget] =
    useState<WorkspacePaneKind | null>(null);
  const reorderWorkspacePane = useCallback(
    (from: WorkspacePaneKind, target: WorkspacePaneKind) => {
      setWorkspacePaneState((current) => moveWorkspacePane(current, from, target));
    },
    [],
  );
  const workspacePaneGripProps = (kind: MovableWorkspacePaneKind) => ({
    draggable: true,
    "aria-label": `拖动${WORKSPACE_PANE_LABELS[kind]}板块调整位置`,
    title: `拖动调整${WORKSPACE_PANE_LABELS[kind]}板块位置`,
    onDragStart: (event: React.DragEvent) => {
      clearTextSelection();
      setDragWorkspacePane(kind);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-kdj-workspace-pane", kind);
      event.dataTransfer.setData("text/plain", kind);
    },
    onDragEnd: () => {
      setDragWorkspacePane(null);
      setWorkspacePaneDropTarget(null);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setWorkspacePaneState((current) => {
        const index = current.order.indexOf(kind);
        const target = current.order[index + (event.key === "ArrowLeft" ? -1 : 1)];
        return target ? moveWorkspacePane(current, kind, target) : current;
      });
    },
  });
  const workspacePaneAtEvent = (target: EventTarget | null): WorkspacePaneKind | null => {
    const value = (target as Element | null)
      ?.closest<HTMLElement>("[data-workspace-pane-kind]")
      ?.dataset.workspacePaneKind;
    return value === "local" || value === "search" ? value : null;
  };
  const onWorkspacePaneDragOverCapture = (event: React.DragEvent) => {
    if (!dragWorkspacePane) return;
    const target = workspacePaneAtEvent(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setWorkspacePaneDropTarget(target);
  };
  const onWorkspacePaneDropCapture = (event: React.DragEvent) => {
    if (!dragWorkspacePane) return;
    const target = workspacePaneAtEvent(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    reorderWorkspacePane(dragWorkspacePane, target);
    setDragWorkspacePane(null);
    setWorkspacePaneDropTarget(null);
  };
  /** 搜索、链接解析和侧栏云歌单共用结果区；只有最后一次请求可以落状态。 */
  const resultRequestSeqRef = useRef(0);
  const openTemporaryFolder = useCallback((folder: string) => {
    resultRequestSeqRef.current += 1;
    setBusy(false);
    setLoadingCollections(new Set());
    setActiveStreamPlaylist(null);
    setTemporaryLibrary(createTemporaryLibrary(folder));
    setLocalPanePinned(true);
    activateWorkspacePane("search");
    setRestorableWorkspaceSource("local");
  }, [activateWorkspacePane]);
  const temporaryFolderDrop = useTemporaryFolderDrop(openTemporaryFolder, layout === "wide");
  /** FolderTree 在远程歌单点击后还会调用 onNavigate；同一调用栈内不能清高亮。 */
  const streamOpenNavigationRef = useRef(false);
  const returnToCollectionSearch = useCallback(() => {
    if (!collectionSearchSnapshot) return;
    resultRequestSeqRef.current += 1;
    const snapshot = collectionSearchSnapshot;
    setItems(snapshot.items);
    setVideo(snapshot.video);
    setCollectionSearchSnapshot(null);
    setCollectionPage(1);
    setLoadingCollections(new Set());
    setChosen(new Set());
    setSearchSelectionMode(false);
    setCollapsedItems(new Set());
    setExpandedGroups(new Set());
    setSourceIndex({});
    setActiveStreamPlaylist(null);
    setInspectedOnlineGroup(null);
    updateStreamWorkspaceSession({
      playlist: null,
      accountKey: null,
      inspectedGroup: null,
      scrollTop: 0,
    });
    setRestorableWorkspaceSource("local");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        searchScrollRef.current?.scrollTo({
          top: snapshot.scrollTop,
          left: snapshot.scrollLeft,
        });
      });
    });
  }, [collectionSearchSnapshot]);

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
    setCollectionSearchSnapshot(null);
    setCollectionPage(1);
  }, [hasResults]);

  useEffect(() => {
    const onSearchDragState = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setSearchDragActive(Boolean(detail?.active));
      if (!detail?.active) {
        setLocalDropActive(false);
      }
    };
    window.addEventListener(SEARCH_DRAG_STATE_EVENT, onSearchDragState);
    return () => window.removeEventListener(SEARCH_DRAG_STATE_EVENT, onSearchDragState);
  }, []);

  useEffect(() => {
    /**
     * WKWebView 能开始原生拖动，却偶尔不把 drop 送给文件夹或队列。
     * dragend 仍有松手坐标：命中目标时直接完成操作。claim 闩锁会挡住
     * 随后迟到的原生 drop，确保同一次拖动只执行一次。
     */
    let lastDropPath = "";
    let lastQueueDrop = false;
    let lastCoverTrackId: number | null = null;
    let lastDeckDropSide: 0 | 1 | null = null;
    const rememberDropTargetUnderPointer = (event: DragEvent) => {
      // 某些 WKWebView 的 dragend 坐标会退回 0,0；持续记录最后一次 dragover
      // 命中的文件夹、当前曲目表、下载队列或封面框，同时在
      // 指针移出时清掉旧目标。
      lastDropPath = searchDropPathAt(event.clientX, event.clientY);
      lastQueueDrop = searchQueueDropAt(event.clientX, event.clientY);
      lastDeckDropSide = trackDeckDropSideAt(event.clientX, event.clientY);
      const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const cover = hit?.closest<HTMLElement>(`[${TRACK_COVER_DROP_TARGET_ATTR}]`);
      const id = cover ? Number(cover.dataset.kdTrackId) : NaN;
      lastCoverTrackId = Number.isFinite(id) ? id : null;
    };
    const onDragEndFallback = (event: DragEvent) => {
      const queueDrop = searchQueueDropAt(event.clientX, event.clientY) || lastQueueDrop;
      const dest = searchDropPathAt(event.clientX, event.clientY) || lastDropPath;
      const deckDropSide = trackDeckDropSideAt(event.clientX, event.clientY) ?? lastDeckDropSide;
      const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const cover = hit?.closest<HTMLElement>(`[${TRACK_COVER_DROP_TARGET_ATTR}]`);
      const currentCoverTrackId = cover ? Number(cover.dataset.kdTrackId) : NaN;
      const coverTrackId = Number.isFinite(currentCoverTrackId)
        ? currentCoverTrackId
        : lastCoverTrackId;
      lastDropPath = "";
      lastQueueDrop = false;
      lastCoverTrackId = null;
      lastDeckDropSide = null;

      // WKWebView 偶尔吞掉 Performance 波形上的原生 drop。在线来源不能伪装成
      // 曲库负 id；在 dragend 坐标兜底处把完整 SongSource 送到同一个 Deck 事件。
      if (deckDropSide !== null && activeSearchDrag()?.kind === "audio") {
        const source = searchAudioSource(claimActiveSearchDrag());
        if (source) dispatchStreamDeckDrop(source, deckDropSide);
        return;
      }

      // QueuePanel 的原生 drop 在 WKWebView 中也会偶发丢失。封面框同样需要
      // dragend 兜底，否则拖入已有歌曲时偶尔会变成“什么也没发生”。
      if (coverTrackId !== null && Number.isFinite(coverTrackId)) {
        const ids = claimActiveTrackDragIds();
        if (ids.length > 0) {
          dispatchTrackCoverDrop(ids, coverTrackId);
        }
        return;
      }

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
        const op = resolveLibraryPasteOp({ forceMove: event.altKey });
        void useLibraryStore
          .getState()
          .applyFolderOp(ids, dest, op)
          .then((result) => {
            const failed = Object.keys(result.errors).length;
            if (failed > 0) {
              const verb = op === "move" ? "移动" : "复制";
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
      void saveSettings({ search_platforms: next }).catch(() => undefined);
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
    revealSearchPane();
    const requestId = ++resultRequestSeqRef.current;
    setCollectionSearchSnapshot(null);
    setCollectionPage(1);
    setActiveStreamPlaylist(null);
    setInspectedOnlineGroup(null);
    updateStreamWorkspaceSession({
      playlist: null,
      accountKey: null,
      inspectedGroup: null,
      scrollTop: 0,
    });
    setRestorableWorkspaceSource("local");
    setLoadingCollections(new Set());

    // 单视频链接直接进入通用视频面板；B 站收藏夹与 YouTube 播放列表则交给
    // provider 展开成批量结果。music.youtube.com 始终留给 YTM 音乐来源。
    const directVideoPlatform =
      BILI_RE.test(text) && !BILI_FAVLIST_RE.test(text)
        ? "bilibili"
        : YOUTUBE_VIDEO_RE.test(text) &&
            !YOUTUBE_MUSIC_RE.test(text) &&
            !YOUTUBE_PLAYLIST_RE.test(text)
          ? "youtube"
          : null;
    if (directVideoPlatform) {
      setBusy(true);
      setSearchError("");
      setItems(null);
      setChosen(new Set());
      revealSearchPane();
      try {
        const info = await api.videoResolve(text, directVideoPlatform);
        if (requestId !== resultRequestSeqRef.current) return;
        setVideo(info);
      } catch (error) {
        if (requestId !== resultRequestSeqRef.current) return;
        setVideo(null);
        setSearchError(`解析失败：${errorText(error)}`);
      } finally {
        if (requestId === resultRequestSeqRef.current) setBusy(false);
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
    const requestedKind: SearchKind = platformsOverride ? "song" : searchKind;
    const orderedPlatforms = [...(platformsOverride ?? platforms)]
      .filter((id) => id !== "local")
      .sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
    // 链接由后端按 URL 自己识别类型（即使下拉框还停在“单曲”也能解析专辑）；
    // 关键词搜索则剥掉不支持所选类型的平台，保留其余来源继续返回结果。
    // 集合链接按域名补上唯一归属平台，避免用户刚好没勾该源时被其它 provider 误判。
    const isFavlistInput = BILI_FAVLIST_RE.test(text);
    const isYoutubePlaylist = YOUTUBE_VIDEO_RE.test(text) && !YOUTUBE_MUSIC_RE.test(text);
    const isYtmLink = YOUTUBE_MUSIC_RE.test(text);
    const isLinkInput = /https?:\/\//i.test(text);
    const requestPlatforms = isLinkInput
      ? ([...orderedPlatforms] as Platform[])
      : orderedPlatforms.filter((platform) =>
          (searchCapabilities[platform] ?? ["song"]).includes(requestedKind),
        );
    if (isFavlistInput && !requestPlatforms.includes("bilibili")) requestPlatforms.push("bilibili");
    if (isYoutubePlaylist && !requestPlatforms.includes("youtube")) requestPlatforms.push("youtube");
    if (isYtmLink && !requestPlatforms.includes("ytm")) requestPlatforms.push("ytm");
    if (requestPlatforms.length === 0) {
      setItems([]);
      revealSearchPane();
      setSearchError("当前勾选的来源都不支持这种搜索类型");
      setBusy(false);
      return;
    }
    try {
      // 单条也走 /intake：关键词、单曲链接、歌单链接是同一条路径，
      // 前端不必自己判断哪种输入该打哪个接口。
      const response = await api.intake({
        text,
        platforms: requestPlatforms,
        limit: 30,
        merge,
        max_entries: batch ? 50 : 1,
        kind: requestedKind,
      });
      if (requestId !== resultRequestSeqRef.current) return;
      setItems(response.items);
      revealSearchPane();
    } catch (error) {
      if (requestId !== resultRequestSeqRef.current) return;
      setItems([]);
      revealSearchPane();
      // 结果列表这时是空的，那条摘要位就腾出来写原因——
      // 另起一行会把列表顶下去，切来切去整块面板都在跳
      setSearchError(`处理失败：${errorText(error)}`);
    } finally {
      if (requestId === resultRequestSeqRef.current) setBusy(false);
    }
    // merge 是常量，不进依赖。
  }, [query, platforms, batch, searchKind, searchCapabilities, settings, revealSearchPane]);

  /**
   * 左侧平台歌单/收藏夹只是远程浏览入口：点开后复用搜索结果这张表和下载队列，
   * 不写本地曲库，也不恢复已经退役的 stream_library 持久化表。
   */
  const openStreamPlaylist = useCallback(async (
    playlist: StreamPlaylist,
    options: OpenStreamPlaylistOptions = {},
  ) => {
    const browsePlatform = STREAM_BROWSE_PLATFORMS.includes(
      playlist.platform as StreamBrowsePlatform,
    )
      ? (playlist.platform as StreamBrowsePlatform)
      : null;
    const currentAccountKey = browsePlatform
      ? useStreamBrowseStore.getState().accountKeys[browsePlatform]
      : null;
    setTemporaryLibrary(null);
    const revealTargetPane = () => {
      setHasResults(true);
      activateWorkspacePane("search");
    };
    const requestId = ++resultRequestSeqRef.current;
    setCollectionSearchSnapshot(null);
    setCollectionPage(1);
    streamOpenNavigationRef.current = true;
    queueMicrotask(() => {
      streamOpenNavigationRef.current = false;
    });
    setRestorableWorkspaceSource("stream");
    updateStreamWorkspaceSession({
      playlist,
      accountKey: currentAccountKey,
      inspectedGroup: null,
      scrollTop: 0,
    });
    setBusy(true);
    setVideo(null);
    setItems(null);
    setChosen(new Set());
    setSearchSelectionMode(false);
    setExpandedGroups(new Set());
    setCollapsedItems(new Set());
    setSourceIndex({});
    setInspectedOnlineGroup(null);
    setLoadingCollections(new Set());
    setSearchError("");
    setOpenedStreamPlaylist(playlist);
    revealTargetPane();
    if (browsePlatform) {
      const active = { platform: browsePlatform, key: playlist.key } as const;
      setActiveStreamPlaylist(active);
      useStreamBrowseStore.getState().setActive(active);
    }
    try {
      // B 站收藏夹每页只有 20 条；初次只取够当前 UI 页的数量。后续翻页由
      // provider 的累计缓存补齐，不能因为点开 800 条收藏夹就立刻扫完整站列表。
      const initialLimit = playlist.platform === "bilibili"
        ? RESOLVED_COLLECTION_PAGE_SIZE
        : 0;
      const response = options.startup
        ? await loadForegroundStreamOnce(
            options.startup,
            () => api.streamPlaylist(playlist, initialLimit),
          )
        : await api.streamPlaylist(playlist, initialLimit);
      if (requestId !== resultRequestSeqRef.current) return false;
      if (
        browsePlatform &&
        useStreamBrowseStore.getState().accountKeys[browsePlatform] !== currentAccountKey
      ) {
        // 请求发出后登出/换号：旧账号迟到的私人歌单绝不能落到新账号页面。
        return false;
      }
      const resolved = streamPlaylistItem(playlist, response);
      const resolvedPlaylist = playlist.platform === "bilibili"
        && initialLimit > 0
        && response.sources.length < initialLimit
        ? { ...playlist, count: response.sources.length }
        : playlist;
      setOpenedStreamPlaylist(resolvedPlaylist);
      setInspectedOnlineGroup(null);
      updateStreamWorkspaceSession({
        accountKey: currentAccountKey,
        inspectedGroup: null,
      });
      setItems([resolved]);
      if (browsePlatform) {
        const active = { platform: browsePlatform, key: playlist.key } as const;
        setActiveStreamPlaylist(active);
        useStreamBrowseStore.getState().setActive(active);
      }
      if (options.startup) {
        const top = restoredWorkspaceSessionRef.current.stream.scrollTop;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => searchScrollRef.current?.scrollTo({ top, left: 0 }));
        });
      }
      return true;
    } catch (error) {
      if (requestId !== resultRequestSeqRef.current) return false;
      const message = errorText(error);
      if (options.startup) {
        // A startup provider failure must not erase the trusted directory cache or the user's
        // restorable target. Keep the online pane in place so an explicit retry remains possible.
        setItems([]);
        setSearchError(`打开歌单失败：${message}`);
        return false;
      }
      setItems([]);
      setActiveStreamPlaylist(null);
      setOpenedStreamPlaylist(null);
      updateStreamWorkspaceSession({
        playlist: null,
        accountKey: null,
        inspectedGroup: null,
        scrollTop: 0,
      });
      setRestorableWorkspaceSource("local");
      activateWorkspacePane("local");
      setSearchError(`打开歌单失败：${message}`);
      throw error;
    } finally {
      if (requestId === resultRequestSeqRef.current) setBusy(false);
    }
  }, [activateWorkspacePane, setHasResults]);

  const openStreamPlaylistFromUser = useCallback(async (playlist: StreamPlaylist) => {
    await openStreamPlaylist(playlist);
  }, [openStreamPlaylist]);

  const removeStreamGroup = useCallback(async (
    group: MergedGroup,
    requestedSourceIndex: number,
  ) => {
    const playlist = openedStreamPlaylist;
    if (!playlist || !matchesEditableStreamOrigin(playlist.origin)) return;
    const source = group.sources[requestedSourceIndex] ?? group.sources[0];
    if (!source || source.platform !== playlist.platform) {
      setSearchError("移除失败：歌曲来源与当前歌单不一致");
      return;
    }
    const groupId = group.group_id;
    if (removingStreamGroupIds.has(groupId)) return;
    const viewRequestId = resultRequestSeqRef.current;
    setRemovingStreamGroupIds((current) => new Set(current).add(groupId));
    setSearchError("");
    try {
      const response = await api.removeStreamPlaylistTrack(playlist, source);
      if (!response.removed) throw new Error("平台没有确认移除成功");
      // 写响应已经确认成功，当前列表与数量直接在本地收敛；不再额外刷新平台目录。
      // 用户可能在平台响应前切走，旧歌单状态不能写进当前新页面。
      const active = activeStreamPlaylistRef.current;
      if (
        resultRequestSeqRef.current !== viewRequestId ||
        active?.platform !== playlist.platform ||
        active.key !== playlist.key
      ) return;
      setItems((current) => {
        if (!current) return current;
        const next = current.map((item) => ({
          ...item,
          groups: item.groups.filter((candidate) => candidate.group_id !== groupId),
        }));
        return next;
      });
      setChosen(new Set());
      setSearchSelectionMode(false);
      const removedGroupKey = selectionKey(0, groupId);
      const nextPlaylist = {
        ...playlist,
        count: Math.max(0, playlist.count - 1),
      };
      setOpenedStreamPlaylist(nextPlaylist);
      if (inspectedOnlineGroup === removedGroupKey) {
        setInspectedOnlineGroup(null);
        updateStreamWorkspaceSession({
          playlist: nextPlaylist,
          inspectedGroup: null,
        });
      } else {
        updateStreamWorkspaceSession({ playlist: nextPlaylist });
      }
    } catch (error) {
      const active = activeStreamPlaylistRef.current;
      if (
        resultRequestSeqRef.current === viewRequestId &&
        active?.platform === playlist.platform &&
        active.key === playlist.key
      ) {
        setSearchError(`移除失败：${errorText(error)}`);
      }
    } finally {
      setRemovingStreamGroupIds((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
    }
  }, [inspectedOnlineGroup, openedStreamPlaylist, removingStreamGroupIds]);

  const removeStreamGroupLabel = openedStreamPlaylist?.origin === "favorite"
    ? "从收藏中移除"
    : openedStreamPlaylist?.origin === "created"
      ? "从此歌单中移除"
      : undefined;

  const restoredWorkspaceAppliedRef = useRef(false);
  useEffect(() => {
    if (restoredWorkspaceAppliedRef.current) return;
    restoredWorkspaceAppliedRef.current = true;
    const session = restoredWorkspaceSessionRef.current;
    if (startupForeground) {
      setRestorableWorkspaceSource("stream");
      activateWorkspacePane("search");
      void openStreamPlaylist(startupForeground.playlist, {
        startup: startupForeground,
      });
      return;
    }
    setRestorableWorkspaceSource("local");
    activateWorkspacePane("local");
    if (session.local.selectedId !== null) {
      void (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const library = useLibraryStore.getState();
          if (!library.loading && library.orderedIds.length > 0) break;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        const trackId = session.local.selectedId as number;
        await useLibraryStore.getState().ensureTrackLoaded(trackId);
        if (!useLibraryStore.getState().indexById.has(trackId)) {
          useLibraryStore.getState().select(null);
          updateLocalWorkspaceSession({ selectedId: null, scrollTop: 0 });
        }
      })();
    }
  }, [activateWorkspacePane, openStreamPlaylist, startupForeground]);

  // 登出或换号时立即撤下已经展开的私人在线内容；重新登录后也必须由用户再点歌单。
  useEffect(() => {
    const session = readWorkspaceSession();
    const desired = session.stream;
    if (!desired.playlist) return;
    const platform = desired.playlist.platform as StreamBrowsePlatform;
    const currentAccountKey = streamAccountKeys[platform];
    if (
      currentAccountKey &&
      (!desired.accountKey || desired.accountKey === currentAccountKey)
    ) return;

    resultRequestSeqRef.current += 1;
    setBusy(false);
    setItems([]);
    if (currentAccountKey && desired.accountKey !== currentAccountKey) {
      setSearchError("当前登录账号与上次在线页面不同，已停止显示上一账号的内容");
    } else {
      setSearchError("");
    }
  }, [activeStreamPlaylist, streamAccountKeys]);

  /* ------------------------------------------------------------ 布局档位 */
  // columns：wide 展开旁路栏，narrow 只收右侧旁路。
  // chrome：inline 一行搜索，stacked 竖屏两段式——见 useLayoutMode。
  // 文件夹导航在所有尺寸都常驻；竖屏只收成窄轨，避免手机状态下失去入口。
  const showTree = true;
  // 竖屏侧栏展开状态要固化：用户拖宽/展开后点文件夹不该再弹回窄轨。
  // 桌面（非竖屏）恒从展开起步（与旧版一致），持久化只服务竖屏；
  // 否则桌面启动会先渲染一帧窄轨再被下面的 effect 撑开。
  const [compactTreeExpanded, setCompactTreeExpanded] = useState(() => {
    if (!portrait) return true;
    const saved = readLocalStorage("kd-compact-tree-expanded");
    if (saved !== null) return saved === "1";
    return false;
  });
  const previousCompactTreePortraitRef = useRef(portrait);
  useEffect(() => {
    const previousPortrait = previousCompactTreePortraitRef.current;
    previousCompactTreePortraitRef.current = portrait;

    // 桌面与竖屏共用组件状态，但只有竖屏拥有持久偏好。布局刚切换时先恢复
    // 目标布局的状态并跳过本轮写入，避免桌面的展开值覆盖手机保存值。
    if (portrait !== previousPortrait) {
      if (portrait) {
        const saved = readLocalStorage("kd-compact-tree-expanded");
        setCompactTreeExpanded(saved === null ? false : saved === "1");
      } else {
        setCompactTreeExpanded(true);
      }
      return;
    }
    if (portrait) {
      writeLocalStorageNow("kd-compact-tree-expanded", compactTreeExpanded ? "1" : "0");
    }
  }, [compactTreeExpanded, portrait]);
  const workspacePaneSizeKey = portrait
    ? "kd-workspace-pane-sizes-portrait-v2"
    : "kd-workspace-pane-sizes-regular-v2";
  const defaultWorkspacePaneWeights = useMemo<WorkspacePaneWeights>(
    () =>
      portrait
        ? { local: 8, search: 92 }
        : { local: 1, search: 1 },
    [portrait],
  );
  const [workspacePaneWeights, setWorkspacePaneWeights] =
    useState<WorkspacePaneWeights>(defaultWorkspacePaneWeights);
  const workspacePaneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const saved = storedJson(workspacePaneSizeKey);
    if (saved && typeof saved === "object") {
      const value = saved as Partial<WorkspacePaneWeights>;
      if (
        Number.isFinite(value.local) && Number(value.local) > 0 &&
        Number.isFinite(value.search) && Number(value.search) > 0
      ) {
        setWorkspacePaneWeights({
          local: Number(value.local),
          search: Number(value.search),
        });
        return;
      }
    }

    // 旧版只保存“本地 / 另一块”的百分比；迁移成按板块身份保存的权重。
    const oldPercent = Number(
      readLocalStorage(
        portrait ? "kd-search-split-portrait" : "kd-search-split-regular",
      ),
    );
    if (Number.isFinite(oldPercent) && oldPercent > 0 && oldPercent < 100) {
      setWorkspacePaneWeights({
        local: oldPercent,
        search: 100 - oldPercent,
      });
      return;
    }
    setWorkspacePaneWeights(defaultWorkspacePaneWeights);
  }, [defaultWorkspacePaneWeights, portrait, workspacePaneSizeKey]);
  const visiblePaneFractions = normalizedWorkspacePaneFractions(
    visiblePaneOrder,
    workspacePaneWeights,
  );
  const workspacePaneGridTemplate = visiblePaneOrder
    .map((_, index) => `minmax(4rem, ${visiblePaneFractions[index]}fr)`)
    .join(" 1px ");
  const persistWorkspacePaneWeights = (weights: WorkspacePaneWeights) => {
    writeLocalStorageNow(workspacePaneSizeKey, JSON.stringify(weights));
  };
  const startWorkspacePaneResize =
    (left: WorkspacePaneKind, right: WorkspacePaneKind) =>
    (event: React.PointerEvent) => {
      const host = workspacePaneRef.current;
      if (!host) return;
      const leftPane = host.querySelector<HTMLElement>(
        `[data-workspace-pane-kind="${left}"]`,
      );
      const rightPane = host.querySelector<HTMLElement>(
        `[data-workspace-pane-kind="${right}"]`,
      );
      if (!leftPane || !rightPane) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const leftWidth = leftPane.getBoundingClientRect().width;
      const rightWidth = rightPane.getBoundingClientRect().width;
      const pairWidth = leftWidth + rightWidth;
      const pairWeight = workspacePaneWeights[left] + workspacePaneWeights[right];
      if (pairWidth <= 0 || pairWeight <= 0) return;
      const minWidth = Math.min(portrait ? 48 : 96, pairWidth * 0.42);
      const weightsAt = (clientX: number): WorkspacePaneWeights => {
        const nextLeftWidth = Math.min(
          pairWidth - minWidth,
          Math.max(minWidth, leftWidth + clientX - startX),
        );
        const nextLeftWeight = pairWeight * (nextLeftWidth / pairWidth);
        return {
          ...workspacePaneWeights,
          [left]: nextLeftWeight,
          [right]: pairWeight - nextLeftWeight,
        };
      };
      const onMove = (move: PointerEvent) => {
        setWorkspacePaneWeights(weightsAt(move.clientX));
      };
      const onUp = (up: PointerEvent) => {
        const final = weightsAt(up.clientX);
        setWorkspacePaneWeights(final);
        persistWorkspacePaneWeights(final);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
  const resetWorkspacePaneSizes = () => {
    setWorkspacePaneWeights(defaultWorkspacePaneWeights);
    persistWorkspacePaneWeights(defaultWorkspacePaneWeights);
  };
  /** 当前拉开的是哪个抽屉。null = 都收着。 */
  const [sheet, setSheet] = useState<"aside" | null>(null);
  /** 搜索提示是临时旁路：不写导航/设置，关闭后可回到原先钉住的详情。 */
  const [showSearchTips, setShowSearchTips] = useState(false);
  useEffect(() => {
    if (!showSearchTips) return;
    const dismissOnOtherPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          ".kd-search-tip-action, .kd-split-aside, .kd-sheet",
        )
      ) return;
      setShowSearchTips(false);
    };
    window.addEventListener("pointerdown", dismissOnOtherPointer, true);
    return () => window.removeEventListener("pointerdown", dismissOnOtherPointer, true);
  }, [showSearchTips]);
  /** 锁定只拦横屏里由歌曲/视频触发的自动展开；显式入口会解除锁定并强制打开。 */
  const [asideLocked, setAsideLocked] = useState(false);
  const asideLockedRef = useRef(false);
  useEffect(() => {
    asideLockedRef.current = asideLocked;
  }, [asideLocked]);
  /** 右栏只承载显式打开的当前操作，不跟随普通选歌弹出。 */
  const [detailPinned, setDetailPinned] = useState(true);
  const [detailAction, setDetailAction] = useState<"playback" | "metadata">("playback");
  useEffect(() => {
    if (!Object.values(panelPlacements).some(item => item?.side === "right")) return;
    setDetailPinned(true);
  }, [panelPlacements]);
  const handledRightReveal = useRef(0);
  useEffect(() => {
    if (rightRevealRevision === handledRightReveal.current) return;
    handledRightReveal.current = rightRevealRevision;
    setAsideLocked(false);
    setDetailPinned(true);
    setDetailAction("playback");
    const viewport = usePanelViewport.getState();
    if (layout === "narrow" && !viewport.narrow && !viewport.compact) setSheet("aside");
  }, [rightRevealRevision, layout]);
  const [metadataTrack, setMetadataTrack] = useState<Track | null>(null);
  const [asideTrackId, setAsideTrackId] = useState<number | null>(null);
  /** 未固定详情的最后一个明确目标；列表换页时 selected 会短暂消失，目标对象不能跟着丢。 */
  const asideTrackSnapshotRef = useRef<Track | null>(null);

  const pinTrackAside = useCallback(
    (trackId?: number) => {
      setDetailPinned(true);
      setDetailAction("playback");
      const currentPlaying = getPlayingTrack();
      const targetId =
        trackId ?? selectSelectedTrack(useLibraryStore.getState())?.id ?? currentPlaying?.id ?? null;
      const library = useLibraryStore.getState();
      const selectedTarget = temporaryLibrary?.store.getState().selectedTrack?.id === targetId
        ? temporaryLibrary.store.getState().selectedTrack
        : selectSelectedTrack(library);
      const target = resolveWorkspaceRequestedTrack(
        targetId,
        currentPlaying,
        selectedTarget,
        targetId !== null ? streamTrackById(targetId) : null,
        asideTrackSnapshotRef.current,
      );
      asideTrackSnapshotRef.current = target;
      setAsideTrackId(targetId);
      showTrackDetail();
    },
    [showTrackDetail, temporaryLibrary],
  );

  const selectTrack = useCallback(
    (id: number, mode: SelectMode, _clickCount = 1, libraryStore: LibraryPaneStoreApi = useLibraryStore) => {
      libraryStore.getState().select(id, mode);
      // Selection belongs to the list; surrounding panels follow the loaded deck.
    },
    [],
  );

  useEffect(() => {
    const sidebarItems = () =>
      [...document.querySelectorAll<HTMLElement>(`.kd-tree-slot [${MIDI_BROWSE_ITEM_ATTR}]`)];
    const markSidebarCursor = (items: HTMLElement[], index: number) => {
      items.forEach((item, itemIndex) => {
        if (itemIndex === index) item.setAttribute(MIDI_BROWSE_CURSOR_ATTR, "true");
        else item.removeAttribute(MIDI_BROWSE_CURSOR_ATTR);
      });
    };
    const revealSidebarCursor = (id: string | null) => {
      const items = sidebarItems();
      const index = currentBrowseIndex(items, id);
      if (index < 0) return;
      markSidebarCursor(items, index);
      items[index]?.scrollIntoView({ block: "center" });
    };
    const stepSidebar = (delta: number) => {
      const items = sidebarItems();
      if (items.length === 0) return;
      const current = currentBrowseIndex(items, browseCursorIdRef.current);
      const next = nextBrowseIndex(items.length, current, delta);
      const target = items[next];
      if (!target) return;
      browseCursorIdRef.current = target.getAttribute(MIDI_BROWSE_ID_ATTR);
      markSidebarCursor(items, next);
      activateBrowseItem(target);
      requestAnimationFrame(() => revealSidebarCursor(browseCursorIdRef.current));
    };
    const stepPane = (delta: number) => {
      const store = activeWorkspacePane === "search" && temporaryLibrary ? temporaryLibrary.store : useLibraryStore;
      const library = store.getState();
      const current = library.selectedId === null ? -1 : (library.indexById.get(library.selectedId) ?? -1);
      const next = nextBrowseIndex(library.orderedIds.length, current, delta);
      const trackId = library.orderedIds[next];
      if (trackId === undefined) return;
      selectTrack(trackId, "replace", 1, store);
      window.dispatchEvent(new CustomEvent(DETAIL_EVENT, {
        detail: { source: "midi-browse", trackId },
      }));
    };
    const stepSearchPane = (delta: number) => {
      if (temporaryLibrary) { stepPane(delta); return; }
      const rows = [
        ...document.querySelectorAll<HTMLTableRowElement>(
          '.kd-workspace-pane-remote[data-pane-active="true"] tr[data-kd-search-result]',
        ),
      ];
      const current = rows.findIndex((row) => row.dataset.inspected === "true");
      const next = nextBrowseIndex(rows.length, current, delta);
      const row = rows[next];
      if (!row) return;
      row.click();
      requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
    };
    const playableSelection = () => {
      return activeWorkspacePane === "search" && temporaryLibrary
        ? temporaryLibrary.store.getState().selectedTrack
        : selectSelectedTrack(useLibraryStore.getState());
    };
    const onBrowse = (event: Event) => {
      const detail = (event as CustomEvent<MidiBrowseDetail>).detail;
      if (!detail) return;
      if (detail.type === "step") {
        if (browseFocusRef.current === "sidebar") stepSidebar(detail.delta);
        else stepPane(detail.delta);
        return;
      }
      if (detail.type === "press") {
        const next = toggleBrowseFocus(browseFocusRef.current);
        if (next === "pane") {
          const hint = sidebarItems().find(
            (item) => item.getAttribute(MIDI_BROWSE_ID_ATTR) === browseCursorIdRef.current
              || item.getAttribute(MIDI_BROWSE_CURSOR_ATTR) === "true",
          )?.getAttribute(MIDI_BROWSE_PANE_ATTR);
          activateWorkspacePane(paneForSidebarHint(hint ?? undefined));
        }
        browseFocusRef.current = next;
        setBrowseFocus(next);
        return;
      }
      const track = playableSelection();
      if (!track) return;
      window.dispatchEvent(new CustomEvent(MIDI_LOAD_DECK_EVENT, { detail: { side: detail.deck, track } }));
    };
    const onArrowKeyListStep = (event: Event) => {
      const detail = (event as CustomEvent<ArrowKeyListStepDetail>).detail;
      if (!detail || (detail.delta !== -1 && detail.delta !== 1)) return;
      if (activeWorkspacePane === "search") stepSearchPane(detail.delta);
      else stepPane(detail.delta);
    };
    window.addEventListener(MIDI_BROWSE_EVENT, onBrowse);
    window.addEventListener(ARROW_KEY_LIST_STEP_EVENT, onArrowKeyListStep);
    return () => {
      window.removeEventListener(MIDI_BROWSE_EVENT, onBrowse);
      window.removeEventListener(ARROW_KEY_LIST_STEP_EVENT, onArrowKeyListStep);
    };
  }, [activateWorkspacePane, activeWorkspacePane, selectTrack, temporaryLibrary]);

  /**
   * 在线结果单击只建立一个可供详情栏读取的元数据快照，不解析直链、也不换主唱盘。
   * 双击播放仍由结果行走 songPreview；这和本地表格“单击查看、双击播放”一致。
   */
  const inspectOnlineGroup = useCallback(
    (group: MergedGroup, requestedSourceIndex: number, groupKey: string) => {
      setInspectedOnlineGroup(groupKey);
      if (activeStreamPlaylist) {
        updateStreamWorkspaceSession({ inspectedGroup: groupKey });
      }
      const requested = group.sources[requestedSourceIndex] ?? group.sources[0];
      const source =
        requested?.platform !== "local" && requested?.platform !== "bilibili"
          ? requested
          : group.sources.find(
              (candidate) =>
                candidate.platform !== "local" && candidate.platform !== "bilibili",
            );
      if (!source) return;
      const track = makePendingSongStreamTrack({
        ...source,
        title: group.title || source.title,
        artists: group.artists.length > 0 ? group.artists : source.artists,
        album: group.album || source.album,
        duration: group.duration ?? source.duration,
        cover: group.cover || source.cover,
      });
      asideTrackSnapshotRef.current = track;
      setAsideTrackId(track.id);
    },
    [activeStreamPlaylist],
  );

  /**
   * 「正在播」跳转自己切的标签，不该被下面"换标签收抽屉"的 effect 误伤——
   * 只有这一次的 listMode 变化要放行抽屉，所以立个一次性记号。
   */
  const detailJumpRef = useRef(false);
  const previewJumpRef = useRef(false);
  useEffect(() => {
    const onDetail = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; trackId?: number }>).detail;
      const source = detail?.source;
      const isLocatePlaying = source === "locate-playing";
      const explicitLocate = source === "player-deck" || source === "visualizer" || isLocatePlaying;
      // Browsing and automatic notifications only refresh selection facts.
      if (!explicitLocate) {
        if (detail?.trackId !== undefined) setAsideTrackId(detail.trackId);
        return;
      }
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
      pinTrackAside(
        detail?.trackId ?? (source === "player-deck" ? getPlayingTrack()?.id : undefined),
      );
      const viewport = usePanelViewport.getState();
      if (viewport.narrow && source === "player-deck") viewport.toggleSongPanel();
      else if (viewport.compact) toggleResponsivePanel(`kd-activity-panels:${source === "visualizer" ? "visualizer" : "information"}`);
      else if (layout === "narrow" && !viewport.narrow) setSheet("aside");
    };
    window.addEventListener(DETAIL_EVENT, onDetail);
    return () => window.removeEventListener(DETAIL_EVENT, onDetail);
  }, [layout, pinTrackAside, portrait, showTrackDetail]);

  // 歌词属于当前播放操作，不改变顶部的选择预览。
  useEffect(() => {
    if (!showLyrics) return;
    const track = getPlayingTrack();
    if (!track || !hasVisibleLyrics(useLyricsStore.getState().get(track.id).lines)) return;
    setAsideLocked(false);
    setDetailPinned(true);
    setDetailAction("playback");
    const viewport = usePanelViewport.getState();
    if (viewport.narrow) viewport.revealSongPanel();
    else if (viewport.compact) toggleResponsivePanel("kd-activity-panels:lyrics");
    else if (layout === "narrow" && !viewport.narrow) setSheet("aside");
  }, [showLyrics, lyricsPanelEpoch]);

  // 关闭侧栏或切到其他面板时结束网络预览，不能留下隐藏的原生播放器或音频。
  useEffect(() => {
    if (!showPreview && videoPipMode === "panel" && videoPipSession?.source === "network") {
      useVideoPip.getState().clear();
    }
  }, [showPreview, videoPipMode, videoPipSession]);

  // 右栏那份内容只写一遍，宽屏塞进 <aside>、窄屏塞进抽屉——
  // 写两份的话，以后加一种面板必然漏改一处
  // 下载队列只在显式打开 / 真正入队时出现；搜索半栏另看 hasResults。
  // 歌曲试听走主播放条；网络视频在预览侧栏中使用同一个视频宿主。
  // 空闲不挂「选一首看详情」占位——没旁路内容时右栏整块消失。
  // 右栏从内容区顶部开始，与分析、EQ 和列表并排分配宽度。
  const previewAside = showPreview && videoPipMode === "panel" && videoPipSession?.source === "network";
  const realOverlayAside =
    showQueue ||
    showSearchTips ||
    showFolders ||
    showDuplicates ||
    previewAside;
  // Preview retains its selection snapshot while pages load; playback never becomes its fallback.
  const renderedAsideTrackId = asideTrackId;

  const registeredAsideTrack =
    renderedAsideTrackId !== null ? streamTrackById(renderedAsideTrackId) : null;
  const requestedDetailTrack = resolveWorkspaceRequestedTrack(
    renderedAsideTrackId,
    null,
    temporarySelected?.id === renderedAsideTrackId ? temporarySelected : selected,
    registeredAsideTrack,
    asideTrackSnapshotRef.current,
  );
  if (requestedDetailTrack !== null) asideTrackSnapshotRef.current = requestedDetailTrack;
  // The library clears selectedTrack while fetching details. Keep the painted snapshot until
  // the requested record arrives, instead of unmounting four cards for a blank intermediate frame.
  const detailTrack = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const trackDetailPanel = detailAction === "metadata" && metadataTrack
    ? <TrackDetail track={metadataTrack.id === detailTrack?.id ? detailTrack : metadataTrack}
        mode="metadata" onUpdated={setMetadataTrack} restoreTarget={detailRestoreTarget} />
    : null;
  const aggregateSearch = (inDetail: boolean) => (
    <SearchBar
      query={query}
      presetTrack={temporaryLibrary ? temporarySelected : selected}
      playingTrack={detailTrack}
      searchKind={searchKind}
      searchKinds={searchKinds}
      onSearchKindChange={setSearchKind}
      onQueryChange={setQuery}
      batch={batch}
      busy={busy}
      onSubmit={() => void submit()}
      tipsOpen={showSearchTips}
      onTips={toggleSearchTipsPanel}
      burstNonce={searchBurstNonce}
      burstTone={searchBurstTone}
      platforms={platforms}
      onTogglePlatform={togglePlatform}
      presentation={inDetail ? "detail" : "bar"}
      stacked={inDetail || chrome === "stacked"}
    />
  );
  // Configured right-side panels stay visible even after a temporary overlay closes.
  const detailAside =
    !realOverlayAside && (detailPinned || (!panelsAtTop && rightHasPanels));
  // Keep the aside shell mounted while the next selected track is loading. Only its content
  // changes; remounting the shell would replay the entrance animation on every selection.
  const editorAsideOpen = showComposition || visualizerTrackOpen;
  const hasAsideContent = showSettings || expandedPanelId !== null || editorAsideOpen || realOverlayAside
    || (detailAside && (detailAction !== "playback" || (!panelsAtTop && rightHasPanels)));
  const showAside = layout === "wide" && hasAsideContent;

  const closeAside = useCallback(() => {
    if (showSearchTips) {
      setShowSearchTips(false);
      setSheet(null);
      return;
    }
    setDetailPinned(false);
    setDetailAction("playback");
    setSheet(null);
    useAppStore.getState().dismissOverlay();
  }, [showSearchTips]);

  const closeAsideForUser = useCallback(() => {
    if (useAppStore.getState().showComposition) {
      void useWorkshopStore.getState().flush().then(() => useAppStore.setState({ showComposition: false }))
        .catch(error => useWorkshopStore.setState({ error: String(error) }));
      return;
    }
    const activeEditor = useVisualizerStudioStore.getState();
    if (activeEditor.track) {
      if (activeEditor.beforeClose) void activeEditor.beforeClose(); else activeEditor.close();
      return;
    }
    const finish = () => {
      // 提示只是在当前内容上临时盖一层；关提示不应把原详情也锁住。
      if (!showSearchTips) setAsideLocked(true);
      closeAside();
    };
    finish();
  }, [closeAside, showSearchTips]);

  /** 窄屏：点左侧文件夹后只收右侧详情抽屉；左侧展开宽度由用户拖动手势决定并持久化。 */
  const onFolderNavigate = useCallback(() => {
    if (streamOpenNavigationRef.current) {
      // 在线歌单已经把唯一板块切到 search；侧栏的通用 navigate 回调不能再抢回 local。
      if (layout === "narrow") closeAside();
      return;
    }
    setActiveStreamPlaylist(null);
    setRestorableWorkspaceSource("local");
    activateWorkspacePane("local");
    if (layout === "narrow") closeAside();
  }, [activateWorkspacePane, layout, closeAside]);

  const playbackPanel = <PlaybackPanel indexTarget={panelIndexTarget}
    searchOpen={aggregateSearchOpen} renderSearch={() => aggregateSearch(true)} />;

  const [workshopToolbarTarget, setWorkshopToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [workshopBackTarget, setWorkshopBackTarget] = useState<HTMLSpanElement | null>(null);
  const detailAsideTools = detailAside || previewAside ? (
    <>
      <span className="kd-detail-restore-tools" ref={setDetailRestoreTarget} />
    </>
  ) : null;
  const asideTools = detailAsideTools;

  const asideLabel = showSearchTips
    ? "使用提示"
    : showQueue
      ? "下载"
    : showFolders
      ? "文件夹"
      : showDuplicates
          ? "曲库优化分析"
        : previewAside
          ? "预览"
            : detailAside
              ? detailAction === "metadata" ? "曲目信息编辑" : "详情"
              : "";
  const workshopBackSlot = asideLabel === "曲目信息编辑"
    ? <button type="button" className="kd-aside-head-close" aria-label="返回详情" title="返回详情"
        onClick={() => setDetailAction("playback")}><ArrowLeft size={14} /></button>
    : null;
  const selectVideoMode = (mode: "workshop" | "live-vj") => {
    void (async () => {
      const editor = useVisualizerStudioStore.getState();
      if (editor.track) {
        if (editor.beforeClose) { if (!await editor.beforeClose()) return; }
        else editor.close();
      }
      await useWorkshopStore.getState().flush();
      const app = useAppStore.getState();
      if (app.showComposition && app.compositionMode === mode) {
        useAppStore.setState({ showComposition: false });
        return;
      }
      if (mode === "live-vj") app.openLiveVjPanel();
      else app.openCompositionPanel();
    })().catch(error => useWorkshopStore.setState({error: String(error)}));
  };
  const asidePanel = showSearchTips ? (
    <SearchTipsPanel />
  ) : showFolders ? (
    <FolderTree
      onNavigate={onFolderNavigate}
      onOpenStreamPlaylist={openStreamPlaylistFromUser}
      activeStreamPlaylist={activeStreamPlaylist}
    />
  ) : showDuplicates ? (
    <DuplicateAnalysisPanel
      all={duplicateAll}
      folders={duplicateFolders}
      initialIncludeSubfolders={duplicateIncludeSubfolders}
    />
  ) : previewAside ? (
    <div className="kd-col" style={{ height: "100%", minHeight: 0 }}>
      <div ref={setVideoPanelTarget} className="kd-network-video-panel" />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <NetworkVideoDetail key={`${videoPipSession.platform}:${videoPipSession.bvid}:${videoPipSession.page}`}
          session={videoPipSession} restoreTarget={detailRestoreTarget} />
      </div>
    </div>
  ) : detailAside ? trackDetailPanel : null;
  const activityAside = detailAside && detailAction === "playback";
  const asideBody = <PanelDockZone side="right">
    <div className="kd-activity-panel-host" hidden={!activityAside}>{playbackPanel}</div>
    {asidePanel}
  </PanelDockZone>;
  const closeEditorDock = closeAsideForUser;
  const editorDock = showComposition || visualizerTrackOpen ? <EditorDock
    title={showComposition ? liveVjOpen ? "实时 VJ" : "VJ 剪辑" : "可视化配置"}
    onClose={closeEditorDock}
    leading={showComposition ? <span className="vj-workshop-back-slot" ref={setWorkshopBackTarget} /> : undefined}
    tools={showComposition ? <div className="vj-toolbar-slot" ref={setWorkshopToolbarTarget} /> : undefined}>
    {showComposition ? <div className="kd-video-workspace">
      {liveVjOpen ? <LiveVjPanel toolbarTarget={workshopToolbarTarget} backTarget={workshopBackTarget} />
        : <CompositionWorkshop toolbarTarget={workshopToolbarTarget} backTarget={workshopBackTarget} />}
    </div> : inlineVisualizerSettings
      ? <div className="kd-viz-panel kd-viz-settings-host" ref={setVisualizerSettingsTarget} />
      : <Suspense fallback={null}><VisualizerStudioPanel onClose={closeEditorDock} /></Suspense>}
  </EditorDock> : null;
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

  // 右栏旁路打开时收起曲目详情；设置在舞台上方独立弹出，不改变右栏。
  // 歌词已并入曲目详情；这里不能 unpin，
  // 否则一点「歌词」就被拆掉，看起来像弹不出来。
  useEffect(() => {
    if (!(showFolders || showDuplicates || showPreview)) return;
    setDetailPinned(false);
    setAsideLocked(false);
    if (layout === "narrow") setSheet("aside");
  }, [
    layout,
    showFolders,
    showDuplicates,
    foldersPanelEpoch,
    duplicatesPanelEpoch,
    showPreview,
    previewPanelEpoch,
  ]);

  // 这是一个“临时盖层”：不清掉原来的右栏状态；关掉后自然回到原面板。
  // 反过来，用户显式打开设置/队列等正式旁路时，提示应立即让位。
  useEffect(() => {
    setShowSearchTips(false);
  }, [
    settingsPanelEpoch,
    queuePanelEpoch,
    foldersPanelEpoch,
    duplicatesPanelEpoch,
    lyricsPanelEpoch,
    previewPanelEpoch,
  ]);

  const toggleSearchTipsPanel = useCallback(() => {
    if (showSearchTips) {
      setShowSearchTips(false);
      if (layout === "narrow") setSheet(null);
      return;
    }
    setAsideLocked(false);
    setShowSearchTips(true);
    if (layout === "narrow") setSheet("aside");
  }, [layout, showSearchTips]);


  useEffect(() => {
    if (!queuePanelEpoch) return;
    // Only reveal the existing card; never switch the sidebar to a queue overlay.
    const viewport = usePanelViewport.getState();
    if (viewport.compact) {
      if (!viewport.activeIds.includes("kd-activity-panels:downloads")) toggleResponsivePanel("kd-activity-panels:downloads");
    } else if (layout === "narrow") setSheet("aside");
  }, [queuePanelEpoch, layout]);

  const openSettingsFromChrome = useCallback(() => {
    setShowSearchTips(false);
    toggleSettingsPanel();
  }, [toggleSettingsPanel]);

  const openUpdateFromChrome = useCallback(() => {
    setShowSearchTips(false);
    useUpdateStore.getState().openUpdateSection();
  }, []);

  /* ------------------------------------------------------------ 导航栏 / 旁路栏拖宽 */
  const shellRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const localAsideRef = useRef<HTMLElement | null>(null);

  // 打开时恢复上次拖的宽度。存 px：百分比在窗口缩放时会把"我调好的那栏"再挤变形
  // 写在 section-body：顶栏左区与侧栏共用 --kd-left。
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    for (const side of ["left", "right"] as const) {
      const saved = readLocalStorage(`kd-split-${side}`);
      if (saved) el.style.setProperty(`--kd-${side}`, `${saved}px`);
    }
  }, []);

  const LEFT_COLUMN_BOUNDS = [140, 420] as const;
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
    const rightHostWidth = Math.max(0, (target.parentElement?.getBoundingClientRect().width ?? 0) - 1);
    const [min, max] = side === "left"
      ? LEFT_COLUMN_BOUNDS
      : [Math.min(240, rightHostWidth), rightHostWidth] as const;
    let treeExpanded = compactTreeExpanded;
    let pendingClientX = event.clientX;
    let resizeFrame = 0;
    if (side === "right") document.body.dataset.kdPaneResizing = "right";
    const applyWidth = () => {
      resizeFrame = 0;
      // 左把手往右拖 = 左栏变宽；右把手往右拖 = 右栏变窄
      const delta = side === "left" ? pendingClientX - startX : startX - pendingClientX;
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
    const onMove = (move: PointerEvent) => {
      pendingClientX = move.clientX;
      if (!resizeFrame) resizeFrame = window.requestAnimationFrame(applyWidth);
    };
    const onUp = () => {
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
        applyWidth();
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      if (side === "right") {
        delete document.body.dataset.kdPaneResizing;
        window.dispatchEvent(new Event("kd:pane-resize-end"));
      }
      if (side === "left" && !treeExpanded) {
        // 最小轨道是一个布局状态，不把 58px 当作展开宽度存下来。
        shell.style.setProperty("--kd-left", `${Math.max(min, LEFT_RAIL_WIDTH)}px`);
        return;
      }
      const value = shell.style.getPropertyValue(`--kd-${side}`).replace("px", "");
      if (value) writeLocalStorageNow(`kd-split-${side}`, value);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  };

  const resetColumn = (side: "left" | "right") => {
    shellRef.current?.style.removeProperty(`--kd-${side}`);
    removeLocalStorage(`kd-split-${side}`);
    if (side === "right") window.dispatchEvent(new Event("kd:pane-resize-end"));
  };

  /**
   * Explore 代搜：详情面板把拼好的词 + 目标平台发过来，这里代填搜索框再提交。
   * 提交不能在事件回调里直接调 submit()——那个闭包看到的还是旧 query——
   * 所以立一个"待发射"标记，等 state 落定后的渲染周期里再开枪。
   *
   * 只搜目标平台走的是 submit 的一次性覆盖参数，**不动**顶栏平台勾选：
   * 这是程序代搜，不是用户改了主意；搜完回来下歌，勾着的还是原来那几家。
   * 扫光色与顶栏手动搜同一规则：单平台品牌色，多平台彩色。
   */
  const [explorePending, setExplorePending] = useState<{
    query: string;
    platforms: Platform[];
  } | null>(null);
  const [searchBurstNonce, setSearchBurstNonce] = useState(0);
  const [searchBurstTone, setSearchBurstTone] = useState<SearchBurstTone>("rainbow");
  useEffect(() => {
    const onExplore = (event: Event) => {
      const detail = (event as CustomEvent<ExploreSearchDetail>).detail;
      const q = detail?.query?.trim();
      const plats = detail?.platforms?.filter((id) => id !== "local") ?? [];
      if (!q || plats.length === 0) return;
      setQuery(q);
      // 只撑开中间搜索半栏（submit → setHasResults）；不弹右栏下载队列。
      setExplorePending({ query: q, platforms: plats });
    };
    window.addEventListener(EXPLORE_SEARCH_EVENT, onExplore);
    return () => window.removeEventListener(EXPLORE_SEARCH_EVENT, onExplore);
  }, []);
  useEffect(() => {
    if (explorePending && query === explorePending.query) {
      const { platforms: plats } = explorePending;
      setExplorePending(null);
      setSearchBurstTone(burstToneForPlatforms(plats));
      setSearchBurstNonce((n) => n + 1);
      // 目标源若还没在设置里开过，代搜时顺手启用（同平台条首次点击）。
      if (settings) {
        let current = settings;
        const patch: ReturnType<typeof patchEnabledPlatform> = {};
        let dirty = false;
        for (const platform of plats) {
          if (!isPlatformEnabled(current, platform)) {
            const next = patchEnabledPlatform(current, platform, true);
            Object.assign(patch, next);
            current = { ...current, ...next };
            dirty = true;
          }
        }
        if (dirty) void saveSettings(patch).catch(() => undefined);
      }
      void submit(plats);
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

  const loadCollection = useCallback(async (collection: CollectionResult) => {
    const requestId = ++resultRequestSeqRef.current;
    const token = `${collection.platform}:${collection.kind}:${collection.key}`;
    const hasCandidate = items?.some((item) =>
      item.collections.some(
        (candidate) =>
          candidate.platform === collection.platform &&
          candidate.kind === collection.kind &&
          candidate.key === collection.key,
      ),
    );
    const snapshot = hasCandidate && items
      ? {
          items,
          video,
          scrollTop: searchScrollRef.current?.scrollTop ?? 0,
          scrollLeft: searchScrollRef.current?.scrollLeft ?? 0,
        }
      : null;
    setSearchError("");
    setLoadingCollections((current) => new Set(current).add(token));
    try {
      const response = await api.resolveCollection(collection, 0);
      if (requestId !== resultRequestSeqRef.current) return;
      const resolved = resolvedCollectionItem(collection, response);
      // 候选列表与合集详情是两个页面状态；详情页只保留这一个合集的歌曲。
      setCollectionSearchSnapshot(snapshot);
      setCollectionPage(1);
      setItems([resolved]);
      setChosen(new Set());
      setSearchSelectionMode(false);
      setCollapsedItems(new Set());
      setExpandedGroups(new Set());
      setSourceIndex({});
      if (
        collection.kind === "playlist" &&
        (collection.platform === "wyy" || collection.platform === "qqm")
      ) {
        setActiveStreamPlaylist({ platform: collection.platform, key: collection.key });
      } else {
        setActiveStreamPlaylist(null);
      }
      revealLoadedCollection();
    } catch (error) {
      if (requestId !== resultRequestSeqRef.current) return;
      setSearchError(`载入集合失败：${errorText(error)}`);
    } finally {
      setLoadingCollections((current) => {
        const next = new Set(current);
        next.delete(token);
        return next;
      });
    }
  }, [items, revealLoadedCollection, video]);

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
  /** 勾选里有 B 站来源时，动作栏才需要「只下音频」开关。 */
  const chosenHasVideo = useMemo(
    () => chosenSources.some((source) => source.platform === "bilibili" || source.platform === "youtube"),
    [chosenSources],
  );

  const addToQueue = useCallback(async () => {
    if (chosenSources.length === 0) return;
    setQueueError("");
    try {
      // 不报"已加入 N 个任务"：右边那栏就是队列，任务当场排进去，
      // 而且勾选被清空、这条动作栏跟着收起来，做成了看得一清二楚
      await enqueueMediaDownloads(chosenSources, {
        quality: settings?.default_quality ?? null,
        video: {
          audioOnly: videoAudioOnly,
          maxHeight: settings?.video_max_height ?? 1080,
          transcode: settings?.video_transcode ?? false,
        },
      });
      setChosen(new Set());
      setSearchSelectionMode(false);
      setVideoAudioOnly(false);
      void refreshStats();
    } catch (error) {
      setQueueError(`加入队列失败：${errorText(error)}`);
    }
  }, [chosenSources, settings?.default_quality, settings?.video_max_height, settings?.video_transcode, refreshStats, videoAudioOnly]);

  // 曲目表 / 搜索结果：Cmd/Ctrl + A · C · X · V（Option+V 强制移动）。
  useLibraryClipboard({
    active: () => Boolean(!temporaryLibrary && searchPaneVisible && items && items.length > 0),
    preferred: () => activeWorkspacePane === "search",
    selectAll: () => {
      setSearchSelectionMode(true);
      selectAllSearch();
    },
    chosenSources: () => chosenSources,
    enqueueChosen: () => addToQueue(),
  }, () => temporaryLibrary && activeWorkspacePane === "search"
    ? temporaryLibrary.store.getState()
    : useLibraryStore.getState());

  const downloadResolvedItem = useCallback(
    async (item: IntakeItem) => {
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
        await enqueueMediaDownloads(sources, {
          quality: settings?.default_quality ?? null,
          video: {
            audioOnly: videoAudioOnly,
            maxHeight: settings?.video_max_height ?? 1080,
            transcode: settings?.video_transcode ?? false,
          },
        });
        void refreshStats();
      } catch (error) {
        setQueueError(`整包下载失败：${errorText(error)}`);
      }
    },
    [sourceIndex, settings?.default_quality, settings?.video_max_height, settings?.video_transcode, refreshStats, videoAudioOnly],
  );

  const downloadOpenedCollection = useCallback(async () => {
    let item = openedCollection;
    const playlist = openedStreamPlaylist;
    if (!item) return;
    // “全部下载”是明确的全量动作；只有这时才允许把尚未浏览的 B 站页补齐。
    if (
      playlist?.platform === "bilibili"
      && playlist.count > item.groups.length
    ) {
      const requestId = ++resultRequestSeqRef.current;
      setBusy(true);
      setQueueError("");
      try {
        const response = await api.streamPlaylist(playlist, 0);
        if (requestId !== resultRequestSeqRef.current) return;
        item = streamPlaylistItem(playlist, response);
        setItems([item]);
        setOpenedStreamPlaylist({ ...playlist, count: item.groups.length });
      } catch (error) {
        if (requestId === resultRequestSeqRef.current) {
          setQueueError(`读取完整收藏夹失败：${errorText(error)}`);
        }
        return;
      } finally {
        if (requestId === resultRequestSeqRef.current) setBusy(false);
      }
    }
    await downloadResolvedItem(item);
  }, [downloadResolvedItem, openedCollection, openedStreamPlaylist]);

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
        await enqueueMediaDownloads([source], {
          quality: settings?.default_quality ?? null,
        });
        void refreshStats();
      } catch (error) {
        setQueueError(`加入队列失败：${errorText(error)}`);
      }
    },
    [sourceIndex, settings?.default_quality, refreshStats],
  );

  // 主/副两级排序的三段式点击语义全在 store 里（cycleSort），
  // 这里只负责把点击转过去——判断逻辑放在组件里迟早会和别处的入口不一致
  const sortBy = useLibraryStore((state) => state.cycleSort);
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
    selectedId,
    showSettings,
    showQueue,
    showPreview,
    showFolders,
    showComposition,
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
              panelIndexTarget={setPanelIndexTarget}
              compositionOpen={showComposition}
              onComposition={selectVideoMode}
              settingsOpen={showSettings}
              onSettings={openSettingsFromChrome}
              onOpenUpdate={openUpdateFromChrome}
            />
          }
        />
        <div className="kd-stage">
        <div
          className="kd-split"
          inert={showSettings && layout === "narrow"}
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
              style={{ minWidth: 0 }}
              data-kd-browse-focus={browseFocus === "sidebar" ? "sidebar" : undefined}
            >
              <NarrowFolderRail
                expanded={compactTreeExpanded}
                onNavigate={onFolderNavigate}
                onOpenStreamPlaylist={openStreamPlaylistFromUser}
                activeStreamPlaylist={activeStreamPlaylist}
              />
            </div>
          )}

          {/* 本地来源导航固定在最左侧；这里只调整导航宽度，不再允许把它拖到内容右边。 */}
          {showTree && (
            <div
              className="kd-split-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整文件夹栏宽度"
              onPointerDown={startColumnDrag("left")}
              onDoubleClick={() => resetColumn("left")}
            />
          )}

          <div className="kd-main-slot">
            <div ref={panelWorkspace} className="kd-table-wrap" data-aside={showAside ? "open" : "closed"}>
            <PanelWideSearchZone />
            <PanelDockZone side="top">
            {/* 搜索带可收起；查询文字、来源选择和已有结果都保留。 */}
            {aggregateSearchOpen && topPanelsEnabled.search ? (
              <PanelStack reorderable storageKey="kd-top-search-panels" dockKey="kd-activity-panels">
              <Panel key="search" heading="聚合搜索" dense padded={false}>
              <div
                className="kd-search-band-host"
                data-open={aggregateSearchRevealed || undefined}
              >
                <div className="kd-search-band">
                  {aggregateSearch(false)}
                </div>
              </div>
              </Panel>
              </PanelStack>
            ) : null}
            <TrackPreviewPanel track={detailTrack} />
            </PanelDockZone>
            <div className="kd-local-list-slot" data-aside={showAside ? "open" : "closed"}>
              {temporaryFolderDrop.offered && <div className="kd-temporary-folder-drop"
                data-kd-temporary-folder-drop="true" data-hovered={temporaryFolderDrop.hovered || undefined}>
                临时打开文件夹
              </div>}
              <div
                ref={workspacePaneRef}
                className="kd-workspace-panes"
                data-pane-count={visiblePaneOrder.length}
                data-pane-dragging={dragWorkspacePane ?? undefined}
                data-kd-browse-focus={browseFocus === "pane" ? "pane" : undefined}
                style={{ gridTemplateColumns: workspacePaneGridTemplate }}
                onDragOverCapture={onWorkspacePaneDragOverCapture}
                onDropCapture={onWorkspacePaneDropCapture}
              >
                <div
                  className="kd-workspace-pane kd-workspace-pane-local kd-download-dropzone"
                  data-workspace-pane-kind="local"
                  data-pane-visible={localPaneVisible ? "true" : undefined}
                  data-pane-active={activeWorkspacePane === "local" ? "true" : undefined}
                  data-pane-drop-target={workspacePaneDropTarget === "local" ? "true" : undefined}
                  data-pane-dragging={dragWorkspacePane === "local" ? "true" : undefined}
                  style={{ order: paneOrder("local") }}
                  data-drop-offered={searchDragActive ? "true" : undefined}
                  data-drop-active={localDropActive ? "true" : undefined}
                  onPointerDownCapture={() => focusWorkspacePane("local")}
                  onFocusCapture={() => focusWorkspacePane("local")}
                  {...{
                    [SEARCH_DROP_PATH_ATTR]: !isOutsideFolder(filter.folder)
                      ? filter.folder.trim() || SEARCH_DEFAULT_DOWNLOAD_SENTINEL
                      : undefined,
                  }}
                  onDragOver={(event) => {
                    if (!isSearchDownloadDrag(event)) return;
                    // 全部曲目落到默认下载文件夹。
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
                  <LibraryWorkRail mode="rail"
                    aggregateSearchOpen={aggregateSearchOpen || !topPanelsEnabled.search}
                    onOpenAggregateSearch={openAggregateSearch}
                  />
                  <div className="kd-workspace-drop-overlay" aria-hidden="true">
                    <span>
                      {filter.folder && !isOutsideFolder(filter.folder)
                        ? "放入当前文件夹"
                        : filter.folder
                          ? "先打开一个本地文件夹"
                          : "下载到默认文件夹"}
                    </span>
                  </div>
                  <LibraryToolbar />
                  {libError && (
                    <div className="kd-toolbar" style={{ color: "var(--kd-danger)" }}>
                      {libError}
                      <button type="button" onClick={() => { void useLibraryStore.getState().retryList(); }}>重试</button>
                    </div>
                  )}
                  <InlineNotice
                    text={folderDropError}
                    onDismiss={() => setFolderDropError("")}
                    block
                  />
                  <TrackTable
                    total={total}
                    loading={loading}
                    layout={layout}
                    fitWidth={false}
                    selectedId={selectedId}
                    selectedIds={selectedIds}
                    shortcutActive={activeWorkspacePane === "local"}
                    sort={filter.sort}
                    order={filter.order}
                    onSelect={selectTrack}
                    onSort={sortBy}
                    sort2={filter.sort2}
                    order2={filter.order2}
                  />
                </div>

                {visiblePaneOrder.slice(0, -1).map((left, index) => {
                  const right = visiblePaneOrder[index + 1];
                  return (
                    <div
                      key={`${left}:${right}`}
                      className="kd-workspace-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`调整${WORKSPACE_PANE_LABELS[left]}与${WORKSPACE_PANE_LABELS[right]}宽度`}
                      style={{ order: index * 2 + 1 }}
                      onPointerDown={startWorkspacePaneResize(left, right)}
                      onDoubleClick={resetWorkspacePaneSizes}
                    />
                  );
                })}

                {(hasResults || temporaryLibrary) && (
                    <div
                      className="kd-workspace-pane kd-workspace-pane-remote"
                      data-workspace-pane-kind="search"
                      data-pane-visible={searchPaneVisible ? "true" : undefined}
                      data-pane-active={activeWorkspacePane === "search" ? "true" : undefined}
                      data-pane-drop-target={workspacePaneDropTarget === "search" ? "true" : undefined}
                      data-pane-dragging={dragWorkspacePane === "search" ? "true" : undefined}
                      style={{ order: paneOrder("search") }}
                      onPointerDownCapture={() => focusWorkspacePane("search")}
                      onFocusCapture={() => focusWorkspacePane("search")}
                    >
                      {temporaryLibrary ? <TemporaryFolderPane key={temporaryLibrary.id} library={temporaryLibrary}
                        active={activeWorkspacePane === "search"} layout={layout}
                        onSelect={(id, mode, clickCount) => selectTrack(id, mode, clickCount, temporaryLibrary.store)}
                        onClose={() => {
                          setTemporaryLibrary(null);
                          setHasResults(false);
                          activateWorkspacePane("local");
                        }}
                      /> : <>
                      {visiblePaneOrder.length > 1 ? (
                        <button
                          type="button"
                          className="kd-workspace-pane-grip"
                          {...workspacePaneGripProps("search")}
                        />
                      ) : null}
                      <SearchWorkRail
                        items={items ?? []}
                        collection={openedCollection}
                        collectionWindow={openedCollectionWindow}
                        canGoBack={collectionSearchSnapshot !== null}
                        onGoBack={returnToCollectionSearch}
                        onCollectionPageChange={changeCollectionPage}
                        onDownloadCollection={() => void downloadOpenedCollection()}
                        loading={busy || loadingCollections.size > 0}
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
                        showVideoAudioOnly={chosenHasVideo}
                        videoAudioOnly={videoAudioOnly}
                        onToggleVideoAudioOnly={setVideoAudioOnly}
                        onClose={() => {
                          resultRequestSeqRef.current += 1;
                          setBusy(false);
                          setHasResults(false);
                          setCollectionSearchSnapshot(null);
                          setCollectionPage(1);
                          setActiveStreamPlaylist(null);
                          setInspectedOnlineGroup(null);
                          updateStreamWorkspaceSession({
                            playlist: null,
                            accountKey: null,
                            inspectedGroup: null,
                            scrollTop: 0,
                          });
                          setRestorableWorkspaceSource("local");
                          activateWorkspacePane("local");
                          setLoadingCollections(new Set());
                          setChosen(new Set());
                          setSearchSelectionMode(false);
                        }}
                      />
                      <InlineNotice text={searchError} onDismiss={() => setSearchError("")} block />
                      {songPreviewState.phase === "error" &&
                        (items ?? []).some((item) =>
                          item.groups.some((group) =>
                            group.sources.some(
                              (source) =>
                                `${source.platform}:${source.key}` === songPreviewState.sourceKey,
                            ),
                          ),
                        ) && (
                        <div className="kd-toolbar" data-slim="true">
                          <InlineNotice text={`试听失败：${songPreviewState.error}`} />
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!songPreviewState.canRetry}
                            onClick={() => void retrySongPreview().catch(() => undefined)}
                          >
                            重试试听
                          </Button>
                        </div>
                      )}
                      <div
                        className="kd-scroll"
                        ref={searchScrollRef}
                        onScroll={(event) => {
                          if (activeStreamPlaylist) {
                            updateStreamWorkspaceSession({
                              scrollTop: event.currentTarget.scrollTop,
                            });
                          }
                        }}
                      >
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
                          inspectedGroup={inspectedOnlineGroup}
                          collectionPage={collectionPage}
                          onToggleSelect={toggleSelect}
                          onToggleExpand={toggleExpand}
                          onPickSource={pickSource}
                          onToggleItem={toggleItem}
                          onToggleItemAll={toggleItemAll}
                          onToggleAll={toggleAll}
                          onDownloadGroup={(group) => void downloadGroup(group)}
                          onDownloadSelected={() => void addToQueue()}
                          onInspectGroup={inspectOnlineGroup}
                          onRemoveStreamGroup={
                            removeStreamGroupLabel
                              ? (group, sourceIdx) => void removeStreamGroup(group, sourceIdx)
                              : undefined
                          }
                          removeStreamGroupLabel={removeStreamGroupLabel}
                          removingStreamGroupIds={removingStreamGroupIds}
                          previewPendingSourceKey={
                            previewPendingStatus ? songPreviewState.sourceKey : ""
                          }
                          previewPendingLabel={
                            previewPendingStatus === "resolving" ? "解析中" : "加载中"
                          }
                          onLoadCollection={(collection) => void loadCollection(collection)}
                          loadingCollections={loadingCollections}
                        />
                      </div>
                      </>}
                    </div>
                )}
              </div>

            </div>
              {layout === "wide" && (
                <>
                  <div
                    className="kd-split-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整右侧栏宽度"
                    hidden={!showAside}
                    onPointerDown={startColumnDrag("right")}
                    onDoubleClick={() => resetColumn("right")}
                  />
                  <aside className="kd-split-aside" ref={localAsideRef} hidden={!showAside}>
                    <div className="kd-aside-restorable" hidden={editorAsideOpen} inert={showSettings}>
                    {detailAside && detailAction === "playback" ? asideTools : <AsideHead
                      title={asideLabel}
                      leading={workshopBackSlot}
                      tools={asideTools}
                    />}
                    <div className="kd-split-aside-body kd-scroll">{asideBody}</div>
                    </div>
                    {editorDock}
                    {showSettings && <SettingsOverlay />}
                  </aside>
                </>
              )}

          </div>
          </div>

        </div>

        {/* 单栏：右栏进侧方抽屉，只盖中间舞台，不压顶栏/播放条。 */}
        {layout === "narrow" && (
          <Sheet
            keepMounted
            hideHeader={editorAsideOpen || (detailAside && detailAction === "playback")}
            showClose={false}
            open={editorAsideOpen || (sheet === "aside" && hasAsideContent && !(panelsAtTop && activityAside))}
            title={editorAsideOpen ? showComposition ? liveVjOpen ? "实时 VJ" : "VJ 剪辑" : "可视化配置" : asideLabel || "面板"}
            heading={
              workshopBackSlot ? <span className="vj-editor-navigation">{workshopBackSlot}<span>{asideLabel}</span></span> : undefined
            }
            tools={editorAsideOpen ? undefined : asideTools}
            onClose={closeAsideForUser}
          >
            <div className="kd-aside-restorable" hidden={editorAsideOpen}>{asideBody}</div>
            {editorDock}
          </Sheet>
        )}
        </div>
        {showSettings && layout === "narrow" && <SettingsOverlay />}
      </div>
    </section>
  );
}
