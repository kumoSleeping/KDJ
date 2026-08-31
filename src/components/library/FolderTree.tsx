import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  BarChart3,
  ClipboardPaste,
  Copy,
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
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api } from "../../lib/api";
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
import { orderStreamPlaylistsByRecent } from "../../lib/streamPlaylistOrder";
import {
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_DND_TYPE,
} from "../../lib/trackDrag";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import {
  STREAM_BROWSE_PLATFORMS,
  streamAccountBinding,
  useStreamBrowseStore,
  type ActiveStreamPlaylist,
  type StreamBrowsePlatform,
  type StreamPlaylistSectionId,
} from "../../stores/streamBrowseStore";
import type { AccountState, FolderNode, StreamPlaylist } from "../../types";
import { ContextMenu, InlineNotice } from "../common";
import { PlatformMark } from "../download/PlatformMark";
import { isMidiBrowseActivate, midiBrowseItemProps } from "../../lib/midiLibraryNav";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";

/** @deprecated 请从 `lib/trackDrag` 引用；保留 re-export 以免旧 import 断掉。 */
export { TRACK_DND_TYPE };
/** 拖文件夹换顺序用的 MIME，和上面分开，dragover 时才好区别对待。 */
const FOLDER_DND_TYPE = "application/x-kdj-folder";
const ALL_TRACKS_DROP_TARGET = "__kd_all_tracks__";
const ALL_TRACKS_ROOT_ID = "library:all";
const OUTSIDE_ROOT_ID = "library:outside";

const STREAM_ROOTS: ReadonlyArray<{ id: StreamBrowsePlatform; label: string }> = [
  { id: "wyy", label: "NetEase" },
  { id: "qqm", label: "Q Music" },
  { id: "soundcloud", label: "SoundCloud" },
  { id: "ytm", label: "YouTube Music" },
  { id: "youtube", label: "YouTube Video" },
  { id: "bilibili", label: "Bilibili" },
];

type SidebarRootItem =
  | { id: typeof ALL_TRACKS_ROOT_ID; kind: "all" }
  | {
      id: `stream:${StreamBrowsePlatform}`;
      kind: "stream";
      streamRoot: (typeof STREAM_ROOTS)[number];
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
  const known = new Set([...favorite, ...created, ...collected]);
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
  ].filter((section) => section.playlists.length > 0) as StreamPlaylistSection[];
}

function accountCanBrowse(state: AccountState | undefined): boolean {
  return state === "valid" || state === "unknown";
}

function streamPlaylistCountLabel(playlist: StreamPlaylist): string {
  if (playlist.platform === "bilibili") return `${playlist.count} videos`;
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
      return { kind: "stream", platform: record.platform as StreamBrowsePlatform };
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
 * 绑定账号只恢复本地目录；平台请求只允许由展开或刷新按钮触发。
 * enabled=false 时保留 hook 顺序却不注册副作用，展开态交给内部 FolderTree 接管。
 */
function useStreamBrowseLifecycle(enabled: boolean) {
  const accounts = useAppStore((state) => state.accounts);
  const accountsError = useAppStore((state) => state.accountsError);
  const appBooting = useAppStore((state) => state.booting);
  const bindStreamAccount = useStreamBrowseStore((state) => state.bindAccount);
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

  return { accounts, accountsError };
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
  size,
}: {
  path: string;
  audioDir?: string;
  videoDir?: string;
  root: boolean;
  open: boolean;
  size: number;
}) {
  const purpose = folderPurpose(path, audioDir, videoDir);
  if (purpose) {
    return (
      <span className="kd-folder-purpose" title={purpose.label} aria-label={purpose.label}>
        <FolderDown size={size} />
      </span>
    );
  }
  return (
    root ? <HardDrive size={size} /> : open ? <FolderOpen size={size} /> : <Folder size={size} />
  );
}

