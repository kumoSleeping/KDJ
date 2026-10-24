import { FOLDER_DND_TYPE, beginTemporaryFolderDrag, endTemporaryFolderDrag } from "../../lib/temporaryFolderDrag";
import { createPortal, flushSync } from "react-dom";
import { useLayoutSignals } from "../../lib/useLayoutMode";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownAZ,
  ChevronDown,
  ChevronRight,
  History,
  ListOrdered,
  BarChart3,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  FileMusic,
  Folder,
  FolderDown,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Files,
  HardDrive,
  Heart,
  Library,
  ListMusic,
  ListX,
  LoaderCircle,
  LogIn,
  MoreHorizontal,
  Music2,
  PencilLine,
  Podcast,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api } from "../../lib/api";
import { pickAndScanFiles, pickAndScanFolders } from "../../lib/importFolders";
import { isPlatformEnabled } from "../../lib/enabledPlatforms";
import {
  FOLDER_DROP_PATH_ATTR,
  SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR,
  SEARCH_DEFAULT_DOWNLOAD_SENTINEL,
} from "../../lib/folderDrop";
import { expandNewRootPaths } from "../../lib/folderExpansion";
import {
  readSidebarTreeState,
  writeLocalFolderTreeState,
} from "../../lib/sidebarState";
import {
  mergeSidebarRootOrder,
  moveSidebarRootOrder,
  orderSidebarRootItems,
  readSidebarRootOrder,
  writeSidebarRootOrder,
  type SidebarRootDropEdge,
} from "../../lib/sidebarRootOrder";
import { resolveLibraryPasteOp } from "../../lib/libraryPaste";
import { isOutsideFolder, OUTSIDE_FOLDER } from "../../lib/outsideFolder";
import {
  enqueueSearchDrop,
  isSearchDownloadDrag,
} from "../../lib/searchDrag";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import {
  orderStreamPlaylists,
  STREAM_PLAYLIST_ORDERS,
  type StreamPlaylistOrder,
  type StreamPlaylistRecentEntry,
} from "../../lib/streamPlaylistOrder";
import { useStreamPlaylistOrderStore } from "../../stores/streamPlaylistOrderStore";
import { withForegroundStreamPlaceholder } from "../../lib/streamStartup";
import {
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_DND_TYPE,
} from "../../lib/trackDrag";
import { useAppStore } from "../../stores/appStore";
import { openLoginSettings } from "../../lib/openLoginSettings";
import { useLibraryStore } from "../../stores/libraryStore";
import { useSidebarVisibilityStore } from "../../stores/sidebarVisibilityStore";
import {
  STREAM_BROWSE_PLATFORMS,
  STREAM_PLAYLIST_FOCUS_MAX_AGE_MS,
  streamAccountBinding,
  useStreamBrowseStore,
  type ActiveStreamPlaylist,
  type StreamBrowsePlatform,
  type StreamPlaylistSectionId,
} from "../../stores/streamBrowseStore";
import type { Account, AccountState, FolderNode, FolderTree as FolderTreeData, StreamPlaylist } from "../../types";
import { ContextMenu, InlineNotice, Sheet } from "../common";
import { PlatformMark } from "../download/PlatformMark";
import { isMidiBrowseActivate, MIDI_BROWSE_ID_ATTR, midiBrowseItemProps } from "../../lib/midiLibraryNav";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import { useSidebarCounts } from "../../lib/sidebarCounts";
import "./FolderTree.css";
import { createSidebarMotion, type SidebarMotion } from "./sidebarMotion";
import { setDragGhost } from "../common/dragGhost";
import "../common/DragGhost.css";

/** Use the server's actual paths for both Windows and Unix, including selected descendants. */
function relocatedFolderPath(tree: FolderTreeData, current: string, source: string, parent: string, name: string): string | undefined {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(source);
  const key = (path: string) => {
    const normalized = (windows ? path.replaceAll("\\", "/") : path).replace(/\/$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const sourceKey = key(source);
  const currentKey = key(current);
  if (currentKey !== sourceKey && !currentKey.startsWith(`${sourceKey}/`)) return undefined;
  const all: FolderNode[] = [];
  const visit = (nodes: FolderNode[]) => { for (const node of nodes) { all.push(node); visit(node.children); } };
  visit(tree.roots);
  const destination = all.find((node) => key(node.parent) === key(parent) && node.name === name.trim());
  if (!destination) return undefined;
  const expected = key(destination.path) + currentKey.slice(sourceKey.length);
  return all.find((node) => key(node.path) === expected)?.path;
}

/** @deprecated 请从 `lib/trackDrag` 引用；保留 re-export 以免旧 import 断掉。 */
export { TRACK_DND_TYPE };
/** 拖文件夹换顺序用的 MIME，和上面分开，dragover 时才好区别对待。 */
const ALL_TRACKS_DROP_TARGET = "__kd_all_tracks__";
const ALL_TRACKS_ROOT_ID = "library:all";
const OUTSIDE_ROOT_ID = "library:outside";

interface StreamRoot {
  id: StreamBrowsePlatform;
  label: string;
  /** A root that stands for more than one platform: each has its own folder inside it. */
  members?: readonly StreamBrowsePlatform[];
}

const STREAM_ROOTS: ReadonlyArray<StreamRoot> = [
  { id: "wyy", label: "NetEase" },
  { id: "qqm", label: "Q Music" },
  { id: "soundcloud", label: "SoundCloud" },
  // YouTube Music and YouTube share one login, so they share one row; the music and the video
  // playlists stay apart in a folder each.
  { id: "youtube", label: "YouTube", members: ["ytm", "youtube"] },
  { id: "bilibili", label: "Bilibili" },
];

/** The name of a platform's own folder inside a root that stands for several. */
const STREAM_MEMBER_LABEL: Partial<Record<StreamBrowsePlatform, string>> = {
  ytm: "音乐",
  youtube: "视频",
};

function rootMembers(root: StreamRoot): StreamBrowsePlatform[] {
  return root.members ? [...root.members] : [root.id];
}

/** The sidebar root a platform's playlists are shown under. */
function streamRootOf(platform: StreamBrowsePlatform): StreamRoot {
  return STREAM_ROOTS.find((root) => rootMembers(root).includes(platform)) ?? { id: platform, label: platform };
}

function streamRootEnabled(settings: Parameters<typeof isPlatformEnabled>[0], root: StreamRoot): boolean {
  return rootMembers(root).some((platform) => isPlatformEnabled(settings, platform));
}

/** The account state a root shows: a member that can be browsed wins, then an expired one. */
function rootAccountState(
  accounts: Account[],
  members: StreamBrowsePlatform[],
): AccountState | undefined {
  const states = members.map((platform) => accounts.find((account) => account.platform === platform)?.state);
  return states.find(accountCanBrowse)
    ?? (states.includes(undefined) ? undefined : states.includes("expired") ? "expired" : states[0]);
}

const STREAM_ORDER_ICON: Record<StreamPlaylistOrder, typeof History> = {
  recent: History,
  platform: ListOrdered,
  title: ArrowDownAZ,
};

/** A platform root's menu: read its playlists again, how they are ordered, and 收起. */
function useStreamRootMenu(onRefresh: (platform: StreamBrowsePlatform) => void) {
  const [menu, setMenu] = useState<{
    platform: StreamBrowsePlatform;
    x: number;
    y: number;
  } | null>(null);
  const orders = useStreamPlaylistOrderStore((state) => state.orders);
  const members = menu ? rootMembers(streamRootOf(menu.platform)) : [];
  const order = orders[members[0]] ?? "recent";
  return {
    openStreamRootMenu(event: React.MouseEvent, platform: StreamBrowsePlatform) {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ platform, x: event.clientX, y: event.clientY });
    },
    streamRootMenu: menu && (
      <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onRefresh(menu.platform);
            setMenu(null);
          }}
        >
          <RefreshCw size={12} />
          刷新
        </button>
        <div className="kd-menu-heading" role="presentation">排序</div>
        {STREAM_PLAYLIST_ORDERS.map((item) => {
          const Icon = STREAM_ORDER_ICON[item.id];
          return (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={order === item.id}
              onClick={() => {
                useStreamPlaylistOrderStore.getState().setOrder(members, item.id);
                setMenu(null);
              }}
            >
              <Icon size={12} />
              {item.label}
            </button>
          );
        })}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            useSidebarVisibilityStore.getState().hidePlatform(menu.platform);
            setMenu(null);
          }}
        >
          <ChevronDown size={12} />
          收起
        </button>
      </ContextMenu>
    ),
  };
}

type SidebarRootItem =
  | { id: typeof ALL_TRACKS_ROOT_ID; kind: "all" }
  | {
      id: `stream:${StreamBrowsePlatform}`;
      kind: "stream";
      streamRoot: StreamRoot;
    }
  | { id: `local:${string}`; kind: "local"; root: FolderNode }
  | { id: typeof OUTSIDE_ROOT_ID; kind: "outside" };

const NARROW_RAIL_SOURCE_KEY = "kd-narrow-rail-source-v1";

type NarrowRailSource =
  | { kind: "local"; rootPath: string }
  | { kind: "stream"; platform: StreamBrowsePlatform };

export interface StreamPlaylistBrowseProps {
  onOpenStreamPlaylist?: (playlist: StreamPlaylist) => void | Promise<void>;
  /** 传 null 可明确清掉远程高亮；省略则沿用内存 store 中最近点开的歌单。 */
  activeStreamPlaylist?: ActiveStreamPlaylist | null;
}

interface StreamPlaylistSection {
  id: StreamPlaylistSectionId;
  label: string;
  playlists: StreamPlaylist[];
}

/** 网易云账号里的播客，排在歌单之后；展开后是一期期节目。 */
const PODCAST_SECTIONS: { id: StreamPlaylistSectionId; label: string }[] = [
  { id: "podcast_created", label: "创建的播客" },
  { id: "podcast_subscribed", label: "订阅的播客" },
  { id: "podcast_recent", label: "最近播放的播客" },
];

/** 网易云的播客和声音列表（含红心的「我喜欢的声音」）；数量按期计。 */
function isPodcast(playlist: StreamPlaylist): boolean {
  return playlist.origin?.startsWith("podcast_") === true;
}

function streamPlaylistSections(
  playlists: StreamPlaylist[],
  platform: StreamBrowsePlatform,
): StreamPlaylistSection[] {
  const created = playlists.filter(
    (playlist) => !playlist.is_favorite && playlist.origin === "created",
  );
  const collected = playlists.filter(
    (playlist) => !playlist.is_favorite && playlist.origin === "collected",
  );
  const favorite = playlists.filter(
    (playlist) => playlist.is_favorite || playlist.origin === "favorite",
  );
  const podcasts = PODCAST_SECTIONS.map((section) => ({
    ...section,
    playlists: playlists.filter(
      (playlist) => !playlist.is_favorite && playlist.origin === section.id,
    ),
  }));
  const known = new Set([
    ...favorite,
    ...created,
    ...collected,
    ...podcasts.flatMap((section) => section.playlists),
  ]);
  const other = playlists.filter((playlist) => !known.has(playlist));
  return [
    {
      id: "created",
      label: platform === "bilibili" ? "Favorite folders" : "创建的歌单",
      playlists: created,
    },
    { id: "collected", label: "收藏的歌单", playlists: collected },
    {
      id: "other",
      label: platform === "ytm" || platform === "youtube" ? "播放列表" : "其他歌单",
      playlists: other,
    },
    ...podcasts,
  ].filter((section) => section.playlists.length > 0) as StreamPlaylistSection[];
}

function accountCanBrowse(state: AccountState | undefined): boolean {
  return state === "valid" || state === "unknown";
}

function streamPlaylistCountLabel(playlist: StreamPlaylist): string {
  if (playlist.platform === "bilibili") return `${playlist.count} videos`;
  if (isPodcast(playlist)) return `${playlist.count} 期`;
  const unit = playlist.platform === "youtube" ? "个视频" : "首";
  return `${playlist.count} ${unit}`;
}

function readNarrowRailSource(): NarrowRailSource | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(
      readLocalStorage(NARROW_RAIL_SOURCE_KEY) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      record.kind === "stream" &&
      typeof record.platform === "string" &&
      STREAM_BROWSE_PLATFORMS.includes(record.platform as StreamBrowsePlatform)
    ) {
      return { kind: "stream", platform: streamRootOf(record.platform as StreamBrowsePlatform).id };
    }
    if (
      record.kind === "local" &&
      typeof record.rootPath === "string" &&
      record.rootPath.length <= 4096
    ) {
      return { kind: "local", rootPath: record.rootPath };
    }
  } catch {
    // localStorage 受限或旧值损坏时回到本地曲库，不阻断侧栏。
  }
  return null;
}

function writeNarrowRailSource(source: NarrowRailSource): void {
  writeLocalStorageNow(NARROW_RAIL_SOURCE_KEY, JSON.stringify(source));
}

/**
 * 宽树和手机窄轨互斥挂载，但两者都必须拥有同一套账号绑定与持久缓存。
 * 绑定账号只恢复本地目录；平台请求由展开、刷新，以及已展开的根在账号就绪和
 * 窗口回到前台时触发（都经过缓存时效判断，不会每次都访问平台）。
 * enabled=false 时保留 hook 顺序却不注册副作用，展开态交给内部 FolderTree 接管。
 */
