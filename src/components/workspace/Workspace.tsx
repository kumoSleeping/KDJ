import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PanelTopClose, Pin } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { clearTextSelection } from "../../lib/textSelection";
import {
  activeSearchDrag,
  claimActiveSearchDrag,
  enqueueSearchDrop,
  enqueueSearchOneLibraryDrop,
  enqueueSearchOneLibraryPayload,
  enqueueSearchPayload,
  enqueueSearchQueuePayload,
  finishSearchDrop,
  isSearchDownloadDrag,
  searchAudioSource,
  SEARCH_DRAG_STATE_EVENT,
} from "../../lib/searchDrag";
import {
  PLAYLIST_DROP_DEVICE_ATTR,
  PLAYLIST_DROP_ID_ATTR,
  SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
  SEARCH_DROP_PATH_ATTR,
  playlistDropAt,
  searchDropPathAt,
  searchQueueDropAt,
} from "../../lib/folderDrop";
import {
  activeTrackDragIds,
  claimActiveTrackDragIds,
  dispatchStreamDeckDrop,
  dispatchTrackCoverDrop,
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  trackDeckDropSideAt,
  TRACK_COVER_DROP_TARGET_ATTR,
  TRACK_DRAG_STATE_EVENT,
} from "../../lib/trackDrag";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import {
  isStreamTrack,
  makePendingSongStreamTrack,
  streamTrackById,
} from "../../lib/streamTrack";
import {
  getSongPreviewState,
  retrySongPreview,
  subscribeSongPreviewState,
} from "../../lib/songPreview";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { enqueueMediaDownloads } from "../../lib/mediaActions";
import { useUpdateStore } from "../../stores/updateStore";
import {
  STREAM_BROWSE_PLATFORMS,
  type ActiveStreamPlaylist,
  type StreamBrowsePlatform,
} from "../../stores/streamBrowseStore";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import {
  shouldPinDetailOnClick,
  useTrackClickPrefs,
} from "../../lib/trackClickPrefs";
import { isPlatformEnabled, patchEnabledPlatform } from "../../lib/enabledPlatforms";
import { resolveLibraryPasteOp } from "../../lib/libraryPaste";
import { isOutsideFolder } from "../../lib/outsideFolder";
import {
  oneLibraryPlayableTrack,
  resolveOneLibraryDropTarget,
} from "../../lib/oneLibraryTrack";
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
  restoreWorkspacePaneState,
  visibleWorkspacePanes,
  type WorkspacePaneKind,
  type WorkspacePaneState,
} from "../../lib/workspacePanes";
import {
  readWorkspaceSession,
  setRestorableWorkspaceSource,
  updateLocalWorkspaceSession,
  updateStreamWorkspaceSession,
} from "../../lib/workspaceSession";
import {
  promoteResolvedCollection,
  resolvedCollectionItem,
} from "../../lib/searchCollections";
import { useLibraryClipboard } from "../../lib/useLibraryClipboard";
import {
  selectSelectedTrack,
  useLibraryStore,
  type SelectMode,
} from "../../stores/libraryStore";
import { usePlaylistStore } from "../../stores/playlistStore";
import type {
  CollectionResult,
  IntakeItem,
  MergedGroup,
  OneLibraryTrack,
  Platform,
  SearchKind,
  SongSource,
  StreamPlaylist,
  VideoInfo,
} from "../../types";
import { Button, InlineNotice, Sheet } from "../common";
import { AppChrome } from "../chrome/AppChrome";
import { AsideFaceSwitch, AsideHead, AsideToggleButton, type TrackAsideFace } from "../chrome/AsideHead";
import { useLyricsPrefs, type LyricsAsideFace } from "../../lib/lyricsPrefs";
import {
  EXPLORE_SEARCH_EVENT,
  type ExploreSearchDetail,
} from "../../lib/vjSearch";
import { burstToneForPlatforms, type SearchBurstTone } from "../download/SearchBurstFX";
import { ensureLyrics } from "../../stores/lyricsStore";
import { ChromeActions } from "../chrome/ChromeActions";
import { LibraryWorkRail } from "../chrome/LibraryWorkRail";
import { OneLibraryWorkRail } from "../chrome/OneLibraryWorkRail";
import { SearchWorkRail } from "../chrome/SearchWorkRail";
import { QueuePanel } from "../download/QueuePanel";
import { DuplicateAnalysisPanel } from "../library/DuplicateAnalysisPanel";
import { isApplyingNav, readPlace, useNavStore } from "../../stores/navStore";
import { useVideoPip } from "../../lib/videoPip";
import type { WorkMode } from "../../lib/workMode";
import { ResultTable, selectableGroups, selectionKey } from "../download/ResultTable";
import {
  DEFAULT_PRIORITY,
  normalizeSearchPlatforms,
  SearchBar,
} from "../download/SearchBar";
import { VideoPreview } from "../download/VideoPreview";
import { FolderTree, NarrowFolderRail } from "../library/FolderTree";
import { VjExportPanel } from "../library/VjExportPanel";
import { VirtualDiskPanel } from "../library/VirtualDiskPanel";
import { OneLibraryTrackTable } from "../library/OneLibraryTrackTable";
import { OneLibraryTrackDetail } from "../library/OneLibraryTrackDetail";
import { DETAIL_EVENT } from "../library/TrackTable";
import { LyricsView } from "../player/LyricsView";
import { StreamTrackDetail } from "../player/StreamTrackDetail";
import { SettingsPanel } from "../settings/SettingsPanel";
import { LibraryToolbar } from "../library/LibraryToolbar";
import { TrackDetail } from "../library/TrackDetail";
import { TrackTable } from "../library/TrackTable";

const LABS_BUILD = typeof __KDJ_LABS__ !== "undefined" && __KDJ_LABS__;

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
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
  onelibrary: "OneLibrary",
  search: "在线内容",
};

type WorkspacePaneWeights = Record<WorkspacePaneKind, number>;
type MovableWorkspacePaneKind = Exclude<WorkspacePaneKind, "local">;

function storedJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
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
    : session.source === "onelibrary" && session.oneLibrary.target
      ? "onelibrary"
      : "local";
  return { ...restored, active };
}