/** 所有“添加音乐”入口共用同一个动作：选目录后登记、扫描；是否自动分析由全局开关决定。 */
export async function pickAndScanFolders(): Promise<void> {
  const paths = await window.kdj?.pickFolders();
  if (!paths?.length) return;
  const autoAnalyze = useAppStore.getState().settings?.auto_analyze ?? true;
  await useLibraryStore.getState().startScan(paths, autoAnalyze);
  // 安卓兜底：服务端 found 恒为 0（数量走 scan.progress 事件），这里只能靠
  // 权限状态区分「没权限」和「真没歌」。正常路径上插件交还目录前已验证过
  // 可读性，这条兜的是权限在系统设置里被收回这类非常规情况。
  if (
    window.kdj?.mediaPermissionGranted &&
    !(await window.kdj.mediaPermissionGranted())
  ) {
    throw new Error(
      "没有在手机存储里找到音乐。KDJ 需要「媒体和照片」权限才能读取公共 Music 目录——请到 系统设置 → 应用 → KDJ → 权限 里允许后，再点一次添加。",
    );
  }
}

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
  const folders = useLibraryStore((state) => state.folders);
  const filter = useLibraryStore((state) => state.filter);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const settings = useAppStore((state) => state.settings);
  const applyFolderOp = useLibraryStore((state) => state.applyFolderOp);
  const streamPlaylists = useStreamBrowseStore((state) => state.playlists);
  const streamLoading = useStreamBrowseStore((state) => state.loading);
  const streamErrors = useStreamBrowseStore((state) => state.errors);
  const streamSectionExpanded = useStreamBrowseStore((state) => state.sectionExpanded);
  const streamRecentlyOpened = useStreamBrowseStore((state) => state.recentlyOpened);
  const cachedActiveStreamPlaylist = useStreamBrowseStore((state) => state.active);
  const loadStreamPlaylists = useStreamBrowseStore((state) => state.loadPlaylists);
  const setStreamSectionExpanded = useStreamBrowseStore(
    (state) => state.setSectionExpanded,
  );
  const setActiveStreamPlaylist = useStreamBrowseStore((state) => state.setActive);
  const setStreamError = useStreamBrowseStore((state) => state.setError);
  const { accounts, accountsError } = useStreamBrowseLifecycle(!expanded);
  const [error, setError] = useState("");
  const [narrowDrop, setNarrowDrop] = useState("");
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
    const storedSource = readNarrowRailSource();
    if (storedSource) return storedSource;
    if (effectiveActiveStreamPlaylist) {
      return { kind: "stream", platform: effectiveActiveStreamPlaylist.platform };
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
    if (!isPlatformEnabled(settings, effectiveActiveStreamPlaylist.platform)) return;
    setNarrowSource((current) =>
      current.kind === "stream" &&
      current.platform === effectiveActiveStreamPlaylist.platform
        ? current
        : { kind: "stream", platform: effectiveActiveStreamPlaylist.platform },
    );
  }, [effectiveActiveStreamKey, effectiveActiveStreamPlaylist, settings]);

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
    if (isPlatformEnabled(settings, narrowSource.platform)) return;
    const fallback = roots[0];
    setNarrowSource(
      fallback ? { kind: "local", rootPath: fallback.path } : { kind: "local", rootPath: "" },
    );
  }, [narrowSource, roots, settings]);

  const enabledStreamRoots = useMemo(
    () => STREAM_ROOTS.filter((streamRoot) => isPlatformEnabled(settings, streamRoot.id)),
    [settings],
  );

  useEffect(() => {
    const clearDrop = () => setNarrowDrop("");
    window.addEventListener("dragend", clearDrop, true);
    return () => window.removeEventListener("dragend", clearDrop, true);
  }, []);

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
    setActiveStreamPlaylist(null);
    setFilter({ folder, folderDeep: false });
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
        onClick={() => {
          if (sourceRoot) {
            // 收起态的根目录和 NetEase / Q Music 一样只负责切换下方目录。
            // 真正打开内容留给下方具体文件夹，避免根目录没有直属曲目时
            // 把中间列表意外清成“这个文件夹是空的”。
            setNarrowSource({ kind: "local", rootPath: node.path });
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
        <span className="kd-narrow-folder-icons">
          <FolderGlyph
            path={node.path}
            audioDir={settings?.download_dir}
            videoDir={settings?.download_dir}
            root={node.is_root}
            open={sourceRoot}
            size={14}
          />
        </span>
        <small>{node.name}</small>
      </button>
    );
  };

  const renderStreamChildren = (platform: StreamBrowsePlatform) => {
    const account = accounts.find((candidate) => candidate.platform === platform);
    const accountState = account?.state;
    const canBrowse = accountCanBrowse(accountState);
    const playlists = streamPlaylists[platform];
    const orderedPlaylists = orderStreamPlaylistsByRecent(
      playlists ?? [],
      streamRecentlyOpened[platform],
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
            {accountsError ? (
              <AlertTriangle size={14} />
            ) : (
              <LoaderCircle className="kd-spin" size={14} />
            )}
            <small>{accountsError ? "重试账号" : "读取账号"}</small>
          </button>
        )}
        {(accountState === "missing" || accountState === "expired") && (
          <button
            type="button"
            title="打开设置登录账号"
            onClick={() => useAppStore.getState().openSettingsPanel()}
          >
            <LogIn size={14} />
            <small>{accountState === "expired" ? "重新登录" : "登录"}</small>
          </button>
        )}
        {canBrowse && loading && playlists === null && (
          <button type="button" disabled aria-label="正在读取歌单">
            <LoaderCircle className="kd-spin" size={14} />
            <small>读取歌单</small>
          </button>
        )}
        {canBrowse && platformError && (
          <button
            type="button"
            title={platformError}
            disabled={loading}
            onClick={() => void loadStreamPlaylists(platform, true)}
          >
            <AlertTriangle size={14} />
            <small>重试</small>
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
                <Heart size={14} />
                <small>{playlist.title}</small>
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
                  onClick={() =>
                    setStreamSectionExpanded(platform, section.id, !sectionOpen)
                  }
                >
                  {sectionOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <small>{section.label}</small>
                </button>
                {sectionOpen &&
                  section.playlists.map((playlist) => {
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
                        <ListMusic size={14} />
                        <small>{playlist.title}</small>
                      </button>
                    );
                  })}
              </div>
            );
          })}
      </>
    );
  };

  return (
    <aside className="kd-narrow-folder-rail" aria-label="快捷文件夹栏">
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
        <FolderPlus size={15} /><small>添加音乐</small>
      </button>
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
        <Library size={15} /><small>全部曲目</small>
      </button>
      </div>
      <span className="kd-narrow-rail-sep" />
      <div className="kd-narrow-source-roots kd-scroll" aria-label="媒体来源">
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
            title={`在下方显示 ${streamRoot.label} 收藏和歌单`}
            onClick={() => {
              setNarrowSource({ kind: "stream", platform: streamRoot.id });
              const account = accounts.find(
                (candidate) => candidate.platform === streamRoot.id,
              );
              if (accountCanBrowse(account?.state)) {
                void loadStreamPlaylists(streamRoot.id);
              }
            }}
          >
            <PlatformMark id={streamRoot.id} size={15} />
            <small>{streamRoot.label}</small>
          </button>
        ))}
      </div>
      <span className="kd-narrow-rail-sep" />
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
            <Files size={15} /><small>其他</small>
          </button>
        )}
        {narrowSource.kind === "stream" &&
          renderStreamChildren(narrowSource.platform)}
      </div>
    </aside>
  );
}