function useStreamBrowseLifecycle(enabled: boolean) {
  const accounts = useAppStore((state) => state.accounts);
  const accountsError = useAppStore((state) => state.accountsError);
  const appBooting = useAppStore((state) => state.booting);
  const bindStreamAccount = useStreamBrowseStore((state) => state.bindAccount);
  const refreshStreamIfStale = useStreamBrowseStore((state) => state.refreshIfStale);
  useEffect(() => {
    if (!enabled) return;
    for (const platform of STREAM_BROWSE_PLATFORMS) {
      const account = accounts.find((candidate) => candidate.platform === platform);
      if (account) {
        // 只同步账号匹配的持久缓存；不能因为侧栏挂载就访问平台。
        void bindStreamAccount(platform, streamAccountBinding(account));
      } else if (!appBooting && !accountsError) {
        // 账号接口明确返回空才按登出处理；接口失败不能误删可用缓存。
        void bindStreamAccount(platform, null);
      }
    }
  }, [accounts, accountsError, appBooting, bindStreamAccount, enabled]);

  // An open root shows the account as it is now. A root left open at the last quit used to show
  // the list saved then until it was closed and opened again, so a playlist made since never
  // came; it is read once the accounts are known, and again when the window comes back to the
  // front (a playlist just made on the phone or the platform's page).
  useEffect(() => {
    if (!enabled) return;
    const refreshOpenRoots = (maxAgeMs?: number) => {
      const { expanded } = useStreamBrowseStore.getState();
      for (const platform of STREAM_BROWSE_PLATFORMS) {
        if (!expanded[streamRootOf(platform).id]) continue;
        const state = accounts.find((account) => account.platform === platform)?.state;
        if (accountCanBrowse(state)) void refreshStreamIfStale(platform, { maxAgeMs });
      }
    };
    refreshOpenRoots();
    const onFront = () => {
      if (document.visibilityState === "visible") refreshOpenRoots(STREAM_PLAYLIST_FOCUS_MAX_AGE_MS);
    };
    window.addEventListener("focus", onFront);
    document.addEventListener("visibilitychange", onFront);
    return () => {
      window.removeEventListener("focus", onFront);
      document.removeEventListener("visibilitychange", onFront);
    };
  }, [accounts, enabled, refreshStreamIfStale]);

  return { accounts, accountsError };
}

/** Rows that appear this long after the tree and its roots were shown still belong to its arrival. */
const TREE_SHOWN_SETTLE_MS = 250;
const TREE_SHOWN_LIMIT_MS = 3000;
/** How long an opened playlist keeps its place before it goes to the front of its list. */
const RECENT_MOVE_WAIT_MS = 600;

/**
 * The recency the sidebar orders its playlists by, as it is shown. The store records an opened
 * playlist at once (and saves it); the list on screen follows a beat later, and then as a
 * movement: the rows travel to their new places (`motion.reorder`). Opening another playlist
 * during the wait starts the wait again, and everything opened by then moves in one go.
 * `rows` selects the playlist rows inside `scope`; while none is on screen the order simply
 * follows the store.
 */
function useShownRecents(
  recents: Record<StreamBrowsePlatform, StreamPlaylistRecentEntry[]>,
  motion: SidebarMotion,
  scope: { readonly current: Element | null },
  rows: string,
) {
  const [shown, setShown] = useState(recents);
  const latest = useRef(recents);
  latest.current = recents;
  useEffect(() => {
    if (shown === recents) return;
    if (!scope.current?.querySelector(rows)) {
      setShown(recents);
      return;
    }
    const timer = window.setTimeout(() => {
      motion.reorder(
        scope.current,
        rows,
        (row) => row.getAttribute(MIDI_BROWSE_ID_ATTR) ?? "",
        () => flushSync(() => setShown(latest.current)),
      );
    }, RECENT_MOVE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [motion, recents, rows, scope, shown]);
  return shown;
}

function trackIdsFromDrop(event: React.DragEvent): number[] {
  const ids = readTrackDragIds(event.dataTransfer);
  finishTrackDrop();
  return ids;
}

const cleanPath = (path: string | undefined) => (path ?? "").replace(/\/+$/, "");

function folderPurpose(path: string, audioDir?: string, videoDir?: string) {
  const normalized = cleanPath(path);
  const audio = normalized !== "" && normalized === cleanPath(audioDir);
  const video = normalized !== "" && normalized === cleanPath(videoDir?.trim() ? videoDir : audioDir);
  if (!audio && !video) return null;
  return {
    audio,
    video,
    label: audio && video ? "默认音乐和视频下载目录" : audio ? "默认音乐下载目录" : "默认视频下载目录",
  };
}

/**
 * Every sidebar icon is drawn about one pixel thick, whatever its size: the tree's
 * row icons, its disclosure chevrons and the compact rail's larger glyphs.
 */
const ROW_ICON = { size: 15, strokeWidth: 1.6 } as const;
const RAIL_ICON = { size: 17, strokeWidth: 1.45 } as const;
const CHEVRON = { size: 12, strokeWidth: 2 } as const;

/** Indent is a property of the row, so every row type shares one column grid. */
const depthStyle = (depth: number) => ({ "--kd-depth": depth }) as CSSProperties;

/** One chevron that turns, instead of two glyphs that swap. */
function Disclosure({ open }: { open: boolean }) {
  return (
    <ChevronRight
      {...CHEVRON}
      className="kd-folder-chevron"
      data-open={open || undefined}
      aria-hidden="true"
    />
  );
}

/** A compact-rail button is always a glyph over a one-line name. */
function RailContent({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <>
      <span className="kd-rail-icon">{icon}</span>
      <span className="kd-rail-label">{label}</span>
    </>
  );
}

/**
 * 文件夹类型与“默认下载落点”只占一个图标位。
 * 旧版在 Folder 后面再排媒体类型图标，看起来像多个独立操作；
 * 默认目录现在直接用 FolderDown，具体是音乐、视频还是两者仍由 title 说明。
 */
function FolderGlyph({
  path,
  audioDir,
  videoDir,
  root,
  open,
  icon,
}: {
  path: string;
  audioDir?: string;
  videoDir?: string;
  root: boolean;
  open: boolean;
  icon: { size: number; strokeWidth: number };
}) {
  const purpose = folderPurpose(path, audioDir, videoDir);
  if (purpose) {
    return (
      <span className="kd-folder-purpose" title={purpose.label} aria-label={purpose.label}>
        <FolderDown {...icon} />
      </span>
    );
  }
  return (
    root ? <HardDrive {...icon} /> : open ? <FolderOpen {...icon} /> : <Folder {...icon} />
  );
}

export { pickAndScanFolders };

function flattenFolders(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenFolders(node.children)]);
}

/**
 * 窄屏常驻文件夹栏。收起时也能直接切换添加/全库/任意文件夹；
 * 展开时是占据布局宽度的真正侧栏，不覆盖列表，也不再退化成抽屉。
 */