/**
 * 唯一的工作台。没有"下载板块"和"曲库板块"之分。
 *
 * 平时它就是曲库：左边固定本地来源导航，右边的统一舞台承载本地曲目、
 * OneLibrary 与在线内容。本地曲库钉住时同时显示最多三块；否则新内容覆盖当前板块。
 * 本地曲库固定最左，OneLibrary 和在线内容可在它右边拖动换位，每条分隔线都能独立调宽。
 * 详情 / 队列 / 账号等旁路面板仍按需在最右侧出现。
 * 真正把歌加入下载（按钮 / 拖进文件夹）时，才把右栏切成下载队列。
 *
 * 这么排的理由：找歌 → 下载 → 进曲库 → 排 set 本来就是一条线上的动作，
 * 搜的时候本地还在眼前，也不被队列面板打断。
 */
interface WorkspaceProps {
  workMode: WorkMode;
  onWorkModeChange(mode: WorkMode): void;
}

export function Workspace({
  workMode,
  onWorkModeChange,
}: WorkspaceProps) {
  const selectedOneLibrary = usePlaylistStore((state) => state.selectedTarget);
  const oneLibraryDevices = usePlaylistStore((state) => state.devices);
  const selectedOneLibraryTracks = usePlaylistStore((state) => state.selectedTracks);
  const settings = useAppStore((state) => state.settings);
  const searchCapabilities = useAppStore((state) => state.searchCapabilities);
  const listMode = useAppStore((state) => state.listMode);
  const hasResults = useAppStore((state) => state.hasResults);
  const setHasResults = useAppStore((state) => state.setHasResults);
  const videoPipMode = useVideoPip((state) => state.mode);
  const videoPipSession = useVideoPip((state) => state.session);
  const showTrackDetail = useAppStore((state) => state.showTrackDetail);
  const showSettings = useAppStore((state) => state.showSettings);
  const settingsPanelEpoch = useAppStore((state) => state.settingsPanelEpoch);
  const showQueue = useAppStore((state) => state.showQueue);
  const queuePanelEpoch = useAppStore((state) => state.queuePanelEpoch);
  const queuePinned = useAppStore((state) => state.queuePinned);
  const setQueuePinned = useAppStore((state) => state.setQueuePinned);
  const showPreview = useAppStore((state) => state.showPreview);
  const showFolders = useAppStore((state) => state.showFolders);
  const foldersPanelEpoch = useAppStore((state) => state.foldersPanelEpoch);
  const showVjExport = useAppStore((state) => state.showVjExport);
  const vjExportPanelEpoch = useAppStore((state) => state.vjExportPanelEpoch);
  const showDuplicates = useAppStore((state) => state.showDuplicates);
  const duplicateFolders = useAppStore((state) => state.duplicateFolders);
  const duplicateAll = useAppStore((state) => state.duplicateAll);
  const duplicateIncludeSubfolders = useAppStore(
    (state) => state.duplicateIncludeSubfolders,
  );
  const duplicatesPanelEpoch = useAppStore((state) => state.duplicatesPanelEpoch);
  const showVirtualDisk = useAppStore((state) => state.showVirtualDisk);
  const virtualDiskPanelEpoch = useAppStore((state) => state.virtualDiskPanelEpoch);
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
  const songPreviewState = useSyncExternalStore(
    subscribeSongPreviewState,
    getSongPreviewState,
    getSongPreviewState,
  );
  const activeDownloads = useDownloadStore((state) => state.activeCount);
  const { columns: layout, chrome, portrait } = useLayoutSignals();

  const tracks = useLibraryStore((state) => state.tracks);
  const total = useLibraryStore((state) => state.total);
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
  const [aggregateSearchOpen, setAggregateSearchOpen] = useState(true);
  const [aggregateSearchRevealed, setAggregateSearchRevealed] = useState(true);
  const experimentalOneLibrary = LABS_BUILD && (settings?.experimental_one_library ?? false);
  const dismissAggregateSearch = useCallback(() => {
    setAggregateSearchRevealed(false);
    window.setTimeout(() => setAggregateSearchOpen(false), 280);
  }, []);
  const openAggregateSearch = useCallback(() => {
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
  const [busy, setBusy] = useState(false);
  const restoredWorkspaceSessionRef = useRef(readWorkspaceSession());
  const restoredStream = restoredWorkspaceSessionRef.current.source === "stream"
    ? restoredWorkspaceSessionRef.current.stream
    : null;
  const [items, setItems] = useState<IntakeItem[] | null>(null);
  const [activeStreamPlaylist, setActiveStreamPlaylist] = useState<ActiveStreamPlaylist | null>(
    () => restoredStream?.playlist
      ? { platform: restoredStream.playlist.platform as StreamBrowsePlatform, key: restoredStream.playlist.key }
      : null,
  );
  const [inspectedOnlineGroup, setInspectedOnlineGroup] = useState<string | null>(
    () => restoredStream?.inspectedGroup ?? null,
  );
  /** 贴链接解析出来的那一个视频，置顶在结果列表最前面；关键词搜索会把它顶掉。 */
  const [video, setVideo] = useState<VideoInfo | null>(null);
  /**
   * 三处失败各有各的现场，所以分成三条，不合并成一个全局的错误：
   * 搜索失败要顶在结果列表的摘要位、入队失败要贴在「加入队列」旁边、
   * 拖动排序失败要出现在曲目表上方。合成一条就总有两处放错地方。
   */
  const [searchError, setSearchError] = useState("");
  const [queueError, setQueueError] = useState("");
  /** B 站批量下载的「只要音频」：入队时盖进来源 payload，后端据此下 m4a。 */
  const [videoAudioOnly, setVideoAudioOnly] = useState(false);
  const [reorderError, setReorderError] = useState("");
  const [folderDropError, setFolderDropError] = useState("");
  const [localDropActive, setLocalDropActive] = useState(false);
  const [oneLibraryDropActive, setOneLibraryDropActive] = useState(false);
  const [searchDragActive, setSearchDragActive] = useState(() => Boolean(activeSearchDrag()));
  const [localTrackDragActive, setLocalTrackDragActive] = useState(
    () => activeTrackDragIds().length > 0,
  );
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [searchSelectionMode, setSearchSelectionMode] = useState(false);
  const [loadingCollections, setLoadingCollections] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [collapsedItems, setCollapsedItems] = useState<Set<number>>(new Set());
  const [sourceIndex, setSourceIndex] = useState<Record<string, number>>({});
  /**
   * 三种列表共用同一套板块状态。钉住本地曲库时最多同时挂三块；未钉住只显示
   * 当前板块。切换只改变可见性，不卸载结果与排序偏好。
   */
  const [localPanePinned, setLocalPanePinned] = useState(
    () => localStorage.getItem(LOCAL_PANE_PIN_KEY) === "1",
  );
  const [workspacePaneState, setWorkspacePaneState] =
    useState<WorkspacePaneState>(loadWorkspacePanes);
  const [oneLibraryPaneCollapsed, setOneLibraryPaneCollapsed] = useState(false);
  const [browseFocus, setBrowseFocus] = useState<MidiBrowseFocus>("pane");
  const browseFocusRef = useRef(browseFocus);
  browseFocusRef.current = browseFocus;
  const browseCursorIdRef = useRef<string | null>(null);
  useEffect(() => {
    localStorage.setItem(LOCAL_PANE_PIN_KEY, localPanePinned ? "1" : "0");
  }, [localPanePinned]);
  useEffect(() => {
    localStorage.setItem(WORKSPACE_PANES_KEY, JSON.stringify(workspacePaneState));
  }, [workspacePaneState]);
  const activateWorkspacePane = useCallback((kind: WorkspacePaneKind) => {
    if (kind === "onelibrary") setOneLibraryPaneCollapsed(false);
    setWorkspacePaneState((current) =>
      current.active === kind ? current : { ...current, active: kind },
    );
  }, []);
  const focusWorkspacePane = useCallback((kind: WorkspacePaneKind) => {
    if (kind === "local") setRestorableWorkspaceSource("local");
    else if (kind === "onelibrary") setRestorableWorkspaceSource("onelibrary");
    else if (activeStreamPlaylist) setRestorableWorkspaceSource("stream");
    setWorkspacePaneState((current) =>
      current.active === kind ? current : { ...current, active: kind },
    );
  }, [activeStreamPlaylist]);
  const workspacePaneAvailability = useMemo(
    () => ({
      local: true,
      onelibrary:
        experimentalOneLibrary && Boolean(selectedOneLibrary) && !oneLibraryPaneCollapsed,
      search: hasResults,
    }),
    [experimentalOneLibrary, hasResults, oneLibraryPaneCollapsed, selectedOneLibrary],
  );
  const oneLibraryPaneWritable = Boolean(
    selectedOneLibrary &&
    !oneLibraryDevices.find((device) => device.path === selectedOneLibrary.device_path)?.read_only,
  );
  const onlineAudioDragActive = Boolean(
    searchDragActive && activeSearchDrag()?.kind === "audio",
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
  // 不把“暂时尚未挂载”写回 active：搜索/OneLibrary 的点击会先切意图，再异步提供内容。
  // 单栏布局当前先安全显示本地页，目标内容一可用便自动成为唯一可见板块。
  const paneOrder = (kind: WorkspacePaneKind) =>
    Math.max(0, visiblePaneOrder.indexOf(kind)) * 2;
  const collapseOneLibraryPane = useCallback(() => {
    setOneLibraryPaneCollapsed(true);
    setRestorableWorkspaceSource("local");
    setWorkspacePaneState((current) =>
      current.active === "onelibrary" ? { ...current, active: "local" } : current,
    );
  }, []);

  useEffect(() => {
    const onTrackDragState = (event: Event) => {
      const detail = (event as CustomEvent<{ ids?: number[] }>).detail;
      const active = Boolean(detail?.ids?.length);
      setLocalTrackDragActive(active);
      if (!active) setOneLibraryDropActive(false);
    };
    window.addEventListener(TRACK_DRAG_STATE_EVENT, onTrackDragState);
    return () => window.removeEventListener(TRACK_DRAG_STATE_EVENT, onTrackDragState);
  }, []);
  const revealSearchPane = useCallback(() => {
    activateWorkspacePane("search");
    setHasResults(true);
  }, [activateWorkspacePane, setHasResults]);
  const searchScrollRef = useRef<HTMLDivElement>(null);
  const revealLoadedCollection = useCallback(() => {
    revealSearchPane();
    // 搜索面板可能刚从另一栏恢复；等它挂载并完成结果表布局后再回到新集合顶部。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => searchScrollRef.current?.scrollTo({ top: 0, left: 0 }));
    });
  }, [revealSearchPane]);
  const localPaneVisible = visiblePaneOrder.includes("local");
  const searchPaneVisible = visiblePaneOrder.includes("search");
  const oneLibraryPaneVisible = visiblePaneOrder.includes("onelibrary");
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
    return value === "local" || value === "onelibrary" || value === "search" ? value : null;
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
  /** FolderTree 在远程歌单点击后还会调用 onNavigate；同一调用栈内不能清高亮。 */
  const streamOpenNavigationRef = useRef(false);

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
      if (!detail?.active) {
        setLocalDropActive(false);
        setOneLibraryDropActive(false);
      }
    };
    window.addEventListener(SEARCH_DRAG_STATE_EVENT, onSearchDragState);
    return () => window.removeEventListener(SEARCH_DRAG_STATE_EVENT, onSearchDragState);
  }, []);

  useEffect(() => {
    /**
     * WKWebView 能开始原生拖动，却偶尔不把 drop 送给文件夹、队列或 OneLibrary。
     * dragend 仍有松手坐标：命中目标时直接完成操作。claim 闩锁会挡住
     * 随后迟到的原生 drop，确保同一次拖动只执行一次。
     */
    let lastDropPath = "";
    let lastQueueDrop = false;
    let lastPlaylistDrop: ReturnType<typeof playlistDropAt> = null;
    let lastCoverTrackId: number | null = null;
    let lastDeckDropSide: 0 | 1 | null = null;
    const rememberDropTargetUnderPointer = (event: DragEvent) => {
      // 某些 WKWebView 的 dragend 坐标会退回 0,0；持续记录最后一次 dragover
      // 命中的文件夹、当前曲目表、下载队列、OneLibrary 或封面框，同时在
      // 指针移出时清掉旧目标。
      lastDropPath = searchDropPathAt(event.clientX, event.clientY);
      lastQueueDrop = searchQueueDropAt(event.clientX, event.clientY);
      lastPlaylistDrop = playlistDropAt(event.clientX, event.clientY);
      lastDeckDropSide = trackDeckDropSideAt(event.clientX, event.clientY);
      const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const cover = hit?.closest<HTMLElement>(`[${TRACK_COVER_DROP_TARGET_ATTR}]`);
      const id = cover ? Number(cover.dataset.kdTrackId) : NaN;
      lastCoverTrackId = Number.isFinite(id) ? id : null;
    };
    const onDragEndFallback = (event: DragEvent) => {
      const queueDrop = searchQueueDropAt(event.clientX, event.clientY) || lastQueueDrop;
      const playlistDrop =
        playlistDropAt(event.clientX, event.clientY) || lastPlaylistDrop;
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
      lastPlaylistDrop = null;
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
      if (playlistDrop) {
        const payload = claimActiveSearchDrag();
        if (payload) {
          const playlists = usePlaylistStore.getState();
          const target = resolveOneLibraryDropTarget(
            playlistDrop.devicePath,
            playlistDrop.playlistId,
            playlists.devices,
            playlists.playlistsByDevice,
          );
          if (!target) {
            const message = "OneLibrary 目标已断开或不可写，请刷新后重试";
            setSearchError(message);
            usePlaylistStore.setState({ deviceError: message });
          } else {
            usePlaylistStore.setState({ deviceError: "" });
            void enqueueSearchOneLibraryPayload(payload, target).catch((error: unknown) => {
              const message = `加入 OneLibrary 下载失败：${errorText(error)}`;
              setSearchError(message);
              usePlaylistStore.setState({ deviceError: message });
            });
          }
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
    const requestId = ++resultRequestSeqRef.current;
    setActiveStreamPlaylist(null);
    setInspectedOnlineGroup(null);
    updateStreamWorkspaceSession({ playlist: null, inspectedGroup: null, scrollTop: 0 });
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
    restore?: { inspectedGroup: string | null; scrollTop: number },
  ) => {
    const browsePlatform = STREAM_BROWSE_PLATFORMS.includes(
      playlist.platform as StreamBrowsePlatform,
    )
      ? (playlist.platform as StreamBrowsePlatform)
      : null;
    const requestId = ++resultRequestSeqRef.current;
    streamOpenNavigationRef.current = true;
    queueMicrotask(() => {
      streamOpenNavigationRef.current = false;
    });
    setRestorableWorkspaceSource("stream");
    updateStreamWorkspaceSession({
      playlist,
      inspectedGroup: restore?.inspectedGroup ?? null,
      scrollTop: restore?.scrollTop ?? 0,
    });
    setBusy(true);
    setVideo(null);
    setItems(null);
    setChosen(new Set());
    setSearchSelectionMode(false);
    setExpandedGroups(new Set());
    setCollapsedItems(new Set());
    setSourceIndex({});
    setInspectedOnlineGroup(restore?.inspectedGroup ?? null);
    setLoadingCollections(new Set());
    setSearchError("");
    revealSearchPane();
    if (browsePlatform) {
      setActiveStreamPlaylist({ platform: browsePlatform, key: playlist.key });
    }
    try {
      const response = await api.streamPlaylist(playlist, 0);
      if (requestId !== resultRequestSeqRef.current) return;
      const token = `${response.platform}:playlist:${response.key}`;
      const groups: MergedGroup[] = response.sources.map((source, index) => ({
        group_id: `${token}:${source.key}:${index}`,
        title: source.title,
        artists: source.artists,
        album: source.album,
        duration: source.duration,
        cover: source.cover || playlist.cover,
        sources: [source],
        best_source_index: 0,
        score: 0,
      }));
      const restoredInspect = restore?.inspectedGroup ?? null;
      const inspectedGroup = restoredInspect && groups.some(
        (group) => selectionKey(0, group.group_id) === restoredInspect,
      )
        ? restoredInspect
        : null;
      setInspectedOnlineGroup(inspectedGroup);
      updateStreamWorkspaceSession({ inspectedGroup });
      setItems(groups.length > 0
        ? [
            {
              entry: token,
              kind: "playlist",
              platform: response.platform,
              title: response.title || playlist.title,
              groups,
              collections: [],
              errors: {},
              error: "",
            },
          ]
        : []);
      if (browsePlatform) {
        setActiveStreamPlaylist({ platform: browsePlatform, key: playlist.key });
      }
      const scrollTop = restore?.scrollTop ?? 0;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (searchScrollRef.current) searchScrollRef.current.scrollTop = scrollTop;
        });
      });
    } catch (error) {
      if (requestId !== resultRequestSeqRef.current) return;
      const message = errorText(error);
      setItems([]);
      setActiveStreamPlaylist(null);
      updateStreamWorkspaceSession({ playlist: null, inspectedGroup: null, scrollTop: 0 });
      setRestorableWorkspaceSource("local");
      activateWorkspacePane("local");
      setSearchError(`打开歌单失败：${message}`);
      throw error;
    } finally {
      if (requestId === resultRequestSeqRef.current) setBusy(false);
    }
  }, [activateWorkspacePane, revealSearchPane]);

  const restoredWorkspaceAppliedRef = useRef(false);
  useEffect(() => {
    if (restoredWorkspaceAppliedRef.current) return;
    restoredWorkspaceAppliedRef.current = true;
    const session = restoredWorkspaceSessionRef.current;
    if (session.source === "stream" && session.stream.playlist) {
      void openStreamPlaylist(session.stream.playlist, {
        inspectedGroup: session.stream.inspectedGroup,
        scrollTop: session.stream.scrollTop,
      }).catch(() => undefined);
      return;
    }
    if (session.source === "onelibrary" && session.oneLibrary.target) {
      activateWorkspacePane("onelibrary");
      return;
    }
    setRestorableWorkspaceSource("local");
    activateWorkspacePane("local");
    if (session.local.selectedId !== null) {
      void (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const library = useLibraryStore.getState();
          if (!library.loading && library.tracks.length > 0) break;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        const trackId = session.local.selectedId as number;
        await useLibraryStore.getState().ensureTrackLoaded(trackId);
        if (!useLibraryStore.getState().tracks.some((track) => track.id === trackId)) {
          useLibraryStore.getState().select(null);
          updateLocalWorkspaceSession({ selectedId: null, scrollTop: 0 });
        }
      })();
    }
  }, [activateWorkspacePane, openStreamPlaylist]);

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
    const saved = localStorage.getItem("kd-compact-tree-expanded");
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
        const saved = localStorage.getItem("kd-compact-tree-expanded");
        setCompactTreeExpanded(saved === null ? false : saved === "1");
      } else {
        setCompactTreeExpanded(true);
      }
      return;
    }
    if (portrait) {
      localStorage.setItem("kd-compact-tree-expanded", compactTreeExpanded ? "1" : "0");
    }
  }, [compactTreeExpanded, portrait]);
  const workspacePaneSizeKey = portrait
    ? "kd-workspace-pane-sizes-portrait-v2"
    : "kd-workspace-pane-sizes-regular-v2";
  const defaultWorkspacePaneWeights = useMemo<WorkspacePaneWeights>(
    () =>
      portrait
        ? { local: 8, onelibrary: 92, search: 92 }
        : { local: 1, onelibrary: 1, search: 1 },
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
        Number.isFinite(value.onelibrary) && Number(value.onelibrary) > 0 &&
        Number.isFinite(value.search) && Number(value.search) > 0
      ) {
        setWorkspacePaneWeights({
          local: Number(value.local),
          onelibrary: Number(value.onelibrary),
          search: Number(value.search),
        });
        return;
      }
    }

    // 旧版只保存“本地 / 另一块”的百分比；迁移成按板块身份保存的权重。
    const oldPercent = Number(
      localStorage.getItem(
        portrait ? "kd-search-split-portrait" : "kd-search-split-regular",
      ),
    );
    if (Number.isFinite(oldPercent) && oldPercent > 0 && oldPercent < 100) {
      setWorkspacePaneWeights({
        local: oldPercent,
        onelibrary: 100 - oldPercent,
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
    localStorage.setItem(workspacePaneSizeKey, JSON.stringify(weights));
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
  /** 锁定只拦横屏里由歌曲/视频触发的自动展开；显式入口会解除锁定并强制打开。 */
  const [asideLocked, setAsideLocked] = useState(false);
  const asideLockedRef = useRef(false);
  useEffect(() => {
    asideLockedRef.current = asideLocked;
  }, [asideLocked]);
  /** 用户点曲目或「正在播」入口后钉住详情/歌词内容面；关闭后下一次单击曲目会重新打开。 */
  const [detailPinned, setDetailPinned] = useState(false);
  const [asideTrackId, setAsideTrackId] = useState<number | null>(null);
  const [oneLibraryDetail, setOneLibraryDetail] = useState<{
    track: OneLibraryTrack;
    target: NonNullable<typeof selectedOneLibrary>;
  } | null>(null);
  useEffect(() => {
    setOneLibraryDetail((current) => {
      if (!current || !selectedOneLibrary) return current;
      if (
        current.target.device_path !== selectedOneLibrary.device_path
        || current.target.playlist_id !== selectedOneLibrary.playlist_id
      ) return null;
      const track = selectedOneLibraryTracks.find(
        (candidate) => candidate.content_id === current.track.content_id,
      );
      return track ? { track, target: selectedOneLibrary } : null;
    });
  }, [selectedOneLibrary, selectedOneLibraryTracks]);
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
      const currentPlaying = getPlayingTrack();
      const targetId =
        trackId ?? selectSelectedTrack(useLibraryStore.getState())?.id ?? currentPlaying?.id ?? null;
      setAsideTrackId(targetId);
      if (face === "lyrics") {
        openLyricsPanel();
        const track =
          (targetId != null && currentPlaying?.id === targetId ? currentPlaying : null) ??
          (targetId != null
            ? useLibraryStore.getState().tracks.find((item) => item.id === targetId)
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
      setOneLibraryDetail(null);
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

  const inspectOneLibraryTrack = useCallback(
    (track: OneLibraryTrack, clickCount = 1) => {
      if (!selectedOneLibrary) return;
      const detail = { track, target: selectedOneLibrary };
      const playable = oneLibraryPlayableTrack(track, selectedOneLibrary);
      setOneLibraryDetail(detail);
      if (asideLockedRef.current) return;
      if (!shouldPinDetailOnClick(useTrackClickPrefs.getState(), layout)) return;
      clearDetailTimer();
      if (clickCount >= 2) {
        pinTrackAside("detail", playable.id);
        return;
      }
      detailTimerRef.current = window.setTimeout(() => {
        detailTimerRef.current = null;
        pinTrackAside("detail", playable.id);
      }, 300);
    },
    [clearDetailTimer, layout, pinTrackAside, selectedOneLibrary],
  );

  useEffect(() => {
    const scrollRow = (selector: string) => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center" });
      });
    };
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
      if (activeWorkspacePane === "onelibrary") {
        const { selectedTracks, focusedContentId, selectTrack: selectOne } = usePlaylistStore.getState();
        const current = selectedTracks.findIndex((track) => track.content_id === focusedContentId);
        const next = nextBrowseIndex(selectedTracks.length, current, delta);
        const track = selectedTracks[next];
        if (!track) return;
        selectOne(track.content_id, "replace");
        inspectOneLibraryTrack(track, 1);
        scrollRow(`[data-kd-onelibrary-content-id="${track.content_id}"]`);
        return;
      }
      const library = useLibraryStore.getState();
      const current = library.tracks.findIndex((track) => track.id === library.selectedId);
      const next = nextBrowseIndex(library.tracks.length, current, delta);
      const track = library.tracks[next];
      if (!track) return;
      selectTrack(track.id, "replace");
      window.dispatchEvent(new CustomEvent(DETAIL_EVENT, {
        detail: { source: "midi-browse", trackId: track.id },
      }));
    };
    const playableSelection = () => {
      const hint = sidebarItems().find(
        (item) => item.getAttribute(MIDI_BROWSE_ID_ATTR) === browseCursorIdRef.current
          || item.getAttribute(MIDI_BROWSE_CURSOR_ATTR) === "true",
      )?.getAttribute(MIDI_BROWSE_PANE_ATTR);
      const pane = browseFocusRef.current === "sidebar"
        ? paneForSidebarHint(hint ?? undefined)
        : activeWorkspacePane;
      if (pane === "onelibrary") {
        const { selectedTracks, focusedContentId, selectedContentIds, selectedTarget } =
          usePlaylistStore.getState();
        if (!selectedTarget) return null;
        const id = focusedContentId ?? selectedContentIds[0];
        const track = selectedTracks.find((item) => item.content_id === id) ?? selectedTracks[0];
        return track ? oneLibraryPlayableTrack(track, selectedTarget) : null;
      }
      return selectSelectedTrack(useLibraryStore.getState());
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
    window.addEventListener(MIDI_BROWSE_EVENT, onBrowse);
    return () => window.removeEventListener(MIDI_BROWSE_EVENT, onBrowse);
  }, [activateWorkspacePane, activeWorkspacePane, inspectOneLibraryTrack, selectTrack]);

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
      // 防御性兜底：移动端任何列表入口都不准通过详情抽屉遮住结果。
      if (layout === "narrow") return;
      if (asideLockedRef.current) return;
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
      pinTrackAside("detail", track.id);
    },
    [activeStreamPlaylist, layout, pinTrackAside],
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
      pinTrackAside(
        faceForTrackPin(),
        source === "player-deck" ? getPlayingTrack()?.id : undefined,
      );
      if (layout === "narrow") setSheet("aside");
    };
    window.addEventListener(DETAIL_EVENT, onDetail);
    return () => window.removeEventListener(DETAIL_EVENT, onDetail);
  }, [faceForTrackPin, layout, pinTrackAside, portrait, showTrackDetail]);

  // 显式歌词入口 / 导航恢复：store 打开歌词 → 钉住内容面并切到歌词极。
  // 从歌词极关掉 store（播放条再点一次）→ 收起整块内容面。
  // 顶栏切到详情会清 showLyrics，但 face 已是 detail，不能误关面板。
  useEffect(() => {
    if (showLyrics) {
      // 播放条歌词键属于显式入口；即使之前锁过，也按用户意图解锁并打开。
      setAsideLocked(false);
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
    showFolders ||
    showSettings ||
    showVjExport ||
    showDuplicates ||
    showVirtualDisk ||
    previewAside ||
    queueAside;
  const oneLibraryDetailTrack = oneLibraryDetail
    ? oneLibraryPlayableTrack(oneLibraryDetail.track, oneLibraryDetail.target)
    : null;
  // 歌词优先跟随正在播放；未播放时，OneLibrary 详情不能落回左侧另一首本地歌。
  const lyricsTrack = playingTrack ?? oneLibraryDetailTrack ?? selected;
  const pinnedStreamTrack = asideTrackId !== null ? streamTrackById(asideTrackId) : null;
  const detailTrack =
    asideTrackId === playingTrack?.id
      ? playingTrack
      : asideTrackId === selected?.id
        ? selected
        : pinnedStreamTrack ?? (isStreamTrack(playingTrack) ? playingTrack : selected);
  const activeOneLibraryDetail =
    oneLibraryDetail && asideTrackId === oneLibraryDetailTrack?.id ? oneLibraryDetail : null;
  const trackDetailPanel = activeOneLibraryDetail ? (
    <OneLibraryTrackDetail
      track={activeOneLibraryDetail.track}
      target={activeOneLibraryDetail.target}
    />
  ) : detailTrack ? (
    isStreamTrack(detailTrack) ? (
      <StreamTrackDetail key={detailTrack.id} track={detailTrack} />
    ) : (
      <TrackDetail key={detailTrack.id} track={detailTrack} />
    )
  ) : null;
  // 有 showLyrics / 歌词极时也要挂面板：无曲时 LyricsView 自己显示空态，
  // 不能因为 lyricsTrack 为空就把整栏吞掉（看起来像点了没反应）。
  const lyricsAside =
    !realOverlayAside && detailPinned && trackAsideFace === "lyrics";
  const detailAside =
    !realOverlayAside &&
    detailPinned &&
    trackAsideFace === "detail" &&
    Boolean(activeOneLibraryDetail || detailTrack);
  const trackAside = lyricsAside || detailAside;
  const hasAsideContent = realOverlayAside || trackAside;
  const showAside = layout === "wide" && hasAsideContent;
  const showTrackFaceSwitch = trackAside;

  const closeAside = useCallback(() => {
    setDetailPinned(false);
    setSheet(null);
    useAppStore.getState().dismissOverlay();
  }, []);

  const closeAsideForUser = useCallback(() => {
    setAsideLocked(true);
    closeAside();
  }, [closeAside]);

  /** 窄屏：点左侧文件夹后只收右侧详情抽屉；左侧展开宽度由用户拖动手势决定并持久化。 */
  const onFolderNavigate = useCallback((kind?: "onelibrary") => {
    if (streamOpenNavigationRef.current) {
      // 在线歌单已经把唯一板块切到 search；侧栏的通用 navigate 回调不能再抢回 local。
      if (layout === "narrow") closeAside();
      return;
    }
    if (kind === "onelibrary") {
      setRestorableWorkspaceSource("onelibrary");
      activateWorkspacePane("onelibrary");
    } else {
      setActiveStreamPlaylist(null);
      setRestorableWorkspaceSource("local");
      activateWorkspacePane("local");
    }
    if (layout === "narrow") closeAside();
  }, [activateWorkspacePane, layout, closeAside]);

  const toggleAside = useCallback(() => {
    if (showAside) {
      closeAsideForUser();
      return;
    }
    const onlineTrack = isStreamTrack(playingTrack) ? playingTrack : null;
    const oneLibraryTrack = oneLibraryDetail
      ? oneLibraryPlayableTrack(oneLibraryDetail.track, oneLibraryDetail.target)
      : null;
    const track =
      onlineTrack ??
      (showLyrics
        ? (playingTrack ?? selected ?? oneLibraryTrack)
        : (oneLibraryTrack ?? selected ?? playingTrack));
    if (!track) return;
    setAsideLocked(false);
    // 通用的「展开右栏」不是歌词手势：即使当前正在在线试听，也先开详情。
    // 只有已经由显式歌词入口打开的状态，恢复右栏时才继续显示歌词。
    const face = showLyrics ? "lyrics" : faceForTrackPin();
    pinTrackAside(face, track.id);
  }, [
    closeAsideForUser,
    faceForTrackPin,
    oneLibraryDetail,
    pinTrackAside,
    playingTrack,
    selected,
    showAside,
    showLyrics,
  ]);

  const asideToggle =
    layout === "wide" ? (
      <AsideToggleButton
        open={showAside}
        canOpen={Boolean(oneLibraryDetail ?? selected ?? playingTrack)}
        onToggle={toggleAside}
      />
    ) : null;

  const queuePinButton = queueAside ? (
    <button
      type="button"
      className="kd-aside-head-close"
      data-pinned={queuePinned ? "true" : undefined}
      aria-pressed={queuePinned}
      aria-label={queuePinned ? "取消固定下载队列" : "固定下载队列"}
      title={queuePinned ? "下载队列已固定；点击取消固定" : "固定下载队列，不被选歌和切换列表顶掉"}
      onClick={() => setQueuePinned(!queuePinned)}
    >
      <Pin size={13} fill={queuePinned ? "currentColor" : "none"} />
    </button>
  ) : null;

  const onTrackAsideFace = useCallback(
    (face: TrackAsideFace) => {
      trackAsideFaceRef.current = face;
      setTrackAsideFace(face);
      setPreferredAsideFace(face);
      if (face === "lyrics") {
        openLyricsPanel();
        void ensureLyrics(
          getPlayingTrack()
          ?? oneLibraryDetailTrack
          ?? selectSelectedTrack(useLibraryStore.getState()),
        );
        return;
      }
      showTrackDetail();
    },
    [oneLibraryDetailTrack, openLyricsPanel, setPreferredAsideFace, showTrackDetail],
  );

  const asideLabel = showFolders
      ? "文件夹"
    : showSettings
      ? "设置"
      : showVjExport
        ? "导出 VJ"
        : showDuplicates
          ? "曲库优化分析"
          : showVirtualDisk
            ? "OneLibrary"
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
    <FolderTree
      onNavigate={onFolderNavigate}
      onOpenStreamPlaylist={openStreamPlaylist}
      activeStreamPlaylist={activeStreamPlaylist}
    />
  ) : showSettings ? (
    <SettingsPanel />
  ) : showVjExport ? (
    <VjExportPanel />
  ) : showDuplicates ? (
    <DuplicateAnalysisPanel
      all={duplicateAll}
      folders={duplicateFolders}
      initialIncludeSubfolders={duplicateIncludeSubfolders}
    />
  ) : showVirtualDisk ? (
    <VirtualDiskPanel />
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
  ) : detailAside ? trackDetailPanel : null;
  const queueOpen =
    showQueue &&
    !showSettings &&
    !showFolders &&
    !showPreview &&
    !showVjExport &&
    !showDuplicates &&
    !showVirtualDisk &&
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
    if (!(showSettings || showFolders || showVjExport || showDuplicates || showVirtualDisk || showQueue)) return;
    setDetailPinned(false);
    setAsideLocked(false);
    if (layout === "narrow") setSheet("aside");
  }, [
    layout,
    showSettings,
    showQueue,
    showFolders,
    showVjExport,
    showDuplicates,
    showVirtualDisk,
    settingsPanelEpoch,
    foldersPanelEpoch,
    vjExportPanelEpoch,
    duplicatesPanelEpoch,
    virtualDiskPanelEpoch,
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
      const saved = localStorage.getItem(`kd-split-${side}`);
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
        if (dirty) void saveSettings(patch);
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
    const resultGeneration = resultRequestSeqRef.current;
    const token = `${collection.platform}:${collection.kind}:${collection.key}`;
    setSearchError("");
    setLoadingCollections((current) => new Set(current).add(token));
    try {
      const response = await api.resolveCollection(collection, 0);
      if (resultGeneration !== resultRequestSeqRef.current) return;
      const resolved = resolvedCollectionItem(collection, response);
      setItems((current) =>
        current ? promoteResolvedCollection(current, collection, resolved) : current,
      );
      // 提升新包会改变所有 item 下标；当前选择键仍包含下标，先清掉旧选择/
      // 折叠状态，避免它们意外命中新位置并下载错误来源。
      setChosen(new Set());
      setCollapsedItems(new Set());
      setExpandedGroups(new Set());
      setSourceIndex({});
      if (
        collection.kind === "playlist" &&
        (collection.platform === "wyy" || collection.platform === "qqm")
      ) {
        setActiveStreamPlaylist({ platform: collection.platform, key: collection.key });
      }
      revealLoadedCollection();
    } catch (error) {
      if (resultGeneration !== resultRequestSeqRef.current) return;
      setSearchError(`载入集合失败：${errorText(error)}`);
    } finally {
      if (resultGeneration !== resultRequestSeqRef.current) return;
      setLoadingCollections((current) => {
        const next = new Set(current);
        next.delete(token);
        return next;
      });
    }
  }, [revealLoadedCollection]);

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
        one_library_target: oneLibraryPaneVisible ? selectedOneLibrary : null,
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
  }, [chosenSources, settings?.default_quality, settings?.video_max_height, settings?.video_transcode, oneLibraryPaneVisible, selectedOneLibrary, refreshStats, videoAudioOnly]);

  // 曲目表 / 搜索结果：Cmd/Ctrl + A · C · X · V（Option+V 强制移动）。
  useLibraryClipboard({
    active: () => Boolean(searchPaneVisible && items && items.length > 0),
    preferred: () => activeWorkspacePane === "search",
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
        await enqueueMediaDownloads(sources, {
          quality: settings?.default_quality ?? null,
          one_library_target: oneLibraryPaneVisible ? selectedOneLibrary : null,
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
    [items, sourceIndex, settings?.default_quality, settings?.video_max_height, settings?.video_transcode, oneLibraryPaneVisible, selectedOneLibrary, refreshStats, videoAudioOnly],
  );

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
          one_library_target: oneLibraryPaneVisible ? selectedOneLibrary : null,
        });
        void refreshStats();
      } catch (error) {
        setQueueError(`加入队列失败：${errorText(error)}`);
      }
    },
    [sourceIndex, settings?.default_quality, oneLibraryPaneVisible, selectedOneLibrary, refreshStats],
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
    showVjExport,
    showVirtualDisk,
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
              workMode={workMode}
              onWorkModeChange={onWorkModeChange}
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
              style={{ minWidth: 0 }}
              data-kd-browse-focus={browseFocus === "sidebar" ? "sidebar" : undefined}
            >
              <NarrowFolderRail
                expanded={compactTreeExpanded}
                onNavigate={onFolderNavigate}
                onOpenStreamPlaylist={openStreamPlaylist}
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
            <div className="kd-table-wrap">
            {/* 搜索带可收起；查询文字、来源选择和已有结果都保留。 */}
            {aggregateSearchOpen ? (
              <div
                className="kd-search-band-host"
                data-open={aggregateSearchRevealed || undefined}
              >
                <div className="kd-search-band">
                  <SearchBar
                    query={query}
                    searchKind={searchKind}
                    searchKinds={searchKinds}
                    onSearchKindChange={setSearchKind}
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
                  <span className="kd-search-band-trailing">
                    <span className="kd-search-band-sep" aria-hidden="true" />
                    <button
                      type="button"
                      className="kd-activity-search-toggle"
                      data-action="dismiss-search-band"
                      aria-label="收起混合搜索"
                      title="收起混合搜索"
                      onClick={dismissAggregateSearch}
                    >
                      <PanelTopClose size={14} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </span>
                </div>
              </div>
            ) : null}
            <div className="kd-local-list-slot" data-aside={showAside ? "open" : "closed"}>
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
                  <LibraryWorkRail
                    showDownloads={!searchPaneVisible}
                    asideToggle={localPaneVisible && !showAside ? asideToggle : undefined}
                    aggregateSearchOpen={aggregateSearchOpen}
                    onOpenAggregateSearch={openAggregateSearch}
                    localPanePinned={localPanePinned}
                    onLocalPanePinnedChange={layout === "wide" ? setLocalPanePinned : undefined}
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
                    onScrollEnd={() => void loadMore()}
                    reorderable={Boolean(filter.folder) && !filter.folderDeep && !isOutsideFolder(filter.folder)}
                    onReorder={(ids, targetId, before) => void reorderTracks(ids, targetId, before)}
                  />
                </div>

                <div
                  className="kd-workspace-pane kd-workspace-pane-onelibrary"
                  data-workspace-pane-kind="onelibrary"
                  data-pane-visible={oneLibraryPaneVisible ? "true" : undefined}
                  data-pane-active={activeWorkspacePane === "onelibrary" ? "true" : undefined}
                  data-pane-drop-target={workspacePaneDropTarget === "onelibrary" ? "true" : undefined}
                  data-pane-dragging={dragWorkspacePane === "onelibrary" ? "true" : undefined}
                  style={{ order: paneOrder("onelibrary") }}
                  data-drop-offered={
                    oneLibraryPaneWritable && (onlineAudioDragActive || localTrackDragActive)
                      ? "true"
                      : undefined
                  }
                  data-drop-active={oneLibraryDropActive ? "true" : undefined}
                  {...(oneLibraryPaneWritable && selectedOneLibrary
                    ? {
                        [PLAYLIST_DROP_ID_ATTR]: String(selectedOneLibrary.playlist_id),
                        [PLAYLIST_DROP_DEVICE_ATTR]: selectedOneLibrary.device_path,
                      }
                    : {})}
                  onPointerDownCapture={() => focusWorkspacePane("onelibrary")}
                  onFocusCapture={() => focusWorkspacePane("onelibrary")}
                  onDragOver={(event) => {
                    if (
                      !oneLibraryPaneWritable ||
                      (!isTrackDrag(event) && !isSearchDownloadDrag(event))
                    ) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setOneLibraryDropActive(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setOneLibraryDropActive(false);
                    }
                  }}
                  onDrop={(event) => {
                    setOneLibraryDropActive(false);
                    if (!oneLibraryPaneWritable || !selectedOneLibrary) return;
                    if (isSearchDownloadDrag(event)) {
                      event.preventDefault();
                      event.stopPropagation();
                      void enqueueSearchOneLibraryDrop(event, selectedOneLibrary).catch(
                        (error: unknown) =>
                          usePlaylistStore.setState({ deviceError: errorText(error) }),
                      );
                      return;
                    }
                    if (!isTrackDrag(event)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const ids = readTrackDragIds(event.dataTransfer);
                    finishTrackDrop();
                    if (ids.length > 0) {
                      void usePlaylistStore
                        .getState()
                        .addTracks(
                          selectedOneLibrary.device_path,
                          selectedOneLibrary.playlist_id,
                          ids,
                        )
                        .catch(() => undefined);
                    }
                  }}
                >
                  {selectedOneLibrary ? (
                    <>
                      <button
                        type="button"
                        className="kd-workspace-pane-grip"
                        {...workspacePaneGripProps("onelibrary")}
                      />
                      <div className="kd-workspace-drop-overlay" aria-hidden="true">
                        <span>放入 {selectedOneLibrary.playlist_name}</span>
                      </div>
                      <OneLibraryWorkRail
                        onCollapse={collapseOneLibraryPane}
                        asideToggle={
                          !localPaneVisible && !searchPaneVisible && !showAside
                            ? asideToggle
                            : undefined
                        }
                      />
                      <OneLibraryTrackTable
                        layout={layout}
                        onInspect={inspectOneLibraryTrack}
                        shortcutActive={activeWorkspacePane === "onelibrary"}
                      />
                    </>
                  ) : null}
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

                {hasResults && (
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
                      <button
                        type="button"
                        className="kd-workspace-pane-grip"
                        {...workspacePaneGripProps("search")}
                      />
                      <SearchWorkRail
                        items={items ?? []}
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
                        asideToggle={
                          !localPaneVisible && !oneLibraryPaneVisible && !showAside
                            ? asideToggle
                            : undefined
                        }
                        onClose={() => {
                          resultRequestSeqRef.current += 1;
                          setBusy(false);
                          setHasResults(false);
                          setActiveStreamPlaylist(null);
                          setInspectedOnlineGroup(null);
                          updateStreamWorkspaceSession({
                            playlist: null,
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
                          onToggleSelect={toggleSelect}
                          onToggleExpand={toggleExpand}
                          onPickSource={pickSource}
                          onToggleItem={toggleItem}
                          onToggleItemAll={toggleItemAll}
                          onToggleAll={toggleAll}
                          onDownloadItem={(index) => void downloadItem(index)}
                          onDownloadGroup={(group) => void downloadGroup(group)}
                          onDownloadSelected={() => void addToQueue()}
                          onInspectGroup={inspectOnlineGroup}
                          onLoadCollection={(collection) => void loadCollection(collection)}
                          loadingCollections={loadingCollections}
                        />
                      </div>
                    </div>
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
                      tools={queuePinButton}
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
            tools={queuePinButton}
            onClose={closeAsideForUser}
          >
            {asidePanel}
          </Sheet>
        )}
        </div>
      </div>
    </section>
  );
}