interface MenuState {
  node: FolderNode;
  x: number;
  y: number;
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
  const saveSettings = useAppStore((state) => state.saveSettings);
  const streamPlaylists = useStreamBrowseStore((state) => state.playlists);
  const streamLoading = useStreamBrowseStore((state) => state.loading);
  const streamErrors = useStreamBrowseStore((state) => state.errors);
  const streamExpanded = useStreamBrowseStore((state) => state.expanded);
  const streamSectionExpanded = useStreamBrowseStore((state) => state.sectionExpanded);
  const streamRecentlyOpened = useStreamBrowseStore((state) => state.recentlyOpened);
  const cachedActiveStreamPlaylist = useStreamBrowseStore((state) => state.active);
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
    () => STREAM_ROOTS.filter((streamRoot) => isPlatformEnabled(settings, streamRoot.id)),
    [settings],
  );
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
  const [allMenu, setAllMenu] = useState<{ x: number; y: number } | null>(null);
  /** 整库重扫会遍历所有根：第一次点只在原右键面板里上膛，第二次才启动。 */
  const [rescanArmed, setRescanArmed] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const folderSelectionAnchor = useRef("");
  const [newFolder, setNewFolder] = useState<{ parent: string; name: string; saving: boolean } | null>(null);
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
  useEffect(() => {
    if (useLibraryStore.getState().folders === null) void refreshFolders();
  }, [refreshFolders]);

  // 扫描结束（scan.progress 到 done → refreshFolders）后清掉"导入中"标记
  useEffect(() => {
    setImporting((current) => {
      if (!current) return current;
      const stale = folders?.roots.some((root) => hasPending(root, current)) ?? false;
      return stale ? current : "";
    });
  }, [folders]);

  // 换节点时清掉「移出」上膛态（关闭由 ContextMenu 自己处理）
  useEffect(() => {
    setForgetArmed("");
  }, [menu?.node.path]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

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
          folder_deep: includeSubfolders ? 1 : 0,
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

  const toggleStreamRoot = (
    platform: StreamBrowsePlatform,
    accountState: AccountState | undefined,
  ) => {
    const opening = !streamExpanded[platform];
    setStreamExpanded(platform, opening);
    if (opening && accountCanBrowse(accountState)) {
      void loadStreamPlaylists(platform);
    }
  };

  const refreshStreamRoot = (platform: StreamBrowsePlatform) => {
    void loadStreamPlaylists(platform, true);
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

  const renderStreamRoot = (streamRoot: (typeof STREAM_ROOTS)[number]) => {
    const platform = streamRoot.id;
    const open = streamExpanded[platform];
    const playlists = streamPlaylists[platform];
    const orderedPlaylists = orderStreamPlaylistsByRecent(
      playlists ?? [],
      streamRecentlyOpened[platform],
    );
    const loading = streamLoading[platform];
    const error = streamErrors[platform];
    const accountState = accounts.find((account) => account.platform === platform)?.state;
    const canBrowse = accountCanBrowse(accountState);
    // 平台的默认收藏直接作为可点击项展示；不再套一层只有一个子项的目录。
    const favoritePlaylists = orderedPlaylists.filter(
      (playlist) => playlist.is_favorite || playlist.origin === "favorite",
    );
    const sections = streamPlaylistSections(orderedPlaylists, platform);
    const count = playlists?.length;
    const rootHint = !accountState
      ? accountsError || "正在读取账号状态"
      : accountState === "missing"
        ? `登录${streamRoot.label}后查看收藏和歌单`
        : accountState === "expired"
          ? `${streamRoot.label}登录已失效`
          : error || `${streamRoot.label}远程收藏和歌单`;

    return (
      <div key={`stream-root:${platform}`} className="kd-stream-root">
        <div
          className="kd-folder kd-folder-stream-root"
          data-sidebar-root-row=""
          data-stream-platform={platform}
          {...midiBrowseItemProps("search", `search:root:${platform}`)}
          style={{ paddingLeft: "0.35rem" }}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          title={`${rootHint} · 拖动调整侧栏顺序`}
          onPointerDown={(event) =>
            beginRootPointerReorder(event, `stream:${platform}`)
          }
          onClick={() => {
            if (isMidiBrowseActivate() && streamExpanded[platform]) return;
            toggleStreamRoot(platform, accountState);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleStreamRoot(platform, accountState);
          }}
        >
          <span className="kd-folder-caret">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <PlatformMark id={platform} size={13} />
          <span className="kd-truncate">{streamRoot.label}</span>
          <span className="kd-folder-count">
            {loading && count === undefined
              ? "…"
              : count !== undefined && count > 0
                ? count
                : !canBrowse && accountState
                  ? "登录"
                  : ""}
          </span>
          {canBrowse && (
            <button
              type="button"
              className="kd-folder-more kd-stream-refresh"
              disabled={loading}
              aria-label={`刷新${streamRoot.label}歌单`}
              title={`刷新${streamRoot.label}歌单`}
              onClick={(event) => {
                event.stopPropagation();
                refreshStreamRoot(platform);
              }}
            >
              {loading ? (
                <LoaderCircle className="kd-spin" size={12} />
              ) : (
                <RefreshCw size={12} />
              )}
            </button>
          )}
        </div>

        {open && !accountState && (
          <button
            type="button"
            className="kd-folder kd-folder-action kd-stream-status"
            title={accountsError || "正在读取账号状态"}
            disabled={!accountsError}
            onClick={() => void useAppStore.getState().refreshAccounts()}
          >
            <span className="kd-folder-caret" />
            {accountsError ? (
              <AlertTriangle size={12} />
            ) : (
              <LoaderCircle className="kd-spin" size={12} />
            )}
            <span className="kd-truncate">
              {accountsError ? "账号状态读取失败，点此重试" : "正在读取账号状态"}
            </span>
          </button>
        )}

        {open && (accountState === "missing" || accountState === "expired") && (
          <button
            type="button"
            className="kd-folder kd-folder-action kd-stream-status"
            title={
              accountState === "expired"
                ? "登录已失效，打开账号设置重新登录"
                : `打开账号设置登录${streamRoot.label}`
            }
            onClick={() => useAppStore.getState().openSettingsPanel()}
          >
            <span className="kd-folder-caret" />
            <LogIn size={12} />
            <span className="kd-truncate">
              {accountState === "expired" ? "登录已失效，重新登录" : "登录后查看歌单"}
            </span>
          </button>
        )}

        {open && canBrowse && loading && playlists === null && (
          <div className="kd-folder kd-stream-status" aria-live="polite">
            <span className="kd-folder-caret" />
            <LoaderCircle className="kd-spin" size={12} />
            <span className="kd-truncate">正在读取歌单</span>
          </div>
        )}

        {open && canBrowse && error && (
          <div className="kd-folder kd-stream-status kd-stream-error" title={error}>
            <span className="kd-folder-caret" />
            <AlertTriangle size={12} />
            <span className="kd-truncate">{error}</span>
            <button
              type="button"
              className="kd-stream-inline-action"
              disabled={loading}
              onClick={() => refreshStreamRoot(platform)}
            >
              重试
            </button>
          </div>
        )}

        {open &&
          canBrowse &&
          favoritePlaylists.map((playlist) => {
            const active =
              effectiveActiveStreamPlaylist?.platform === platform &&
              effectiveActiveStreamPlaylist.key === playlist.key;
            return (
              <button
                key={`stream-playlist:${platform}:${playlist.key}`}
                type="button"
                className="kd-folder kd-folder-action kd-folder-stream-playlist kd-folder-stream-playlist-direct"
                data-active={active || undefined}
                data-stream-platform={platform}
                {...midiBrowseItemProps("search", `search:playlist:${platform}:${playlist.key}`)}
                title={`${playlist.title} · ${streamPlaylistCountLabel(playlist)}`}
                onClick={() => openStreamPlaylist(platform, playlist)}
              >
                <span className="kd-folder-caret" />
                <Heart size={12} />
                <span className="kd-truncate">{playlist.title}</span>
                <span className="kd-folder-count">{playlist.count}</span>
              </button>
            );
          })}

        {open &&
          canBrowse &&
          sections.map((section) => {
            const sectionOpen = streamSectionExpanded[platform][section.id];
            return (
              <div key={`stream-section:${platform}:${section.id}`} className="kd-stream-section">
                <button
                  type="button"
                  className="kd-folder kd-folder-action kd-stream-section-label"
                  aria-expanded={sectionOpen}
                  title={`${sectionOpen ? "收起" : "展开"}${section.label}`}
                  onClick={() =>
                    setStreamSectionExpanded(platform, section.id, !sectionOpen)
                  }
                >
                  <span className="kd-folder-caret">
                    {sectionOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  </span>
                  {sectionOpen ? <FolderOpen size={12} /> : <Folder size={12} />}
                  <span className="kd-truncate">{section.label}</span>
                  <span className="kd-folder-count">{section.playlists.length}</span>
                </button>
                {sectionOpen &&
                  section.playlists.map((playlist) => {
                    const favorite =
                      playlist.is_favorite || playlist.origin === "favorite";
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
                        title={`${playlist.title} · ${streamPlaylistCountLabel(playlist)}`}
                        onClick={() => openStreamPlaylist(platform, playlist)}
                      >
                        <span className="kd-folder-caret" />
                        {favorite ? <Heart size={12} /> : <ListMusic size={12} />}
                        <span className="kd-truncate">{playlist.title}</span>
                        <span className="kd-folder-count">{playlist.count}</span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
      </div>
    );
  };

  const render = (node: FolderNode, depth: number) => {
    const open = expanded.has(node.path);
    const active = filter.folder === node.path;
    return (
      <div key={node.path}>
        <div
          className="kd-folder"
          data-sidebar-root-row={depth === 0 ? "" : undefined}
          {...{ [FOLDER_DROP_PATH_ATTR]: node.path }}
          {...midiBrowseItemProps("local", `local:folder:${node.path}`)}
          data-active={active}
          data-selected={selectedFolders.has(node.path) || undefined}
          data-drop={dropTarget === node.path && dropEdge === ""}
          data-edge={dropTarget === node.path ? dropEdge || undefined : undefined}
          style={{ paddingLeft: `${0.35 + depth * 0.85}rem` }}
          title={depth === 0 ? `${node.path} · 拖动调整侧栏顺序` : node.path}
          onPointerDown={
            depth === 0
              ? (event) => beginRootPointerReorder(event, `local:${node.path}`)
              : undefined
          }
          onClick={(event) => {
            if (hasTextSelectionWithin(event.currentTarget)) return;
            if (selectFolderRow(event, node)) return;
            // 进文件夹默认按手排顺序看（set 是按演出顺序排的）；
            // 回到全库时手排没有意义，还原成默认的文件创建顺序。
            setFilter(
              active && !isMidiBrowseActivate()
                ? { folder: "", sort: "file_created_at", order: "desc" }
                : { folder: node.path, sort: "custom" },
            );
            if (!active) importPending(node);
            onNavigate?.();
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
                    .then(() => {
                      // 树上文件夹换了位置就是回执本身，不再弹窗
                      // 当前筛选指向的旧路径没了，跟着走到新位置
                      if (filter.folder === from) setFilter({ folder: `${node.path}/${info.name}` });
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
                    .then(() => {
                      if (filter.folder === from) setFilter({ folder: `${node.parent}/${info.name}` });
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
            disabled={node.children.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              setAllMenu(null);
              toggle(node.path);
            }}
          >
            {node.children.length > 0 ? (
              open ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )
            ) : null}
          </button>
          <span
            className="kd-folder-drag"
            draggable={!node.is_root}
            title={node.is_root ? "拖动调整侧栏顺序" : "拖动文件夹图标移动或排序"}
            onDragStart={(event) => {
              if (node.is_root) return;
              event.stopPropagation();
              clearTextSelection();
              event.dataTransfer.setData(
                FOLDER_DND_TYPE,
                JSON.stringify({ parent: node.parent, name: node.name } satisfies DragInfo),
              );
              event.dataTransfer.effectAllowed = "move";
            }}
          >
            <FolderGlyph
              path={node.path}
              audioDir={settings?.download_dir}
              videoDir={settings?.download_dir}
              root={node.is_root}
              open={open && node.children.length > 0}
              size={13}
            />
          </span>
          <span className="kd-truncate">{node.name}</span>
          {/* 未入库的用不同的样子标出来，点一下就导入——空文件夹和"没扫过"是两回事 */}
          {node.pending_count > 0 ? (
            <span
              className="kd-folder-count"
              data-pending="true"
              title={`${node.pending_count} 个文件还没进曲库，点一下这个文件夹就导入`}
            >
              {importing === node.path ? "…" : `+${node.pending_count}`}
            </span>
          ) : (
            node.total_count > 0 && <span className="kd-folder-count">{node.total_count}</span>
          )}
          <button
            type="button"
            className="kd-folder-more"
            aria-label="文件夹操作"
            onClick={(event) => {
              event.stopPropagation();
              setAllMenu(null);
              if (!selectedFolders.has(node.path)) {
                setSelectedFolders(new Set([node.path]));
                folderSelectionAnchor.current = node.path;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ node, x: rect.left, y: rect.bottom + 2 });
            }}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
        {newFolder?.parent === node.path && (
          <div
            className="kd-folder kd-folder-new"
            style={{ paddingLeft: `${0.35 + (depth + 1) * 0.85}rem` }}
          >
            <span className="kd-folder-caret" />
            <Folder size={13} />
            <input
              autoFocus
              aria-label="新文件夹名称"
              value={newFolder.name}
              disabled={newFolder.saving}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setNewFolder({ ...newFolder, name: event.target.value })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commitNewFolder();
                if (event.key === "Escape") setNewFolder(null);
              }}
            />
          </div>
        )}
        {open && node.children.map((child) => render(child, depth + 1))}
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
      data-drop={dropTarget === ALL_TRACKS_DROP_TARGET ? "true" : undefined}
      style={{ paddingLeft: "0.35rem" }}
      title="拖动调整侧栏顺序；拖入下载会落到默认下载文件夹"
      onPointerDown={(event) => beginRootPointerReorder(event, ALL_TRACKS_ROOT_ID)}
      onClick={() => {
        setSelectedFolders(new Set());
        setFilter({ folder: "", sort: "file_created_at", order: "desc" });
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
      <Library size={13} />
      <span className="kd-truncate">全部曲目</span>
      <span className="kd-folder-count">{allTrackCount}</span>
      <button
        type="button"
        className="kd-folder-more"
        aria-label="全部曲目操作"
        onClick={(event) => {
          event.stopPropagation();
          setMenu(null);
          setSelectedFolders(new Set());
          setRescanArmed(false);
          const rect = event.currentTarget.getBoundingClientRect();
          setAllMenu({ x: rect.left, y: rect.bottom + 2 });
        }}
      >
        <MoreHorizontal size={12} />
      </button>
    </div>
  );

  const renderOutsideRoot = () => (
    <div
      className="kd-folder"
      data-sidebar-root-row=""
      data-active={isOutsideFolder(filter.folder)}
      {...midiBrowseItemProps("local", "local:outside")}
      style={{ paddingLeft: "0.35rem" }}
      title="不在曲库目录里的曲目 · 拖动调整侧栏顺序"
      onPointerDown={(event) => beginRootPointerReorder(event, OUTSIDE_ROOT_ID)}
      onClick={() => {
        setFilter({ folder: OUTSIDE_FOLDER, sort: "file_created_at", order: "desc" });
        onNavigate?.();
      }}
    >
      <span className="kd-folder-caret" />
      <Files size={13} />
      <span className="kd-truncate">其他</span>
      <span className="kd-folder-count">{folders!.outside}</span>
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
        {/* 添加是固定入口；其余根项都在下面按用户保存的顺序渲染。 */}
        <button
          type="button"
          className="kd-folder kd-folder-action"
          disabled={scanning}
          title="选磁盘上的文件夹加进曲库，导入和分析都在后台自动做完"
          onClick={() => void addFolders()}
        >
          <span className="kd-folder-caret" />
          <FolderInput size={13} />
          <span className="kd-truncate">添加</span>
        </button>
        {orderedRootItems.map((item) => (
          <div
            key={item.id}
            className="kd-sidebar-root-slot"
            data-sidebar-root-id={item.id}
            data-root-dragging={rootDragging === item.id ? "true" : undefined}
            data-root-edge={rootDrop?.id === item.id ? rootDrop.edge : undefined}
          >
            {renderSidebarRoot(item)}
          </div>
        ))}
        {roots.length === 0 && (
          <p className="kd-faint" style={{ padding: "0.6rem 0.5rem", lineHeight: 1.5 }}>
            还没有文件夹。点上方的「添加」选一个本地目录，剩下的交给后台。
          </p>
        )}
      </div>

      {/* 文件夹操作出错时，消息必须留在被操作的树旁边。 */}
      <InlineNotice
        className="kd-folder-notice"
        block
        text={notice}
        onDismiss={() => setNotice("")}
      />

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
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
              const name = prompt("重命名文件夹", menu.node.name);
              if (!name || name === menu.node.name) return;
              void api
                .renameFolder(menu.node.path, name)
                .then(() => {
                  // 改名后当前筛选指向的旧路径已经不存在了，跟着切到新路径
                  if (filter.folder === menu.node.path) {
                    const parent = menu.node.path.slice(0, menu.node.path.lastIndexOf("/"));
                    setFilter({ folder: `${parent}/${name}` });
                  }
                  return refreshFolders();
                })
                .catch((error: unknown) => setNotice((error as Error).message));
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
                ? "停止扫描；已经完成入库的曲目会保留"
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