export function NarrowFolderRail({
  expanded,
  onNavigate,
  onOpenStreamPlaylist,
  activeStreamPlaylist,
}: {
  expanded: boolean;
  /** 点选文件夹 / 全部曲目等导航项后回调（窄屏收右侧抽屉用）。 */
  onNavigate?: () => void;
} & StreamPlaylistBrowseProps) {
  const { portrait } = useLayoutSignals();
  const [pickerOpen, setPickerOpen] = useState(false);
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => { setPickerOpen(false); }, [portrait, expanded]);
  const folders = useLibraryStore((state) => state.folders);
  const filter = useLibraryStore((state) => state.filter);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const settings = useAppStore((state) => state.settings);
  const hiddenPlatforms = useSidebarVisibilityStore((state) => state.hiddenPlatforms);
  const { openStreamRootMenu, streamRootMenu } = useStreamRootMenu((rootId) => {
    for (const platform of rootMembers(streamRootOf(rootId))) {
      const state = accounts.find((account) => account.platform === platform)?.state;
      if (accountCanBrowse(state)) void loadStreamPlaylists(platform, true);
    }
  });
  const applyFolderOp = useLibraryStore((state) => state.applyFolderOp);
  const startScan = useLibraryStore((state) => state.startScan);
  const streamPlaylists = useStreamBrowseStore((state) => state.playlists);
  const streamLoading = useStreamBrowseStore((state) => state.loading);
  const streamErrors = useStreamBrowseStore((state) => state.errors);
  const streamSectionExpanded = useStreamBrowseStore((state) => state.sectionExpanded);
  const streamRecentlyOpened = useStreamBrowseStore((state) => state.recentlyOpened);
  const cachedActiveStreamPlaylist = useStreamBrowseStore((state) => state.active);
  const startupForeground = useStreamBrowseStore((state) => state.startupForeground);
  const loadStreamPlaylists = useStreamBrowseStore((state) => state.loadPlaylists);
  const setStreamSectionExpanded = useStreamBrowseStore(
    (state) => state.setSectionExpanded,
  );
  const setActiveStreamPlaylist = useStreamBrowseStore((state) => state.setActive);
  const setStreamError = useStreamBrowseStore((state) => state.setError);
  const { accounts, accountsError } = useStreamBrowseLifecycle(!expanded);
  const [error, setError] = useState("");
  const [narrowDrop, setNarrowDrop] = useState("");
  const sourceListRef = useRef<HTMLDivElement | null>(null);
  const [sourceHeight, setSourceHeight] = useState<number | null>(() => {
    const saved = Number(readLocalStorage("kd-narrow-rail-source-height"));
    return Number.isFinite(saved) && saved >= 40 ? saved : null;
  });
  const sourceHeightRef = useRef(sourceHeight);
  const resizeStartRef = useRef<{ y: number; height: number } | null>(null);
  const setRailSourceHeight = (height: number) => {
    const list = sourceListRef.current;
    const rail = list?.parentElement;
    if (!list || !rail) return;
    const max = rail.getBoundingClientRect().bottom - list.getBoundingClientRect().top - 60;
    const next = Math.round(Math.max(40, Math.min(max, height)));
    sourceHeightRef.current = next;
    setSourceHeight(next);
  };
  const cachedNarrowActiveStreamPlaylist =
    cachedActiveStreamPlaylist &&
    STREAM_BROWSE_PLATFORMS.includes(cachedActiveStreamPlaylist.platform)
      ? {
          platform: cachedActiveStreamPlaylist.platform,
          key: cachedActiveStreamPlaylist.key,
        }
      : null;
  const effectiveActiveStreamPlaylist =
    activeStreamPlaylist === undefined
      ? cachedNarrowActiveStreamPlaylist
      : activeStreamPlaylist;
  const [narrowSource, setNarrowSource] = useState<NarrowRailSource>(() => {
    const foregroundPlatform = startupForeground?.playlist.platform as
      | StreamBrowsePlatform
      | undefined;
    // 前台在线会话优先于窄轨自身的旧来源偏好。否则桌面上能看到已恢复的高亮，
    // 竖屏首帧却仍停在本地目录，要等请求完成后再“跳”到在线来源。
    if (
      foregroundPlatform &&
      STREAM_BROWSE_PLATFORMS.includes(foregroundPlatform)
    ) {
      return { kind: "stream", platform: foregroundPlatform };
    }
    const storedSource = readNarrowRailSource();
    if (storedSource) return storedSource;
    if (effectiveActiveStreamPlaylist) {
      return { kind: "stream", platform: streamRootOf(effectiveActiveStreamPlaylist.platform).id };
    }
    return { kind: "local", rootPath: "" };
  });
  const effectiveActiveStreamKey = effectiveActiveStreamPlaylist
    ? `${effectiveActiveStreamPlaylist.platform}:${effectiveActiveStreamPlaylist.key}`
    : "";
  const previousEffectiveActiveStreamKeyRef = useRef(effectiveActiveStreamKey);
  const roots = folders?.roots ?? [];

  useEffect(() => writeNarrowRailSource(narrowSource), [narrowSource]);

  useEffect(() => {
    const previousKey = previousEffectiveActiveStreamKeyRef.current;
    previousEffectiveActiveStreamKeyRef.current = effectiveActiveStreamKey;
    // 初次挂载优先恢复用户上次停留的来源；只有运行期间真正打开了另一份
    // 在线歌单，才跟随到对应平台。否则刷新/横竖屏切换会被旧播放状态抢走。
    if (!effectiveActiveStreamPlaylist || effectiveActiveStreamKey === previousKey) return;
    const activeRoot = streamRootOf(effectiveActiveStreamPlaylist.platform);
    if (!streamRootEnabled(settings, activeRoot)) return;
    if (hiddenPlatforms.includes(activeRoot.id)) return;
    setNarrowSource((current) =>
      current.kind === "stream" && current.platform === activeRoot.id
        ? current
        : { kind: "stream", platform: activeRoot.id },
    );
  }, [effectiveActiveStreamKey, effectiveActiveStreamPlaylist, hiddenPlatforms, settings]);

  useEffect(() => {
    if (narrowSource.kind !== "local") return;
    if (roots.some((root) => root.path === narrowSource.rootPath)) return;
    const matching = roots.find((root) =>
      flattenFolders([root]).some((node) => node.path === filter.folder),
    );
    const fallback = matching ?? roots[0];
    if (fallback) setNarrowSource({ kind: "local", rootPath: fallback.path });
  }, [filter.folder, folders, narrowSource]);

  useEffect(() => {
    if (narrowSource.kind !== "stream") return;
    if (
      streamRootEnabled(settings, streamRootOf(narrowSource.platform)) &&
      !hiddenPlatforms.includes(narrowSource.platform)
    ) return;
    const fallback = roots[0];
    setNarrowSource(
      fallback ? { kind: "local", rootPath: fallback.path } : { kind: "local", rootPath: "" },
    );
  }, [hiddenPlatforms, narrowSource, roots, settings]);

  const enabledStreamRoots = useMemo(
    () => STREAM_ROOTS.filter((streamRoot) =>
      streamRootEnabled(settings, streamRoot) && !hiddenPlatforms.includes(streamRoot.id),
    ),
    [hiddenPlatforms, settings],
  );

  useEffect(() => {
    const clearDrop = () => setNarrowDrop("");
    window.addEventListener("dragend", clearDrop, true);
    return () => window.removeEventListener("dragend", clearDrop, true);
  }, []);

  /* How the rail's items arrive (sidebarMotion.ts): all of them when the rail is shown, the
     lower list when another source is picked or its playlists have been read, a section's
     playlists when it is opened or closed. Nothing else moves an item. */
  const [railMotion] = useState(() => createSidebarMotion("button", ".kd-narrow-source-children"));
  const playlistOrders = useStreamPlaylistOrderStore((state) => state.orders);
  const shownRecentlyOpened = useShownRecents(
    streamRecentlyOpened,
    railMotion,
    railRef,
    ".kd-narrow-source-children button[data-stream-platform]",
  );
  const railSourceKey =
    narrowSource.kind === "stream" ? `stream:${narrowSource.platform}` : `local:${narrowSource.rootPath}`;
  const railPlaylistsRead =
    narrowSource.kind === "stream" &&
    rootMembers(streamRootOf(narrowSource.platform)).some((platform) => streamPlaylists[platform] !== null);
  const railShownRef = useRef<{ source: string; read: boolean } | null>(null);
  useLayoutEffect(() => {
    const before = railShownRef.current;
    railShownRef.current = expanded ? null : { source: railSourceKey, read: railPlaylistsRead };
    if (expanded) return;
    if (!before) {
      railMotion.reveal(railRef.current);
    } else if (before.source !== railSourceKey || (railPlaylistsRead && !before.read)) {
      railMotion.reveal(railRef.current?.querySelector(".kd-narrow-source-children"));
    }
  }, [expanded, railMotion, railPlaylistsRead, railSourceKey]);

  if (expanded) {
    return (
      <aside className="kd-narrow-folder-panel" aria-label="文件夹侧栏">
        <FolderTree
          onNavigate={onNavigate}
          onOpenStreamPlaylist={onOpenStreamPlaylist}
          activeStreamPlaylist={activeStreamPlaylist}
        />
      </aside>
    );
  }

  const choose = (folder: string) => {
    setPickerOpen(false);
    setActiveStreamPlaylist(null);
    // 侧栏数字展示的是整棵子树的累计曲目数；点击后的列表必须使用同一口径。
    // 旧版窄轨在这里悄悄切成“仅当前层”，父目录便会出现有数字却无曲目的假空态。
    setFilter({ folder, folderDeep: true });
    // 和宽侧栏一样：点开还有文件没进曲库的目录 = 顺手导入。
    const pending = flattenFolders(roots).find((node) => node.path === folder);
    if (pending && pending.pending_count > 0 && folder !== filter.folder) {
      setError("");
      void startScan([folder], true).catch((reason: unknown) =>
        setError(`导入「${pending.name}」失败：${(reason as Error).message}`),
      );
    }
    onNavigate?.();
  };

  const selectedLocalRoot =
    narrowSource.kind === "local"
      ? roots.find((root) => root.path === narrowSource.rootPath) ?? null
      : null;

  const openStreamPlaylist = (
    platform: StreamBrowsePlatform,
    playlist: StreamPlaylist,
  ) => {
    setPickerOpen(false);
    setActiveStreamPlaylist({ platform, key: playlist.key });
    setStreamError(platform, "");
    try {
      const opening = onOpenStreamPlaylist?.(playlist);
      if (opening) {
        void Promise.resolve(opening).catch((reason: unknown) =>
          setStreamError(platform, `打开歌单失败：${(reason as Error).message}`),
        );
      }
    } catch (reason) {
      setStreamError(platform, `打开歌单失败：${(reason as Error).message}`);
    }
    onNavigate?.();
  };

  const renderLocalFolderButton = (node: FolderNode, sourceRoot: boolean) => {
    const sourceActive =
      sourceRoot &&
      narrowSource.kind === "local" &&
      narrowSource.rootPath === node.path;
    const folderActive = !sourceRoot && filter.folder === node.path;
    return (
      <button
        key={`${sourceRoot ? "narrow-local-root" : "narrow-local-child"}:${node.path}`}
        type="button"
        {...{ [FOLDER_DROP_PATH_ATTR]: node.path }}
        {...midiBrowseItemProps("local", `local:folder:${node.path}`)}
        data-active={sourceActive || folderActive || undefined}
        data-drop={narrowDrop === node.path ? "true" : undefined}
        title={node.path}
        aria-haspopup={sourceRoot && portrait ? "dialog" : undefined}
        aria-expanded={sourceRoot && portrait ? sourceActive && pickerOpen : undefined}
        onClick={() => {
          if (sourceRoot) {
            // 竖屏的选单里第一项就是根目录本身；横屏没有选单，根目录行直接打开
            // 整棵树的曲目（列表含子文件夹，不会因为根目录没有直属曲目而变空）。
            setNarrowSource({ kind: "local", rootPath: node.path });
            if (portrait) setPickerOpen(true);
            else choose(node.path);
            return;
          }
          choose(node.path);
        }}
        onDragOverCapture={(event) => {
          if (isSearchDownloadDrag(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setNarrowDrop(node.path);
            return;
          }
          if (!isTrackDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = event.altKey ? "move" : "copy";
          setNarrowDrop(node.path);
        }}
        onDragLeave={() =>
          setNarrowDrop((current) => (current === node.path ? "" : current))
        }
        onDropCapture={(event) => {
          event.preventDefault();
          setNarrowDrop("");
          if (isSearchDownloadDrag(event)) {
            void enqueueSearchDrop(event, node.path).catch((reason: unknown) =>
              setError((reason as Error).message),
            );
            return;
          }
          const ids = trackIdsFromDrop(event);
          if (ids.length === 0) return;
          const op = resolveLibraryPasteOp({ forceMove: event.altKey });
          void applyFolderOp(ids, node.path, op).catch((reason: unknown) =>
            setError((reason as Error).message),
          );
        }}
      >
        <RailContent
          icon={
            <FolderGlyph
              path={node.path}
              audioDir={settings?.download_dir}
              videoDir={settings?.download_dir}
              root={node.is_root}
              open={sourceRoot}
              icon={RAIL_ICON}
            />
          }
          label={node.name}
        />
      </button>
    );
  };

  const renderStreamChildren = (platform: StreamBrowsePlatform) => {
    const account = accounts.find((candidate) => candidate.platform === platform);
    const accountState = account?.state;
    const canBrowse = accountCanBrowse(accountState);
    const playlists = streamPlaylists[platform];
    const orderedPlaylists = orderStreamPlaylists(
      withForegroundStreamPlaceholder(playlists ?? [], platform, startupForeground),
      shownRecentlyOpened[platform],
      playlistOrders[platform] ?? "recent",
    );
    const loading = streamLoading[platform];
    const platformError = streamErrors[platform];
    const favoritePlaylists = orderedPlaylists.filter(
      (playlist) => playlist.is_favorite || playlist.origin === "favorite",
    );
    const sections = streamPlaylistSections(orderedPlaylists, platform);

    return (
      <>
        {!accountState && (
          <button
            type="button"
            title={accountsError || "正在读取账号状态"}
            disabled={!accountsError}
            onClick={() => void useAppStore.getState().refreshAccounts()}
          >
            <RailContent
              icon={
                accountsError ? (
                  <AlertTriangle {...RAIL_ICON} />
                ) : (
                  <LoaderCircle className="kd-spin" {...RAIL_ICON} />
                )
              }
              label={accountsError ? "重试账号" : "读取账号"}
            />
          </button>
        )}
        {(accountState === "missing" || accountState === "expired") && (
          <button
            type="button"
            title="打开设置登录账号"
            onClick={() => openLoginSettings(platform)}
          >
            <RailContent
              icon={<LogIn {...RAIL_ICON} />}
              label={accountState === "expired" ? "重新登录" : "登录"}
            />
          </button>
        )}
        {canBrowse && loading && playlists === null && (
          <button type="button" disabled aria-label="正在读取歌单">
            <RailContent
              icon={<LoaderCircle className="kd-spin" {...RAIL_ICON} />}
              label="读取歌单"
            />
          </button>
        )}
        {canBrowse && platformError && (
          <button
            type="button"
            title={platformError}
            disabled={loading}
            onClick={() => void loadStreamPlaylists(platform, true)}
          >
            <RailContent icon={<AlertTriangle {...RAIL_ICON} />} label="重试" />
          </button>
        )}
        {canBrowse &&
          favoritePlaylists.map((playlist) => {
            const active =
              effectiveActiveStreamPlaylist?.platform === platform &&
              effectiveActiveStreamPlaylist.key === playlist.key;
            return (
              <button
                key={`narrow-stream-playlist:${platform}:${playlist.key}`}
                type="button"
                data-active={active || undefined}
                data-stream-platform={platform}
                {...midiBrowseItemProps("search", `search:playlist:${platform}:${playlist.key}`)}
                title={`${playlist.title} · ${streamPlaylistCountLabel(playlist)}`}
                onClick={() => openStreamPlaylist(platform, playlist)}
              >
                <RailContent icon={<Heart {...RAIL_ICON} />} label={playlist.title} />
              </button>
            );
          })}
        {canBrowse &&
          sections.map((section) => {
            const sectionOpen = streamSectionExpanded[platform][section.id];
            return (
              <div
                key={`narrow-stream-section:${platform}:${section.id}`}
                className="kd-narrow-stream-section"
              >
                <button
                  type="button"
                  aria-expanded={sectionOpen}
                  title={`${sectionOpen ? "收起" : "展开"}${section.label}`}
                  onClick={() => {
                    railMotion.expect(`section:${platform}:${section.id}`, !sectionOpen);
                    setStreamSectionExpanded(platform, section.id, !sectionOpen);
                  }}
                >
                  <RailContent
                    icon={sectionOpen ? <FolderOpen {...RAIL_ICON} /> : <Folder {...RAIL_ICON} />}
                    label={section.label}
                  />
                </button>
                {sectionOpen && (
                  <div
                    className="kd-narrow-branch"
                    ref={railMotion.branch(`section:${platform}:${section.id}`)}
                  >
                    {section.playlists.map((playlist) => {
                      const active =
                        effectiveActiveStreamPlaylist?.platform === platform &&
                        effectiveActiveStreamPlaylist.key === playlist.key;
                      return (
                        <button
                          key={`narrow-stream-playlist:${platform}:${playlist.key}`}
                          type="button"
                          data-active={active || undefined}
                          data-stream-platform={platform}
                          {...midiBrowseItemProps("search", `search:playlist:${platform}:${playlist.key}`)}
                          title={`${playlist.title} · ${streamPlaylistCountLabel(playlist)}`}
                          onClick={() => openStreamPlaylist(platform, playlist)}
                        >
                          <RailContent
                            icon={isPodcast(playlist) ? <Podcast {...RAIL_ICON} /> : <ListMusic {...RAIL_ICON} />}
                            label={playlist.title}
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
      </>
    );
  };

  /** A root's list in the rail; a root of several platforms puts each in a folder of its own. */
  const renderStreamRootChildren = (root: StreamRoot) => {
    const members = rootMembers(root);
    if (members.length === 1) return renderStreamChildren(root.id);
    const shown = members.filter((platform) => {
      const state = accounts.find((candidate) => candidate.platform === platform)?.state;
      return state === undefined || accountCanBrowse(state);
    });
    // Nothing to browse yet: the first platform's rows say how to get in (登录 or 读取账号).
    if (shown.length === 0) return renderStreamChildren(members[0]);
    return shown.map((platform) => {
      const label = STREAM_MEMBER_LABEL[platform] ?? platform;
      const groupOpen = streamSectionExpanded[platform].group;
      return (
        <div key={`narrow-stream-group:${platform}`} className="kd-narrow-stream-section">
          <button
            type="button"
            aria-expanded={groupOpen}
            title={`${groupOpen ? "收起" : "展开"}${label}`}
            onClick={() => {
              railMotion.expect(`group:${platform}`, !groupOpen);
              setStreamSectionExpanded(platform, "group", !groupOpen);
            }}
          >
            <RailContent
              icon={groupOpen ? <FolderOpen {...RAIL_ICON} /> : <Folder {...RAIL_ICON} />}
              label={label}
            />
          </button>
          {groupOpen && (
            <div className="kd-narrow-branch" ref={railMotion.branch(`group:${platform}`)}>
              {renderStreamChildren(platform)}
            </div>
          )}
        </div>
      );
    });
  };

  const renderChildren = () => (
      <div
        className="kd-narrow-source-children kd-scroll"
        aria-label={
          narrowSource.kind === "stream"
            ? "在线歌单目录"
            : "本地文件夹目录"
        }
      >
        {narrowSource.kind === "local" &&
          flattenFolders(selectedLocalRoot?.children ?? []).map((node) =>
            renderLocalFolderButton(node, false),
          )}
        {narrowSource.kind === "local" && (folders?.outside ?? 0) > 0 && (
          <button
            type="button"
            data-active={isOutsideFolder(filter.folder) || undefined}
            {...midiBrowseItemProps("local", "local:outside")}
            title="不在曲库目录里的曲目"
            onClick={() => choose(OUTSIDE_FOLDER)}
          >
            <RailContent icon={<Files {...RAIL_ICON} />} label="其他" />
          </button>
        )}
        {narrowSource.kind === "stream" &&
          !hiddenPlatforms.includes(narrowSource.platform) &&
          renderStreamRootChildren(streamRootOf(narrowSource.platform))}
      </div>
  );
  const pickerHost = railRef.current?.closest(".kd-stage");

  return (
    <>
    <aside ref={railRef} className="kd-narrow-folder-rail" aria-label="快捷文件夹栏">
      <div className="kd-narrow-global-actions" aria-label="曲库操作">
      <button
        type="button"
        title={error || "添加音乐文件夹"}
        aria-label="添加音乐文件夹"
        onClick={() => {
          setError("");
          void pickAndScanFolders().catch((reason: unknown) => setError((reason as Error).message));
        }}
      >
        <RailContent icon={<FolderPlus {...RAIL_ICON} />} label="添加文件夹" />
      </button>
      {window.kdj?.pickMediaFiles && (
        <button
          type="button"
          title={error || "添加音乐文件"}
          aria-label="添加音乐文件"
          onClick={() => {
            setError("");
            void pickAndScanFiles().catch((reason: unknown) => setError((reason as Error).message));
          }}
        >
          <RailContent icon={<FileMusic {...RAIL_ICON} />} label="添加文件" />
        </button>
      )}
      <button
        type="button"
        {...{ [SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR]: "" }}
        {...midiBrowseItemProps("local", "local:all")}
        data-active={filter.folder === "" || undefined}
        data-drop={narrowDrop === ALL_TRACKS_DROP_TARGET ? "true" : undefined}
        title="全部曲目（拖入下载会落到默认下载文件夹）"
        onClick={() => choose("")}
        onDragOverCapture={(event) => {
          if (!isSearchDownloadDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setNarrowDrop(ALL_TRACKS_DROP_TARGET);
        }}
        onDragLeave={() =>
          setNarrowDrop((current) => (current === ALL_TRACKS_DROP_TARGET ? "" : current))
        }
        onDropCapture={(event) => {
          event.preventDefault();
          setNarrowDrop("");
          if (!isSearchDownloadDrag(event)) return;
          void enqueueSearchDrop(event, SEARCH_DEFAULT_DOWNLOAD_SENTINEL).catch(
            (reason: unknown) => setError((reason as Error).message),
          );
        }}
      >
        <RailContent icon={<Library {...RAIL_ICON} />} label="全部曲目" />
      </button>
      </div>
      <div ref={sourceListRef} className="kd-narrow-source-roots kd-scroll" aria-label="媒体来源" style={sourceHeight === null ? undefined : { flexBasis: sourceHeight }}>
        {roots.map((root) => renderLocalFolderButton(root, true))}
        {enabledStreamRoots.map((streamRoot) => (
          <button
            key={`narrow-stream-root:${streamRoot.id}`}
            type="button"
            data-active={
              (narrowSource.kind === "stream" &&
                narrowSource.platform === streamRoot.id) || undefined
            }
            data-stream-platform={streamRoot.id}
            {...midiBrowseItemProps("search", `search:root:${streamRoot.id}`)}
            aria-label={`显示 ${streamRoot.label} 歌单`}
            title={`${portrait ? "选择" : "在下方显示"} ${streamRoot.label} 收藏和歌单`}
            aria-haspopup={portrait ? "dialog" : undefined}
            aria-expanded={portrait ? pickerOpen && narrowSource.kind === "stream" && narrowSource.platform === streamRoot.id : undefined}
            onContextMenu={(event) => openStreamRootMenu(event, streamRoot.id)}
            onClick={() => {
              setNarrowSource({ kind: "stream", platform: streamRoot.id });
              if (portrait) setPickerOpen(true);
              for (const platform of rootMembers(streamRoot)) {
                const account = accounts.find((candidate) => candidate.platform === platform);
                if (accountCanBrowse(account?.state)) void loadStreamPlaylists(platform);
              }
            }}
          >
            <RailContent
              icon={<PlatformMark id={streamRoot.id} size={RAIL_ICON.size} />}
              label={streamRoot.label}
            />
          </button>
        ))}
      </div>
      <div
        className="kd-narrow-rail-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="调整媒体来源与文件夹目录的高度"
        aria-valuenow={Math.round(sourceHeight ?? sourceListRef.current?.clientHeight ?? 0)}
        title="拖动调整来源高度；双击恢复自动"
        onPointerDown={(event) => {
          if (event.button !== 0 || !sourceListRef.current) return;
          event.preventDefault();
          resizeStartRef.current = { y: event.clientY, height: sourceListRef.current.clientHeight };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (resizeStartRef.current) setRailSourceHeight(resizeStartRef.current.height + event.clientY - resizeStartRef.current.y);
        }}
        onPointerUp={(event) => {
          if (!resizeStartRef.current) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          resizeStartRef.current = null;
          if (sourceHeightRef.current !== null) writeLocalStorageNow("kd-narrow-rail-source-height", String(sourceHeightRef.current));
        }}
        onPointerCancel={() => { resizeStartRef.current = null; }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          setRailSourceHeight((sourceHeightRef.current ?? sourceListRef.current?.clientHeight ?? 0) + (event.key === "ArrowDown" ? 24 : -24));
          if (sourceHeightRef.current !== null) writeLocalStorageNow("kd-narrow-rail-source-height", String(sourceHeightRef.current));
        }}
        onDoubleClick={() => {
          sourceHeightRef.current = null;
          setSourceHeight(null);
          writeLocalStorageNow("kd-narrow-rail-source-height", "");
        }}
      />
      {renderChildren()}
      {streamRootMenu}
    </aside>
    {portrait && pickerOpen && pickerHost && createPortal(
      <Sheet open title={narrowSource.kind === "local" ? selectedLocalRoot?.name ?? "文件夹" : STREAM_ROOTS.find(root => root.id === narrowSource.platform)?.label ?? "歌单"}
        placement="bottom" onClose={() => setPickerOpen(false)}>
        <div className="kd-folder-picker">
          {narrowSource.kind === "local" && selectedLocalRoot && (
            <button type="button" onClick={() => choose(selectedLocalRoot.path)}>
              <RailContent icon={<FolderOpen {...RAIL_ICON} />} label={selectedLocalRoot.name} />
            </button>
          )}
          {renderChildren()}
        </div>
      </Sheet>, pickerHost)}
    </>
  );
}

/** Where a sidebar menu unfolds: at the pointer, or under the row's ⋯ button (`anchor`). */
interface MenuPoint {
  x: number;
  y: number;
  top?: number;
  anchor?: HTMLElement;
}

interface MenuState extends MenuPoint {
  node: FolderNode;
}

/** A menu opened from a button hangs under it, and above it when there is no room below. */
function menuPointUnder(button: HTMLElement): MenuPoint {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4, top: rect.top, anchor: button };
}

/** 拖文件夹排序时的落点：插到某个兄弟的前面还是后面。 */
interface DragInfo {
  parent: string;
  name: string;
}

/** 这棵树里 path 对应的节点是否还有没入库的文件。 */
function hasPending(node: FolderNode, path: string): boolean {
  if (node.path === path) return node.pending_count > 0;
  return node.children.some((child) => hasPending(child, path));
}

function reorder(names: string[], from: string, to: string, after: boolean): string[] {
  const rest = names.filter((name) => name !== from);
  const index = rest.indexOf(to);
  if (index < 0) return names;
  rest.splice(after ? index + 1 : index, 0, from);
  return rest;
}

type ExpandedUpdate = Set<string> | ((current: Set<string>) => Set<string>);

/** 刷新树与重启应用都保留用户亲手展开/收起的本地文件夹分支。 */
function useExpanded(roots: FolderNode[]) {
  const restored = useRef(readSidebarTreeState().local);
  const [expanded, setExpandedState] = useState<Set<string>>(
    () => new Set(restored.current.expanded),
  );
  const seenRootPaths = useRef<Set<string>>(
    new Set(restored.current.knownRoots),
  );
  const setExpanded = (update: ExpandedUpdate) => {
    setExpandedState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      writeLocalFolderTreeState(next, seenRootPaths.current);
      return next;
    });
  };
  useEffect(() => {
    const rootPaths = roots.map((root) => root.path);
    const previouslySeen = seenRootPaths.current;
    // 已知但被用户收起的根不能在重启后被当成“新根”再次弹开；真正新增的根仍默认展开。
    seenRootPaths.current = new Set([...previouslySeen, ...rootPaths]);
    setExpandedState((current) => {
      const next = expandNewRootPaths(current, previouslySeen, rootPaths);
      writeLocalFolderTreeState(next, seenRootPaths.current);
      return next;
    });
  }, [roots]);
  return [expanded, setExpanded] as const;
}

export function FolderTree({
  onNavigate,
  onOpenStreamPlaylist,
  activeStreamPlaylist,
}: {
  /** 点选文件夹 / 全部曲目等导航项后回调（窄屏收右侧抽屉用）。 */
  onNavigate?: () => void;
} & StreamPlaylistBrowseProps = {}) {
  const folders = useLibraryStore((state) => state.folders);
  const filter = useLibraryStore((state) => state.filter);
  const clipboard = useLibraryStore((state) => state.clipboard);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const refreshFolders = useLibraryStore((state) => state.refreshFolders);
  const applyFolderOp = useLibraryStore((state) => state.applyFolderOp);
  const paste = useLibraryStore((state) => state.paste);
  const startScan = useLibraryStore((state) => state.startScan);
  const cancelScan = useLibraryStore((state) => state.cancelScan);
  const startAnalyze = useLibraryStore((state) => state.startAnalyze);
  const forgetFolder = useLibraryStore((state) => state.forgetFolder);
  const undo = useLibraryStore((state) => state.undo);
  const undoLast = useLibraryStore((state) => state.undoLast);
  const undoName = undo.op === "copy" ? "复制" : undo.op === "delete" ? "删除" : "移动";
  const undoError = useLibraryStore((state) => state.undoError);
  const clearUndoError = useLibraryStore((state) => state.clearUndoError);
  const settings = useAppStore((state) => state.settings);
  const { accounts, accountsError } = useStreamBrowseLifecycle(true);
  const hiddenPlatforms = useSidebarVisibilityStore((state) => state.hiddenPlatforms);
  const countsShown = useSidebarCounts((state) => state.shown);
  const { openStreamRootMenu, streamRootMenu } = useStreamRootMenu(
    (rootId) => refreshStreamRoot(streamRootOf(rootId)),
  );
  const saveSettings = useAppStore((state) => state.saveSettings);
  const streamPlaylists = useStreamBrowseStore((state) => state.playlists);
  const streamLoading = useStreamBrowseStore((state) => state.loading);
  const streamErrors = useStreamBrowseStore((state) => state.errors);
  const streamExpanded = useStreamBrowseStore((state) => state.expanded);
  const streamSectionExpanded = useStreamBrowseStore((state) => state.sectionExpanded);
  const streamRecentlyOpened = useStreamBrowseStore((state) => state.recentlyOpened);
  const cachedActiveStreamPlaylist = useStreamBrowseStore((state) => state.active);
  const startupForeground = useStreamBrowseStore((state) => state.startupForeground);
  const loadStreamPlaylists = useStreamBrowseStore((state) => state.loadPlaylists);
  const setStreamExpanded = useStreamBrowseStore((state) => state.setExpanded);
  const setStreamSectionExpanded = useStreamBrowseStore(
    (state) => state.setSectionExpanded,
  );
  const setActiveStreamPlaylist = useStreamBrowseStore((state) => state.setActive);
  const setStreamError = useStreamBrowseStore((state) => state.setError);
  const statsTotal = useLibraryStore((state) => state.stats?.total);
  /** 移出曲库的二次确认：第一次上膛，第二次才执行（和曲目表删文件同套路）。 */
  const [forgetArmed, setForgetArmed] = useState("");

  const roots = folders?.roots ?? [];
  const enabledStreamRoots = useMemo(
    () => STREAM_ROOTS.filter((streamRoot) =>
      streamRootEnabled(settings, streamRoot) && !hiddenPlatforms.includes(streamRoot.id),
    ),
    [hiddenPlatforms, settings],
  );
  // A root of several platforms can be open while one of them has nothing read yet (signed in
  // later, or its cache was dropped): reading it is what opening the root would have done.
  useEffect(() => {
    for (const root of enabledStreamRoots) {
      if (!root.members || !streamExpanded[root.id]) continue;
      for (const platform of root.members) {
        const state = accounts.find((account) => account.platform === platform)?.state;
        if (
          accountCanBrowse(state) &&
          streamPlaylists[platform] === null &&
          !streamLoading[platform] &&
          !streamErrors[platform]
        ) {
          void loadStreamPlaylists(platform);
        }
      }
    }
  }, [accounts, enabledStreamRoots, loadStreamPlaylists, streamErrors, streamExpanded, streamLoading, streamPlaylists]);
  const [rootOrder, setRootOrder] = useState(readSidebarRootOrder);
  const sidebarRootItems = useMemo<SidebarRootItem[]>(
    () => [
      { id: ALL_TRACKS_ROOT_ID, kind: "all" },
      ...enabledStreamRoots.map(
        (streamRoot): SidebarRootItem => ({
          id: `stream:${streamRoot.id}`,
          kind: "stream",
          streamRoot,
        }),
      ),
      ...roots.map(
        (root): SidebarRootItem => ({
          id: `local:${root.path}`,
          kind: "local",
          root,
        }),
      ),
      ...((folders?.outside ?? 0) > 0
        ? [{ id: OUTSIDE_ROOT_ID, kind: "outside" } satisfies SidebarRootItem]
        : []),
    ],
    [enabledStreamRoots, folders?.outside, roots],
  );
  const orderedRootItems = useMemo(
    () => orderSidebarRootItems(sidebarRootItems, rootOrder),
    [rootOrder, sidebarRootItems],
  );
  const allTrackCount =
    statsTotal ??
    roots.reduce((sum, root) => sum + root.total_count, 0) + (folders?.outside ?? 0);
  const [expanded, setExpanded] = useExpanded(roots);
  const [importing, setImporting] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [dropEdge, setDropEdge] = useState<"" | "before" | "after">("");
  const [rootDragging, setRootDragging] = useState("");
  const [rootDrop, setRootDrop] = useState<{
    id: string;
    edge: SidebarRootDropEdge;
  } | null>(null);
  const rootListRef = useRef<HTMLDivElement | null>(null);
  const rootPointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressRootClickRef = useRef(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [allMenu, setAllMenu] = useState<MenuPoint | null>(null);
  /** 整库重扫会遍历所有根：第一次点只在原右键面板里上膛，第二次才启动。 */
  const [rescanArmed, setRescanArmed] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const folderSelectionAnchor = useRef("");
  const [newFolder, setNewFolder] = useState<{ parent: string; name: string; saving: boolean } | null>(null);
  /** The folder whose name is being edited in its own row. */
  const [renaming, setRenaming] = useState<{ node: FolderNode; name: string; saving: boolean } | null>(null);
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  /**
   * 文件夹操作失败就地贴在这一栏底下。原来走的是全局弹窗，
   * 但拖拽/改名这类操作的"哪里出错了"必须和被操作的那棵树待在一起，
   * 弹窗飘走之后用户只剩一个没变化的界面。
   */
  const [notice, setNotice] = useState("");
  const effectiveActiveStreamPlaylist =
    activeStreamPlaylist === undefined ? cachedActiveStreamPlaylist : activeStreamPlaylist;

  const visibleFolderPaths = useMemo(() => {
    const paths: string[] = [];
    const visit = (nodes: FolderNode[]) => {
      for (const node of nodes) {
        paths.push(node.path);
        if (expanded.has(node.path)) visit(node.children);
      }
    };
    visit(roots);
    return paths;
  }, [expanded, roots]);

  const folderByPath = useMemo(() => {
    const nodes = new Map<string, FolderNode>();
    const visit = (items: FolderNode[]) => {
      for (const node of items) {
        nodes.set(node.path, node);
        visit(node.children);
      }
    };
    visit(roots);
    return nodes;
  }, [roots]);

  const selectFolderRow = (event: React.MouseEvent, node: FolderNode): boolean => {
    if (event.metaKey || event.ctrlKey) {
      setSelectedFolders((current) => {
        const next = new Set(current);
        if (!next.delete(node.path)) next.add(node.path);
        return next;
      });
      folderSelectionAnchor.current = node.path;
      return true;
    }
    if (event.shiftKey && folderSelectionAnchor.current) {
      const start = visibleFolderPaths.indexOf(folderSelectionAnchor.current);
      const end = visibleFolderPaths.indexOf(node.path);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        setSelectedFolders(new Set(visibleFolderPaths.slice(from, to + 1)));
        return true;
      }
    }
    setSelectedFolders(new Set([node.path]));
    folderSelectionAnchor.current = node.path;
    return false;
  };

  const commitRootReorder = (
    from: string,
    to: string,
    edge: SidebarRootDropEdge,
  ) => {
    const visibleOrder = orderedRootItems.map((item) => item.id);
    const moved = moveSidebarRootOrder(visibleOrder, from, to, edge);
    if (moved.every((id, index) => id === visibleOrder[index])) return;
    const next = mergeSidebarRootOrder(rootOrder, moved);
    setRootOrder(next);
    writeSidebarRootOrder(next);
  };

  /**
   * 根项混合了按钮、远程目录和真实文件夹，原生 HTML 拖放在 WKWebView 里容易
   * 丢失 drop。这里直接跟踪指针，越过 5px 后才进入排序，不影响普通点击。
   */
  const beginRootPointerReorder = (
    event: React.PointerEvent<HTMLElement>,
    sourceId: string,
  ) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (event.target instanceof Element && event.target.closest("button")) return;

    rootPointerCleanupRef.current?.();
    setRootDragging("");
    setRootDrop(null);
    suppressRootClickRef.current = false;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let targetId: string | null = null;
    let targetEdge: SidebarRootDropEdge = "before";

    const rootSlotAt = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      const slot = hit?.closest<HTMLElement>("[data-sidebar-root-id]") ?? null;
      return slot?.parentElement === rootListRef.current ? slot : null;
    };
    const stopTracking = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      document.body.removeAttribute("data-kd-sidebar-root-dragging");
      if (sourceId.startsWith("local:")) endTemporaryFolderDrag();
      rootPointerCleanupRef.current = null;
    };
    const finish = () => {
      stopTracking();
      setRootDragging("");
      setRootDrop(null);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!active && Math.hypot(move.clientX - startX, move.clientY - startY) < 5) return;
      move.preventDefault();
      if (!active) {
        active = true;
        clearTextSelection();
        document.body.dataset.kdSidebarRootDragging = "true";
        setRootDragging(sourceId);
        if (sourceId.startsWith("local:")) beginTemporaryFolderDrag(sourceId.slice("local:".length));
      }

      const slot = rootSlotAt(move.clientX, move.clientY);
      const nextTargetId = slot?.dataset.sidebarRootId ?? null;
      if (!slot || !nextTargetId || nextTargetId === sourceId) {
        targetId = null;
        setRootDrop(null);
        return;
      }
      const row = slot.querySelector<HTMLElement>("[data-sidebar-root-row]");
      const rect = row?.getBoundingClientRect() ?? slot.getBoundingClientRect();
      targetId = nextTargetId;
      targetEdge = move.clientY < rect.top + rect.height / 2 ? "before" : "after";
      setRootDrop((current) =>
        current?.id === targetId && current.edge === targetEdge
          ? current
          : { id: targetId!, edge: targetEdge },
      );
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      const shouldCommit = active && targetId !== null;
      if (active) {
        // pointerup 后浏览器可能补发 click；只拦这一次，避免拖完顺手打开落点。
        suppressRootClickRef.current = true;
        window.setTimeout(() => {
          suppressRootClickRef.current = false;
        }, 0);
      }
      const destination = targetId;
      const edge = targetEdge;
      finish();
      if (shouldCommit && destination) commitRootReorder(sourceId, destination, edge);
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) finish();
    };

    rootPointerCleanupRef.current = stopTracking;
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  };

  useEffect(() => {
    const clearDrop = () => {
      setDropTarget("");
      setDropEdge("");
    };
    window.addEventListener("dragend", clearDrop, true);
    return () => window.removeEventListener("dragend", clearDrop, true);
  }, []);

  useEffect(
    () => () => {
      rootPointerCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!undoError) return;
    setNotice(`撤回失败：${undoError}`);
    clearUndoError();
  }, [clearUndoError, undoError]);

  /**
   * 「添加文件夹」是一个动作：选完目录之后登记曲库根并扫描；自动分析开着时，
   * 新曲目会继续在后台分析，关掉时只入库，用户可稍后从右键菜单手动分析。
   *
   * 失败原因分两处：这里 catch 得到的是"任务都没起来"（比如挑的路径没权限），
   * 真正扫描过程中的失败随 `scan.progress` 的终局事件走，显示在曲目表上方
   * 那条工具条里（LibraryToolbar 的 importError）——两处都不能省。
   */
  const scan = useLibraryStore((state) => state.scan);
  const scanning = scan !== null && scan.phase !== "done";
  const addFolders = async () => {
    setNotice("");
    try {
      await pickAndScanFolders();
    } catch (error) {
      setNotice(`添加文件夹失败：${(error as Error).message}`);
    }
  };
  const addFiles = async () => {
    setNotice("");
    try {
      await pickAndScanFiles();
    } catch (error) {
      setNotice(`添加文件失败：${(error as Error).message}`);
    }
  };
  // 扫描结束（scan.progress 到 done → refreshFolders）后清掉"导入中"标记
  useEffect(() => {
    setImporting((current) => {
      if (!current) return current;
      const stale = folders?.roots.some((root) => hasPending(root, current)) ?? false;
      return stale ? current : "";
    });
  }, [folders]);
  // 取消或失败的导入会回滚，文件夹仍是"未入库"，上面那条清不掉标记；扫描一结束就清，
  // 否则徽标一直是「…」，之后点任何未入库文件夹都不再导入。
  useEffect(() => {
    if (scan?.phase === "done") setImporting("");
  }, [scan?.phase]);

  // 换节点时清掉「移出」上膛态（关闭由 ContextMenu 自己处理）
  useEffect(() => {
    setForgetArmed("");
  }, [menu?.node.path]);

  /* How the tree's rows arrive and fold (sidebarMotion.ts). A branch only moves for the user's
     own toggle, announced with `expect` right before the state changes; every other render
     leaves the rows where they are. */
  const [treeMotion] = useState(() => createSidebarMotion(".kd-folder", ".kd-folder-list"));
  const playlistOrders = useStreamPlaylistOrderStore((state) => state.orders);
  const shownRecentlyOpened = useShownRecents(
    streamRecentlyOpened,
    treeMotion,
    rootListRef,
    ".kd-folder-stream-playlist",
  );
  // The tree was shown: its rows arrive once. What is still on its way at that moment — the
  // local roots while they are being read, the folders of a root that is opened because it is
  // new — arrives as it comes, within a short while of the roots; nothing that was already
  // there moves again, and after that a row that appears is simply there.
  const foldersRead = folders !== null;
  const shownRowsRef = useRef<{ rows: Set<Element>; shownAt: number; readAt: number } | "settled" | null>(null);
  useLayoutEffect(() => {
    const list = rootListRef.current;
    const shown = shownRowsRef.current;
    if (!list || shown === "settled") return;
    const now = performance.now();
    if (shown !== null && (
      (shown.readAt > 0 && now - shown.readAt > TREE_SHOWN_SETTLE_MS)
      // Roots that take this long (or never come) are not part of the tree being shown.
      || now - shown.shownAt > TREE_SHOWN_LIMIT_MS
    )) {
      shownRowsRef.current = "settled";
      return;
    }
    if (shown === null) treeMotion.reveal(list);
    else treeMotion.reveal(list, (row) => !shown.rows.has(row));
    shownRowsRef.current = {
      rows: new Set(list.querySelectorAll(".kd-folder")),
      shownAt: shown?.shownAt ?? now,
      readAt: shown !== null && shown.readAt > 0 ? shown.readAt : foldersRead ? now : 0,
    };
  });
  // A source's playlists arrive in its open branch after signing in (nothing read → read) or
  // when a refresh the user asked for has come back. A refresh in the background moves nothing.
  const streamReadRef = useRef<Partial<Record<StreamBrowsePlatform, { read: boolean; loading: boolean }>>>({});
  const refreshAskedRef = useRef(new Set<StreamBrowsePlatform>());
  useLayoutEffect(() => {
    for (const platform of STREAM_BROWSE_PLATFORMS) {
      const before = streamReadRef.current[platform];
      const now = { read: streamPlaylists[platform] !== null, loading: streamLoading[platform] };
      streamReadRef.current[platform] = now;
      if (!before || !now.read || now.loading) continue;
      const refreshed = before.loading && refreshAskedRef.current.delete(platform);
      if (!before.read || refreshed) treeMotion.reveal(treeMotion.branchElement(`stream:${platform}`));
    }
  }, [streamLoading, streamPlaylists, treeMotion]);

  const toggle = (path: string) => {
    treeMotion.expect(`folder:${path}`, !expanded.has(path));
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /**
   * 点开一个还没入库的目录 = 顺手把它导进来。用户不该为了看见歌先去点一次「添加文件夹」。
   * 自动分析开着时导入完继续排队；暂停时只导入。
   * 进行中的反馈就是那颗计数徽标变成「…」，不再弹窗。
   */
  const importPending = (node: FolderNode) => {
    if (node.pending_count <= 0 || importing) return;
    setImporting(node.path);
    setNotice("");
    void startScan([node.path], true).catch((error: unknown) => {
      setImporting("");
      setNotice(`导入「${node.name}」失败：${(error as Error).message}`);
    });
  };

  const runOp = (ids: number[], dest: string, alt: boolean) => {
    if (ids.length === 0) return;
    const op = resolveLibraryPasteOp({ forceMove: alt });
    setNotice("");
    void applyFolderOp(ids, dest, op)
      .then((result) => {
        // 全成功不报喜：曲目已经出现在目标文件夹里了，那就是最好的回执。
        // 只有部分失败才要说话，否则用户会以为整批都搬过去了。
        const failed = Object.keys(result.errors).length;
        if (failed === 0) return;
        const detail = Object.entries(result.methods)
          .map(([method, count]) => `${METHOD_LABEL[method] ?? method} ${count}`)
          .join(" · ");
        const verb = op === "move" ? "移动" : "复制";
        setNotice(
          `${verb} ${result.track_ids.length} 首${detail ? `（${detail}）` : ""}，${failed} 首失败`,
        );
      })
      .catch((error: unknown) => setNotice(`操作失败：${(error as Error).message}`));
  };

  const analyzeFolderPaths = async (paths: string[] | null, includeSubfolders: boolean) => {
    const ids = new Set<number>();
    const scopes = paths ?? [""];
    for (const folder of scopes) {
      let offset = 0;
      while (true) {
        const page = await api.tracks({
          folder,
          folder_deep: includeSubfolders,
          limit: 1000,
          offset,
        });
        page.items.forEach((track) => ids.add(track.id));
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.total) break;
      }
    }
    await startAnalyze([...ids], false);
  };

  const prompt = (title: string, initial = "") => {
    const value = window.prompt(title, initial);
    return value === null ? null : value.trim();
  };

  const siblingsOf = (parentPath: string, node: FolderNode): string[] => {
    if (node.path === parentPath) return node.children.map((child) => child.name);
    for (const child of node.children) {
      const found = siblingsOf(parentPath, child);
      if (found.length > 0) return found;
    }
    return [];
  };

  const applyReorder = (parentPath: string, from: string, to: string, after: boolean) => {
    const names = roots.map((root) => siblingsOf(parentPath, root)).find((list) => list.length > 0);
    if (!names) return;
    void api
      .orderFolder(parentPath, reorder(names, from, to, after))
      .then(() => refreshFolders())
      .catch((error: unknown) => setNotice(`排序保存失败：${(error as Error).message}`));
  };

  const commitNewFolder = () => {
    if (!newFolder || newFolder.saving) return;
    const name = newFolder.name.trim();
    if (!name) {
      setNewFolder(null);
      return;
    }
    setNewFolder({ ...newFolder, saving: true });
    setNotice("");
    void api
      .createFolder(newFolder.parent, name)
      .then(() => refreshFolders())
      .then(() => setNewFolder(null))
      .catch((error: unknown) => {
        setNewFolder((current) => current ? { ...current, saving: false } : current);
        setNotice(`新建文件夹失败：${(error as Error).message}`);
      });
  };

  /** Enter or leaving the field keeps the new name; an empty or unchanged one changes nothing. */
  const commitRename = () => {
    const current = renamingRef.current;
    if (!current || current.saving) return;
    const { node } = current;
    const name = current.name.trim();
    if (!name || name === node.name) {
      setRenaming(null);
      return;
    }
    setRenaming({ ...current, saving: true });
    setNotice("");
    void api
      .renameFolder(node.path, name)
      .then((tree) => {
        const folder = relocatedFolderPath(tree, useLibraryStore.getState().filter.folder, node.path, node.parent, name);
        if (folder) setFilter({ folder });
        return refreshFolders();
      })
      .catch((error: unknown) => setNotice((error as Error).message))
      .finally(() => setRenaming((latest) => (latest?.node.path === node.path ? null : latest)));
  };

  /** Opening a root reads the playlists of every platform under it that can be browsed. */
  const toggleStreamRoot = (root: StreamRoot) => {
    const opening = !streamExpanded[root.id];
    treeMotion.expect(`stream:${root.id}`, opening);
    setStreamExpanded(root.id, opening);
    if (!opening) return;
    for (const platform of rootMembers(root)) {
      const state = accounts.find((account) => account.platform === platform)?.state;
      if (accountCanBrowse(state)) void loadStreamPlaylists(platform);
    }
  };

  const refreshStreamRoot = (root: StreamRoot) => {
    for (const platform of rootMembers(root)) {
      const state = accounts.find((account) => account.platform === platform)?.state;
      if (!accountCanBrowse(state)) continue;
      refreshAskedRef.current.add(platform);
      void loadStreamPlaylists(platform, true);
    }
  };

  const openStreamPlaylist = (
    platform: StreamBrowsePlatform,
    playlist: StreamPlaylist,
  ) => {
    setActiveStreamPlaylist({ platform, key: playlist.key });
    setStreamError(platform, "");
    try {
      const opening = onOpenStreamPlaylist?.(playlist);
      if (opening) {
        void Promise.resolve(opening).catch((error: unknown) =>
          setStreamError(platform, `打开歌单失败：${(error as Error).message}`),
        );
      }
    } catch (error) {
      setStreamError(platform, `打开歌单失败：${(error as Error).message}`);
    }
    onNavigate?.();
  };

  // The eye of a top-level row, left of the row's own action: it turns the counts of the whole
  // sidebar off and on. A button, so a press on it neither opens the row nor starts a reorder.
  const countsEye = (
    <button
      type="button"
      className="kd-folder-more kd-folder-eye"
      aria-label="显示数量"
      aria-pressed={countsShown}
      title={countsShown ? "隐藏数量" : "显示数量"}
      onClick={(event) => {
        event.stopPropagation();
        useSidebarCounts.getState().setShown(!countsShown);
      }}
    >
      {countsShown ? <Eye {...ROW_ICON} /> : <EyeOff {...ROW_ICON} />}
    </button>
  );

  /** One platform's part of a root: how its account stands, its favourites, then its sections. */
  const renderStreamPlatform = (platform: StreamBrowsePlatform, depth: number) => {
    const playlists = streamPlaylists[platform];
    const orderedPlaylists = orderStreamPlaylists(
      withForegroundStreamPlaceholder(playlists ?? [], platform, startupForeground),
      shownRecentlyOpened[platform],
      playlistOrders[platform] ?? "recent",
    );
    const loading = streamLoading[platform];
    const error = streamErrors[platform];
    const accountState = accounts.find((account) => account.platform === platform)?.state;
    const canBrowse = accountCanBrowse(accountState);
    const favoritePlaylists = orderedPlaylists.filter(
      (playlist) => playlist.is_favorite || playlist.origin === "favorite",
    );
    const sections = streamPlaylistSections(orderedPlaylists, platform);
    const playlistRow = (playlist: StreamPlaylist, depth: number) => {
      const favorite = playlist.is_favorite || playlist.origin === "favorite";
      const active =
        effectiveActiveStreamPlaylist?.platform === platform &&
        effectiveActiveStreamPlaylist.key === playlist.key;
      return (
        <button
          key={`stream-playlist:${platform}:${playlist.key}`}
          type="button"
          className="kd-folder kd-folder-action kd-folder-stream-playlist"
          data-active={active || undefined}
          data-stream-platform={platform}
          {...midiBrowseItemProps("search", `search:playlist:${platform}:${playlist.key}`)}
          style={depthStyle(depth)}
          title={`${playlist.title} · ${streamPlaylistCountLabel(playlist)}`}
          onClick={() => openStreamPlaylist(platform, playlist)}
        >
          <span className="kd-folder-caret" />
          <span className="kd-folder-icon">
            {favorite ? (
              <Heart {...ROW_ICON} />
            ) : isPodcast(playlist) ? (
              <Podcast {...ROW_ICON} />
            ) : (
              <ListMusic {...ROW_ICON} />
            )}
          </span>
          <span className="kd-folder-name kd-truncate">{playlist.title}</span>
          <span className="kd-folder-trail">
            {countsShown && <span className="kd-folder-count">{playlist.count}</span>}
          </span>
        </button>
      );
    };

    return (
      <>
        {!accountState && (
          <button
            type="button"
            className="kd-folder kd-folder-action kd-stream-status"
            style={depthStyle(depth)}
            title={accountsError || "正在读取账号状态"}
            disabled={!accountsError}
            onClick={() => void useAppStore.getState().refreshAccounts()}
          >
            <span className="kd-folder-caret" />
            <span className="kd-folder-icon">
              {accountsError ? (
                <AlertTriangle {...ROW_ICON} />
              ) : (
                <LoaderCircle className="kd-spin" {...ROW_ICON} />
              )}
            </span>
            <span className="kd-folder-name kd-truncate">
              {accountsError ? "账号状态读取失败，点此重试" : "正在读取账号状态"}
            </span>
          </button>
        )}

        {canBrowse && loading && playlists === null && (
          <div className="kd-folder kd-stream-status" style={depthStyle(depth)} aria-live="polite">
            <span className="kd-folder-caret" />
            <span className="kd-folder-icon">
              <LoaderCircle className="kd-spin" {...ROW_ICON} />
            </span>
            <span className="kd-folder-name kd-truncate">正在读取歌单</span>
          </div>
        )}

        {canBrowse && error && (
          <div
            className="kd-folder kd-stream-status kd-stream-error"
            style={depthStyle(depth)}
            title={error}
          >
            <span className="kd-folder-caret" />
            <span className="kd-folder-icon">
              <AlertTriangle {...ROW_ICON} />
            </span>
            <span className="kd-folder-name kd-truncate">{error}</span>
            <span className="kd-folder-trail">
              <button
                type="button"
                className="kd-stream-inline-action"
                disabled={loading}
                onClick={() => void loadStreamPlaylists(platform, true)}
              >
                重试
              </button>
            </span>
          </div>
        )}

        {/* 平台的默认收藏直接作为可点击项展示；不再套一层只有一个子项的目录。 */}
        {canBrowse && favoritePlaylists.map((playlist) => playlistRow(playlist, depth))}

        {canBrowse &&
          sections.map((section) => {
            const sectionOpen = streamSectionExpanded[platform][section.id];
            return (
              <div key={`stream-section:${platform}:${section.id}`} className="kd-stream-section">
                <button
                  type="button"
                  className="kd-folder kd-folder-action kd-stream-section-label"
                  style={depthStyle(depth)}
                  aria-expanded={sectionOpen}
                  title={`${sectionOpen ? "收起" : "展开"}${section.label}`}
                  onClick={() => {
                    treeMotion.expect(`section:${platform}:${section.id}`, !sectionOpen);
                    setStreamSectionExpanded(platform, section.id, !sectionOpen);
                  }}
                >
                  <span className="kd-folder-caret">
                    <Disclosure open={sectionOpen} />
                  </span>
                  <span className="kd-folder-icon">
                    {sectionOpen ? <FolderOpen {...ROW_ICON} /> : <Folder {...ROW_ICON} />}
                  </span>
                  <span className="kd-folder-name kd-truncate">{section.label}</span>
                  <span className="kd-folder-trail">
                    {countsShown && (
                      <span className="kd-folder-count">{section.playlists.length}</span>
                    )}
                  </span>
                </button>
                {sectionOpen && (
                  <div
                    className="kd-tree-branch"
                    ref={treeMotion.branch(`section:${platform}:${section.id}`)}
                  >
                    {section.playlists.map((playlist) => playlistRow(playlist, depth + 1))}
                  </div>
                )}
              </div>
            );
          })}
      </>
    );
  };

  /** A platform's own folder inside a root that stands for several. */
  const renderStreamGroup = (platform: StreamBrowsePlatform) => {
    const label = STREAM_MEMBER_LABEL[platform] ?? platform;
    const groupOpen = streamSectionExpanded[platform].group;
    const count = streamPlaylists[platform]?.length;
    return (
      <div key={`stream-group:${platform}`} className="kd-stream-section">
        <button
          type="button"
          className="kd-folder kd-folder-action kd-stream-section-label"
          data-stream-platform={platform}
          style={depthStyle(1)}
          aria-expanded={groupOpen}
          title={`${groupOpen ? "收起" : "展开"}${label}`}
          onClick={() => {
            treeMotion.expect(`group:${platform}`, !groupOpen);
            setStreamSectionExpanded(platform, "group", !groupOpen);
          }}
        >
          <span className="kd-folder-caret">
            <Disclosure open={groupOpen} />
          </span>
          <span className="kd-folder-icon">
            {groupOpen ? <FolderOpen {...ROW_ICON} /> : <Folder {...ROW_ICON} />}
          </span>
          <span className="kd-folder-name kd-truncate">{label}</span>
          <span className="kd-folder-trail">
            {countsShown && count !== undefined && count > 0 && (
              <span className="kd-folder-count">{count}</span>
            )}
          </span>
        </button>
        {groupOpen && (
          <div className="kd-tree-branch" ref={treeMotion.branch(`group:${platform}`)}>
            {renderStreamPlatform(platform, 2)}
          </div>
        )}
      </div>
    );
  };

  const renderStreamRoot = (streamRoot: StreamRoot) => {
    const platform = streamRoot.id;
    const members = rootMembers(streamRoot);
    const accountState = rootAccountState(accounts, members);
    const canBrowse = accountCanBrowse(accountState);
    const browsable = members.filter((member) =>
      accountCanBrowse(accounts.find((account) => account.platform === member)?.state),
    );
    const loading = browsable.some((member) => streamLoading[member]);
    const error = members.map((member) => streamErrors[member]).find(Boolean) ?? "";
    const counted = members.map((member) => streamPlaylists[member]).filter((list) => list !== null);
    const count = counted.length > 0
      ? counted.reduce((sum, list) => sum + (list?.length ?? 0), 0)
      : undefined;
    // A signed-out source has nothing to unfold: its row is the way in to the account settings.
    const needsLogin = accountState === "missing" || accountState === "expired";
    const open = streamExpanded[platform] && !needsLogin;
    const rootHint = !accountState
      ? accountsError || "正在读取账号状态"
      : accountState === "missing"
        ? `登录${streamRoot.label}后查看收藏和歌单`
        : accountState === "expired"
          ? `${streamRoot.label}登录已失效`
          : error || `${streamRoot.label}远程收藏和歌单`;
    const activateRoot = () => {
      if (needsLogin) {
        // 旋钮只负责浏览，不替用户弹出设置面板。
        if (!isMidiBrowseActivate()) openLoginSettings(members[0]);
        return;
      }
      if (isMidiBrowseActivate() && streamExpanded[platform]) return;
      toggleStreamRoot(streamRoot);
    };
    return (
      <div key={`stream-root:${platform}`} className="kd-stream-root">
        <div
          className="kd-folder kd-folder-stream-root"
          data-sidebar-root-row=""
          data-stream-platform={platform}
          {...midiBrowseItemProps("search", `search:root:${platform}`)}
          style={depthStyle(0)}
          role="button"
          tabIndex={0}
          aria-expanded={needsLogin ? undefined : open}
          title={`${rootHint} · 拖动调整侧栏顺序`}
          onContextMenu={(event) => openStreamRootMenu(event, platform)}
          onPointerDown={(event) =>
            beginRootPointerReorder(event, `stream:${platform}`)
          }
          onClick={activateRoot}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            activateRoot();
          }}
        >
          <span className="kd-folder-caret">
            {!needsLogin && <Disclosure open={open} />}
          </span>
          <span className="kd-folder-icon">
            <PlatformMark id={platform} size={ROW_ICON.size} />
          </span>
          <span className="kd-folder-name kd-truncate">{streamRoot.label}</span>
          {/* A signed-out row has no count to hide, so no eye either: its name runs up to 登录. */}
          <span
            className="kd-folder-trail"
            data-action={canBrowse ? "true" : needsLogin ? undefined : "eye"}
            data-eye={needsLogin ? undefined : ""}
            data-busy={(canBrowse && loading) || undefined}
          >
            {needsLogin ? (
              <span className="kd-folder-login">
                {accountState === "expired" ? "重新登录" : "登录"}
              </span>
            ) : (
              countsShown && count !== undefined && count > 0 && (
                <span className="kd-folder-count">{count}</span>
              )
            )}
            {!needsLogin && countsEye}
            {canBrowse && (
              <button
                type="button"
                className="kd-folder-more kd-stream-refresh"
                disabled={loading}
                aria-label={`刷新${streamRoot.label}歌单`}
                title={`刷新${streamRoot.label}歌单`}
                onClick={(event) => {
                  event.stopPropagation();
                  refreshStreamRoot(streamRoot);
                }}
              >
                {loading ? (
                  <LoaderCircle className="kd-spin" {...ROW_ICON} />
                ) : (
                  <RefreshCw {...ROW_ICON} />
                )}
              </button>
            )}
          </span>
        </div>

        {/* Everything a source unfolds is one branch, so it can arrive and fold as one. */}
        {open && (
          <div className="kd-tree-branch" ref={treeMotion.branch(`stream:${platform}`)}>
            {members.length === 1
              ? renderStreamPlatform(platform, 1)
              : browsable.length > 0
                ? browsable.map(renderStreamGroup)
                : renderStreamPlatform(members[0], 1)}
          </div>
        )}
      </div>
    );
  };

  const render = (node: FolderNode, depth: number) => {
    const open = expanded.has(node.path);
    const active = filter.folder === node.path;
    const expandableRoot = depth === 0 && node.children.length > 0;
    const pendingHint =
      node.pending_count > 0
        ? `${node.pending_count} 个文件还没进曲库，点一下这个文件夹就导入`
        : "";
    const rowTitle = [node.path, pendingHint, depth === 0 ? "拖动调整侧栏顺序" : ""]
      .filter(Boolean)
      .join(" · ");
    if (renaming?.node.path === node.path) {
      // The row gives way to a field in the same place; it takes no click, drag or drop.
      return (
        <div key={node.path} className="kd-tree-node">
          <div className="kd-folder kd-folder-new" style={depthStyle(depth)}>
            <span className="kd-folder-caret">
              {node.children.length > 0 ? <Disclosure open={open} /> : null}
            </span>
            <span className="kd-folder-icon">
              <FolderGlyph
                path={node.path}
                audioDir={settings?.download_dir}
                videoDir={settings?.download_dir}
                root={node.is_root}
                open={open && node.children.length > 0}
                icon={ROW_ICON}
              />
            </span>
            <input
              autoFocus
              data-kd-motion="pop"
              aria-label="文件夹名称"
              value={renaming.name}
              disabled={renaming.saving}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
              onBlur={commitRename}
              onKeyDown={(event) => {
                event.stopPropagation();
                // Enter that confirms an input-method candidate is not the end of the name.
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") {
                  renamingRef.current = null;
                  setRenaming(null);
                }
              }}
            />
          </div>
          {open && node.children.length > 0 && (
            <div className="kd-tree-branch" ref={treeMotion.branch(`folder:${node.path}`)}>
              {node.children.map((child) => render(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }
    return (
      <div key={node.path} className="kd-tree-node">
        <div
          className="kd-folder"
          data-sidebar-root-row={depth === 0 ? "" : undefined}
          role={expandableRoot ? "button" : undefined}
          tabIndex={expandableRoot ? 0 : undefined}
          {...{ [FOLDER_DROP_PATH_ATTR]: node.path }}
          {...midiBrowseItemProps("local", `local:folder:${node.path}`)}
          data-active={active}
          // 单选由“当前文件夹”的红字表达；只有多选才需要另外标出来。
          data-selected={(selectedFolders.size > 1 && selectedFolders.has(node.path)) || undefined}
          data-menu={menu?.node.path === node.path || undefined}
          data-drop={dropTarget === node.path && dropEdge === ""}
          data-edge={dropTarget === node.path ? dropEdge || undefined : undefined}
          style={depthStyle(depth)}
          title={rowTitle}
          draggable={!node.is_root}
          onDragStart={(event) => {
            if (node.is_root) return;
            event.stopPropagation();
            clearTextSelection();
            event.dataTransfer.setData(
              FOLDER_DND_TYPE,
              JSON.stringify({ parent: node.parent, name: node.name } satisfies DragInfo),
            );
            event.dataTransfer.effectAllowed = "copyMove";
            setDragGhost(event.dataTransfer, { title: node.name, glyph: "folder" });
            beginTemporaryFolderDrag(node.path, () => importPending(node));
          }}
          onDragEnd={endTemporaryFolderDrag}
          onPointerDown={
            depth === 0
              ? (event) => beginRootPointerReorder(event, `local:${node.path}`)
              : undefined
          }
          onClick={(event) => {
            if (hasTextSelectionWithin(event.currentTarget)) return;
            if (selectFolderRow(event, node)) return;
            // 根目录也是一个文件夹：整行打开它的曲目（含子文件夹），收起/展开交给箭头。
            // 第一次进来时顺手展开，子文件夹就在眼前。
            if (expandableRoot && !active && !open) {
              setAllMenu(null);
              toggle(node.path);
            }
            // 进文件夹默认按手排顺序看（set 是按演出顺序排的）；
            // 回到全库时手排没有意义，还原成默认的文件创建顺序。
            setFilter(
              active && !isMidiBrowseActivate()
                ? { folder: "", folderDeep: true, sort: "file_created_at", order: "desc" }
                : { folder: node.path, folderDeep: true, sort: "custom" },
            );
            if (!active) importPending(node);
            onNavigate?.();
          }}
          onKeyDown={(event) => {
            if (!expandableRoot || event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.currentTarget.click();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setAllMenu(null);
            if (!selectedFolders.has(node.path)) {
              setSelectedFolders(new Set([node.path]));
              folderSelectionAnchor.current = node.path;
            }
            setMenu({ node, x: event.clientX, y: event.clientY });
          }}
          onDragOverCapture={(event) => {
            const types = Array.from(event.dataTransfer.types);
            if (types.includes(FOLDER_DND_TYPE)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              // 落在行中间的 40% = 放进这个文件夹（整块反白）；
              // 上下两边 = 插到它前面/后面（画一条插入线）。和访达一个手感。
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientY - rect.top) / rect.height;
              setDropTarget(node.path);
              setDropEdge(ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "");
              return;
            }
            if (isSearchDownloadDrag(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropTarget(node.path);
              setDropEdge("");
              return;
            }
            if (!isTrackDrag(event)) return;
            event.preventDefault();
            // 默认复制本地文件；按住 Option/Alt 才移动原文件。光标先把意图说清楚。
            event.dataTransfer.dropEffect = event.altKey ? "move" : "copy";
            setDropTarget(node.path);
            setDropEdge("");
          }}
          onDragLeave={() =>
            setDropTarget((prev) => {
              if (prev !== node.path) return prev;
              setDropEdge("");
              return "";
            })
          }
          onDropCapture={(event) => {
            event.preventDefault();
            const edge = dropEdge;
            setDropTarget("");
            setDropEdge("");
            const folderRaw = event.dataTransfer.getData(FOLDER_DND_TYPE);
            if (folderRaw) {
              try {
                const info = JSON.parse(folderRaw) as DragInfo;
                const from = `${info.parent}/${info.name}`;
                if (from === node.path) return; // 拖到自己身上，什么都不做
                if (edge === "") {
                  // 落在行中间 = 放进这个文件夹里（真实的目录移动）
                  void api
                    .moveFolder(from, node.path)
                    .then((tree) => {
                      const folder = relocatedFolderPath(tree, useLibraryStore.getState().filter.folder, from, node.path, info.name);
                      if (folder) setFilter({ folder });
                      return refreshFolders();
                    })
                    .catch((error: unknown) => setNotice((error as Error).message));
                } else if (info.parent === node.parent) {
                  // 同一层的上下边缘 = 换顺序
                  applyReorder(node.parent, info.name, node.name, edge === "after");
                } else {
                  // 跨层拖到边缘：先搬到同一层，落在末尾。再想精确插位，
                  // 在同层里拖一次就行——不为一个少见操作把接口做复杂。
                  void api
                    .moveFolder(from, node.parent)
                    .then((tree) => {
                      const folder = relocatedFolderPath(tree, useLibraryStore.getState().filter.folder, from, node.parent, info.name);
                      if (folder) setFilter({ folder });
                      return refreshFolders();
                    })
                    .catch((error: unknown) => setNotice((error as Error).message));
                }
              } catch {
                setNotice("拖拽数据读不出来");
              }
              return;
            }
            if (isSearchDownloadDrag(event)) {
              // 搜到的歌/视频拖进文件夹 = 入队并落进这里；左表立刻出现待下载行。
              void enqueueSearchDrop(event, node.path).catch((error: unknown) =>
                setNotice((error as Error).message),
              );
              return;
            }
            const ids = trackIdsFromDrop(event);
            if (ids.length === 0) return;
            runOp(ids, node.path, event.altKey);
          }}
        >
          <button
            type="button"
            className="kd-folder-caret"
            aria-label={open ? "收起" : "展开"}
            aria-expanded={node.children.length > 0 ? open : undefined}
            disabled={node.children.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              setAllMenu(null);
              toggle(node.path);
            }}
          >
            {node.children.length > 0 ? <Disclosure open={open} /> : null}
          </button>
          <span
            className="kd-folder-icon kd-folder-drag"
            title={node.is_root ? "拖动调整侧栏顺序" : "拖到右侧临时打开，或拖到侧栏移动、排序"}
          >
            <FolderGlyph
              path={node.path}
              audioDir={settings?.download_dir}
              videoDir={settings?.download_dir}
              root={node.is_root}
              open={open && node.children.length > 0}
              icon={ROW_ICON}
            />
          </span>
          <span className="kd-folder-name kd-truncate">{node.name}</span>
          <span className="kd-folder-trail" data-action="true" data-eye={depth === 0 ? "" : undefined}>
            {/* 未入库的用不同的样子标出来，点一下就导入——空文件夹和"没扫过"是两回事。
                它是待办而不是统计：数量关掉以后也留着。 */}
            {node.pending_count > 0 ? (
              <span className="kd-folder-count" data-pending="true">
                {importing === node.path ? "…" : `+${node.pending_count}`}
              </span>
            ) : (
              countsShown && node.total_count > 0 && (
                <span className="kd-folder-count">{node.total_count}</span>
              )
            )}
            {depth === 0 && countsEye}
            <button
              type="button"
              className="kd-folder-more"
              aria-label="文件夹操作"
              onClick={(event) => {
                event.stopPropagation();
                setAllMenu(null);
                // A second click on the button that opened the menu closes it.
                if (menu?.anchor === event.currentTarget) {
                  setMenu(null);
                  return;
                }
                if (!selectedFolders.has(node.path)) {
                  setSelectedFolders(new Set([node.path]));
                  folderSelectionAnchor.current = node.path;
                }
                setMenu({ node, ...menuPointUnder(event.currentTarget) });
              }}
            >
              <MoreHorizontal {...ROW_ICON} />
            </button>
          </span>
        </div>
        {newFolder?.parent === node.path && (
          <div className="kd-folder kd-folder-new" data-kd-motion="pop" style={depthStyle(depth + 1)}>
            <span className="kd-folder-caret" />
            <span className="kd-folder-icon">
              <Folder {...ROW_ICON} />
            </span>
            <input
              autoFocus
              aria-label="新文件夹名称"
              value={newFolder.name}
              disabled={newFolder.saving}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setNewFolder({ ...newFolder, name: event.target.value })}
              onKeyDown={(event) => {
                event.stopPropagation();
                // Enter that confirms an input-method candidate is not the end of the name.
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") commitNewFolder();
                if (event.key === "Escape") setNewFolder(null);
              }}
            />
          </div>
        )}
        {open && node.children.length > 0 && (
          <div className="kd-tree-branch" ref={treeMotion.branch(`folder:${node.path}`)}>
            {node.children.map((child) => render(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderAllTracksRoot = () => (
    <div
      className="kd-folder"
      data-sidebar-root-row=""
      {...{ [SEARCH_DEFAULT_DOWNLOAD_DROP_ATTR]: "" }}
      {...midiBrowseItemProps("local", "local:all")}
      data-active={filter.folder === ""}
      data-menu={allMenu !== null || undefined}
      data-drop={dropTarget === ALL_TRACKS_DROP_TARGET ? "true" : undefined}
      style={depthStyle(0)}
      title="拖动调整侧栏顺序；拖入下载会落到默认下载文件夹"
      onPointerDown={(event) => beginRootPointerReorder(event, ALL_TRACKS_ROOT_ID)}
      onClick={() => {
        setSelectedFolders(new Set());
        setFilter({ folder: "", folderDeep: true, sort: "file_created_at", order: "desc" });
        onNavigate?.();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(null);
        setSelectedFolders(new Set());
        setRescanArmed(false);
        setAllMenu({ x: event.clientX, y: event.clientY });
      }}
      onDragOverCapture={(event) => {
        if (!isSearchDownloadDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropTarget(ALL_TRACKS_DROP_TARGET);
        setDropEdge("");
      }}
      onDragLeave={() =>
        setDropTarget((current) => {
          if (current !== ALL_TRACKS_DROP_TARGET) return current;
          setDropEdge("");
          return "";
        })
      }
      onDropCapture={(event) => {
        event.preventDefault();
        setDropTarget("");
        setDropEdge("");
        if (!isSearchDownloadDrag(event)) return;
        void enqueueSearchDrop(event, SEARCH_DEFAULT_DOWNLOAD_SENTINEL).catch(
          (error: unknown) => setNotice((error as Error).message),
        );
      }}
    >
      <span className="kd-folder-caret" />
      <span className="kd-folder-icon">
        <Library {...ROW_ICON} />
      </span>
      <span className="kd-folder-name kd-truncate">全部曲目</span>
      <span className="kd-folder-trail" data-action="true" data-eye="">
        {countsShown && <span className="kd-folder-count">{allTrackCount}</span>}
        {countsEye}
        <button
          type="button"
          className="kd-folder-more"
          aria-label="全部曲目操作"
          onClick={(event) => {
            event.stopPropagation();
            setMenu(null);
            setRescanArmed(false);
            // A second click on the button that opened the menu closes it.
            if (allMenu?.anchor === event.currentTarget) {
              setAllMenu(null);
              return;
            }
            setSelectedFolders(new Set());
            setAllMenu(menuPointUnder(event.currentTarget));
          }}
        >
          <MoreHorizontal {...ROW_ICON} />
        </button>
      </span>
    </div>
  );

  const renderOutsideRoot = () => (
    <div
      className="kd-folder"
      data-sidebar-root-row=""
      data-active={isOutsideFolder(filter.folder)}
      {...midiBrowseItemProps("local", "local:outside")}
      style={depthStyle(0)}
      title="不在曲库目录里的曲目 · 拖动调整侧栏顺序"
      onPointerDown={(event) => beginRootPointerReorder(event, OUTSIDE_ROOT_ID)}
      onClick={() => {
        setFilter({
          folder: OUTSIDE_FOLDER,
          folderDeep: true,
          sort: "file_created_at",
          order: "desc",
        });
        onNavigate?.();
      }}
    >
      <span className="kd-folder-caret" />
      <span className="kd-folder-icon">
        <Files {...ROW_ICON} />
      </span>
      <span className="kd-folder-name kd-truncate">其他</span>
      <span className="kd-folder-trail" data-action="eye" data-eye="">
        {countsShown && <span className="kd-folder-count">{folders!.outside}</span>}
        {countsEye}
      </span>
    </div>
  );

  const renderSidebarRoot = (item: SidebarRootItem) => {
    if (item.kind === "all") return renderAllTracksRoot();
    if (item.kind === "stream") return renderStreamRoot(item.streamRoot);
    if (item.kind === "local") return render(item.root, 0);
    return renderOutsideRoot();
  };

  const menuPaths = menu
    ? selectedFolders.has(menu.node.path)
      ? [...selectedFolders]
      : [menu.node.path]
    : [];
  const selectionToken = menuPaths.slice().sort().join("|");
  const canDeleteSelectedFolders =
    menuPaths.length > 1 &&
    menuPaths.every((path) => {
      const node = folderByPath.get(path);
      return Boolean(
        node &&
          !node.is_root &&
          node.total_count === 0 &&
          node.pending_count === 0 &&
          node.children.length === 0,
      );
    });

  return (
    <div className="kd-folder-pane">
      {/* 原来这里有一行「文件夹」标题 + 「初始化顺序」图标 + 「含子级」勾选。
          全删了：
          · 标题——左栏里除了文件夹没有别的东西，不用再说一遍；
          · 初始化顺序——一个不说自己是干嘛的图标按钮，点了也看不出发生了什么。
            真要拖动排序时，`applyFolderOp` 会自己按需写清单，不必先手动点一下；
          · 含子级——选中一个歌单文件夹时，想看的本来就是它整棵子树里的曲目，
            默认就该是"含"。做成开关只是把一个没人会关的选项摆在最显眼的位置。
      `folderDeep` 字段保留在 store 里（后端 API 仍然收它），默认恒为 true。 */}
      <div
        ref={rootListRef}
        className="kd-scroll kd-folder-list"
        onClickCapture={(event) => {
          if (!suppressRootClickRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          suppressRootClickRef.current = false;
        }}
      >
        {/* 添加文件夹 / 文件是固定入口；其余根项都在下面按用户保存的顺序渲染。 */}
        <button
          type="button"
          className="kd-folder kd-folder-action kd-folder-add"
          style={depthStyle(0)}
          disabled={scanning}
          title="选磁盘上的文件夹加进曲库，导入和分析都在后台自动做完"
          onClick={() => void addFolders()}
        >
          <span className="kd-folder-caret" />
          <span className="kd-folder-icon">
            <FolderInput {...ROW_ICON} />
          </span>
          <span className="kd-folder-name kd-truncate">添加文件夹</span>
        </button>
        {window.kdj?.pickMediaFiles && (
          <button
            type="button"
            className="kd-folder kd-folder-action kd-folder-add"
            style={depthStyle(0)}
            disabled={scanning}
            title="选磁盘上的歌曲文件加进曲库，不在曲库文件夹里的歌在「全部曲目」里"
            onClick={() => void addFiles()}
          >
            <span className="kd-folder-caret" />
            <span className="kd-folder-icon">
              <FileMusic {...ROW_ICON} />
            </span>
            <span className="kd-folder-name kd-truncate">添加文件</span>
          </button>
        )}
        {orderedRootItems.map((item) => (
          <div
            key={item.id}
            className="kd-sidebar-root-slot"
            data-sidebar-root-id={item.id}
            // 在线来源与本地曲库各成一组；用户拖乱顺序后，分组线跟着走。
            data-root-group={item.kind === "stream" ? "online" : "library"}
            data-root-dragging={rootDragging === item.id ? "true" : undefined}
            data-root-edge={rootDrop?.id === item.id ? rootDrop.edge : undefined}
          >
            {renderSidebarRoot(item)}
          </div>
        ))}
      </div>

      {/* 文件夹操作出错时，消息必须留在被操作的树旁边。 */}
      <InlineNotice
        className="kd-folder-notice"
        block
        text={notice}
        onDismiss={() => setNotice("")}
      />

      {streamRootMenu}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchorTop={menu.top}
          anchorElement={menu.anchor}
          toggleAnchor={!!menu.anchor}
          onClose={() => setMenu(null)}
        >
          <button
            type="button"
            disabled={!undo.available}
            title={
              undo.available
                ? `撤回上次${undoName} ${undo.count} 首`
                : "没有可撤回的曲库操作"
            }
            onClick={() => {
              setMenu(null);
              void undoLast().catch(() => undefined);
            }}
          >
            <Undo2 size={12} />
            撤回{undo.available ? `上次${undoName}` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              const parent = menu.node.path;
              setMenu(null);
              setExpanded((current) => new Set(current).add(parent));
              setNewFolder({ parent, name: "新建文件夹", saving: false });
            }}
          >
            <FolderPlus size={12} />
            新建子文件夹
          </button>
          <button
            type="button"
            disabled={menu.node.is_root}
            title={menu.node.is_root ? "曲库根目录去设置里改" : undefined}
            onClick={() => {
              setMenu(null);
              setNewFolder(null);
              setRenaming({ node: menu.node, name: menu.node.name, saving: false });
            }}
          >
            <PencilLine size={12} />
            重命名
          </button>
          <button
            type="button"
            onClick={() => {
              const paths = menuPaths;
              setMenu(null);
              useAppStore.getState().openDuplicatePanel(paths);
            }}
          >
            <Files size={12} />
            曲库优化分析（含子文件夹）
            {menuPaths.length > 1 ? " · " + menuPaths.length + " 个" : ""}
          </button>
          {menuPaths.length > 1 ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const paths = menuPaths;
                  setMenu(null);
                  void window.kdj?.pickFolder()
                    .then((destParent) => {
                      if (!destParent) return;
                      const name = prompt("新文件夹名称", "合并文件夹");
                      if (!name) return;
                      return api.mergeFolders(paths, destParent, name);
                    })
                    .then((result) => {
                      if (!result) return;
                      setSelectedFolders(new Set([result.target]));
                      setExpanded((current) => new Set(current).add(result.target));
                      setFilter({ folder: result.target, sort: "custom" });
                      return refreshFolders();
                    })
                    .catch((error: unknown) => setNotice("合并失败：" + (error as Error).message));
                }}
              >
                <FolderDown size={12} />
                合并到新文件夹…
              </button>
              <button
                type="button"
                data-danger="true"
                onClick={() => {
                  if (forgetArmed !== selectionToken) {
                    setForgetArmed(selectionToken);
                    return;
                  }
                  const paths = menuPaths.slice().sort((left, right) => right.length - left.length);
                  setMenu(null);
                  setForgetArmed("");
                  void (async () => {
                    let removed = 0;
                    for (const path of paths) {
                      removed += (await api.forgetFolder(path)).removed;
                    }
                    setSelectedFolders(new Set());
                    await Promise.all([
                      refreshFolders(),
                      useLibraryStore.getState().refresh(),
                      useLibraryStore.getState().refreshStats(),
                    ]);
                    setNotice("已批量移出曲库 " + removed + " 首（磁盘文件保留）");
                  })().catch((error: unknown) =>
                    setNotice("批量移出失败：" + (error as Error).message),
                  );
                }}
              >
                <ListX size={12} />
                {forgetArmed === selectionToken
                  ? "再次点击确认批量移出"
                  : "批量移出曲库（文件保留）"}
              </button>
              <button
                type="button"
                data-danger="true"
                disabled={!canDeleteSelectedFolders}
                title={
                  canDeleteSelectedFolders
                    ? "从磁盘删除所选空文件夹"
                    : "只有不含曲目、待导入文件和子目录的文件夹才能批量删除"
                }
                onClick={() => {
                  const paths = menuPaths.slice().sort((left, right) => right.length - left.length);
                  setMenu(null);
                  void (async () => {
                    for (const path of paths) await api.deleteFolder(path);
                    setSelectedFolders(new Set());
                    await refreshFolders();
                  })().catch((error: unknown) =>
                    setNotice("批量删除失败：" + (error as Error).message),
                  );
                }}
              >
                <Trash2 size={12} />
                批量删除空文件夹
              </button>
            </>
          ) : null}
          <button type="button" onClick={() => {
            const paths = menuPaths;
            setMenu(null);
            void analyzeFolderPaths(paths, true).catch((error: unknown) =>
              setNotice((error as Error).message),
            );
          }}>
            <BarChart3 size={12} />
            分析曲目（含子文件夹）
          </button>
          <button type="button" onClick={() => {
            const paths = menuPaths;
            setMenu(null);
            void analyzeFolderPaths(paths, false).catch((error: unknown) =>
              setNotice((error as Error).message),
            );
          }}>
            <BarChart3 size={12} />
            仅分析当前层
          </button>
          {(() => {
            const path = menu.node.path;
            const downloadPath = cleanPath(settings?.download_dir);
            const isDownload = cleanPath(path) === downloadPath;
            return (
              <button
                type="button"
                disabled={isDownload}
                title={isDownload ? "已经是当前下载文件夹" : "下载的音频和视频都会进这里"}
                onClick={() => {
                  setMenu(null);
                  void saveSettings({ download_dir: path, video_download_dir: path }).catch(
                    (error: unknown) => setNotice((error as Error).message),
                  );
                }}
              >
                <Music2 size={12} />
                设为下载文件夹{isDownload ? " · 当前" : ""}
              </button>
            );
          })()}
          {/* 文件夹分类只处理本地文件：复制会创建独立文件，粘贴会移动原文件。 */}
          <button
            type="button"
            disabled={!clipboard}
            title={
              clipboard
                ? `把剪贴板里的 ${clipboard.ids.length} 首复制到这里`
                : "先在曲目表里按 Cmd/Ctrl+C 或 Cmd/Ctrl+X"
            }
            onClick={() => {
              const dest = menu.node.path;
              setMenu(null);
              setNotice("");
              void paste(dest, "copy").catch((error: unknown) =>
                setNotice((error as Error).message),
              );
            }}
          >
            <Copy size={12} />
            复制{clipboard ? ` ${clipboard.ids.length} 首` : ""}
          </button>
          <button
            type="button"
            disabled={!clipboard}
            title={
              clipboard
                ? `把剪贴板里的 ${clipboard.ids.length} 首移动到这里`
                : "先在曲目表里按 Cmd/Ctrl+C 或 Cmd/Ctrl+X"
            }
            onClick={() => {
              const dest = menu.node.path;
              setMenu(null);
              setNotice("");
              void paste(dest, "move").catch((error: unknown) =>
                setNotice((error as Error).message),
              );
            }}
          >
            <ClipboardPaste size={12} />
            粘贴{clipboard ? ` ${clipboard.ids.length} 首` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              void window.kdj?.openPath(menu.node.path);
            }}
          >
            <FolderOpen size={12} />
            在访达中打开
          </button>
          <button
            type="button"
            data-danger="true"
            title={
              menu.node.is_root
                ? "注销这个曲库根，并把下面的歌从软件里摘掉；磁盘文件不动"
                : "把这个文件夹里的歌从软件里摘掉；磁盘文件不动"
            }
            onClick={() => {
              const path = menu.node.path;
              const count = menu.node.total_count;
              const isRoot = menu.node.is_root;
              // 有曲目时上膛一次，避免右键误触把整库摘空
              if (count > 0 && forgetArmed !== path) {
                setForgetArmed(path);
                return;
              }
              setMenu(null);
              setForgetArmed("");
              void forgetFolder(path)
                .then(async (removed) => {
                  try {
                    const next = await api.getSettings();
                    useAppStore.setState({ settings: next });
                  } catch {
                    /* 设置晚一拍不挡主流程 */
                  }
                  setNotice(
                    removed > 0
                      ? `已移出曲库 ${removed} 首（文件仍在磁盘）`
                      : isRoot
                        ? "已移出曲库根目录（文件仍在磁盘）"
                        : "这个文件夹里本来就没有入库曲目",
                  );
                })
                .catch((error: unknown) => setNotice((error as Error).message));
            }}
          >
            <ListX size={12} />
            {forgetArmed === menu.node.path && menu.node.total_count > 0
              ? `确认移出 ${menu.node.total_count} 首？文件保留`
              : menu.node.is_root
                ? `移出曲库根${menu.node.total_count > 0 ? `（${menu.node.total_count} 首）` : ""}`
                : `移出曲库${menu.node.total_count > 0 ? `（${menu.node.total_count} 首）` : ""}`}
          </button>
          <button
            type="button"
            data-danger="true"
            disabled={menu.node.is_root || menu.node.total_count > 0}
            title={
              menu.node.is_root
                ? "曲库根请用上面的「移出曲库根」；这里只删磁盘上空文件夹"
                : menu.node.total_count > 0
                  ? "里面还有曲目，先移出曲库或移走再删"
                  : "从磁盘删除这个空文件夹"
            }
            onClick={() => {
              setMenu(null);
              void api
                .deleteFolder(menu.node.path)
                .then(() => {
                  if (filter.folder === menu.node.path) setFilter({ folder: "" });
                  return refreshFolders();
                })
                .catch((error: unknown) => setNotice((error as Error).message));
            }}
          >
            <Trash2 size={12} />
            删除空文件夹
          </button>
        </ContextMenu>
      )}
      {allMenu && (
        <ContextMenu
          x={allMenu.x}
          y={allMenu.y}
          anchorTop={allMenu.top}
          anchorElement={allMenu.anchor}
          toggleAnchor={!!allMenu.anchor}
          onClose={() => {
            setAllMenu(null);
            setRescanArmed(false);
          }}
        >
          <button
            type="button"
            onClick={() => {
              setAllMenu(null);
              useAppStore.getState().openDuplicatePanel([], { all: true });
            }}
          >
            <Files size={12} />
            曲库优化分析
          </button>
          <button
            type="button"
            disabled={allTrackCount === 0}
            onClick={() => {
              setAllMenu(null);
              void analyzeFolderPaths(null, true).catch((error: unknown) =>
                setNotice((error as Error).message),
              );
            }}
          >
            <BarChart3 size={12} />
            分析全部曲目
          </button>
          <button
            type="button"
            data-danger={scanning || rescanArmed ? "true" : undefined}
            disabled={scanning ? scan?.current === "正在取消…" : roots.length === 0}
            title={
              scanning
                ? "取消导入并清除本次新增记录；保留原文件和原有曲库"
                : rescanArmed
                  ? "再次点击后才会重新遍历全部曲库文件夹"
                  : "需要在当前右键面板中再次确认"
            }
            onClick={() => {
              if (scanning) {
                setAllMenu(null);
                setRescanArmed(false);
                void cancelScan().catch((error: unknown) =>
                  setNotice(`取消扫描失败：${(error as Error).message}`),
                );
                return;
              }
              if (!rescanArmed) {
                setRescanArmed(true);
                return;
              }
              const paths = roots.map((root) => root.path);
              setAllMenu(null);
              setRescanArmed(false);
              void startScan(paths, true).catch((error: unknown) =>
                setNotice((error as Error).message),
              );
            }}
          >
            {scanning ? <X size={12} /> : <RefreshCw size={12} />}
            {scanning
              ? scan?.current === "正在取消…"
                ? "正在取消扫描"
                : "取消正在进行的扫描"
              : rescanArmed
                ? `确认重新扫描 ${roots.length} 个文件夹？`
                : "重新扫描全部文件夹…"}
          </button>
          {rescanArmed && !scanning ? (
            <button type="button" onClick={() => setRescanArmed(false)}>
              <X size={12} />
              取消
            </button>
          ) : null}
        </ContextMenu>
      )}
    </div>
  );
}

const METHOD_LABEL: Record<string, string> = {
  move: "移动",
  copy: "复制",
};
