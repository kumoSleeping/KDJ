import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  HardDrive,
  ListMusic,
  LoaderCircle,
  MoreHorizontal,
  PencilLine,
  Plus,
  RefreshCw,
  Trash2,
  Usb,
} from "lucide-react";
import {
  PLAYLIST_DROP_DEVICE_ATTR,
  PLAYLIST_DROP_ID_ATTR,
} from "../../lib/folderDrop";
import { finishTrackDrop, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import { enqueueSearchOneLibraryDrop, isSearchDownloadDrag } from "../../lib/searchDrag";
import { clearTextSelection } from "../../lib/textSelection";
import { oneLibraryTreeDropPosition } from "../../lib/oneLibraryTree";
import {
  readSidebarTreeState,
  writeOneLibraryTreeState,
} from "../../lib/sidebarState";
import { isMidiBrowseActivate, midiBrowseItemProps } from "../../lib/midiLibraryNav";
import { usePlaylistStore } from "../../stores/playlistStore";
import { useAppStore } from "../../stores/appStore";
import type { OneLibraryPlaylist, RemovableDevice } from "../../types";
import { ContextMenu } from "../common";
const LABS_BUILD = typeof __KDJ_LABS__ !== "undefined" && __KDJ_LABS__;

const PLAYLIST_TREE_DND = "application/x-kdj-onelibrary-playlist";

interface NodeMenu {
  kind: "node";
  device: RemovableDevice;
  playlist: OneLibraryPlaylist;
  x: number;
  y: number;
}

interface CreateMenu {
  kind: "create";
  device: RemovableDevice;
  parentId: number;
  x: number;
  y: number;
}

type MenuState = NodeMenu | CreateMenu;

interface EditingState {
  devicePath: string;
  playlistId: number;
  original: string;
  value: string;
}

interface DraggedNode {
  devicePath: string;
  id: number;
  parentId: number;
  sequence: number;
}

interface DropState {
  devicePath: string;
  id: number;
  edge: "before" | "after" | "inside";
}

interface OneLibraryTreeUiState {
  open: boolean;
  openDevices: Set<string>;
  openFolders: Set<string>;
  knownDevices: Set<string>;
}

function nodeKey(devicePath: string, id: number) {
  return `${devicePath}\u0000${id}`;
}

function deviceHint(device: RemovableDevice): string {
  const status = device.read_only
    ? "只读"
    : !device.one_library_file_system
      ? `不支持 OneLibrary（${device.file_system || "未知格式"}）`
      : device.has_one_library
        ? "已连接 OneLibrary"
        : "可建立 OneLibrary";
  return `${device.path} · ${status}`;
}

export function PlaylistSection({
  onNavigate,
  onNotice,
}: {
  onNavigate?: (kind?: "onelibrary") => void;
  onNotice(message: string): void;
}) {
  const devices = usePlaylistStore((state) => state.devices);
  const playlistsByDevice = usePlaylistStore((state) => state.playlistsByDevice);
  const virtualDisk = usePlaylistStore((state) => state.virtualDisk);
  const devicesLoading = usePlaylistStore((state) => state.devicesLoading);
  const exporting = usePlaylistStore((state) => state.exporting);
  const refreshDevices = usePlaylistStore((state) => state.refreshDevices);
  const createPlaylist = usePlaylistStore((state) => state.createPlaylist);
  const renamePlaylist = usePlaylistStore((state) => state.renamePlaylist);
  const movePlaylist = usePlaylistStore((state) => state.movePlaylist);
  const deletePlaylist = usePlaylistStore((state) => state.deletePlaylist);
  const addTracks = usePlaylistStore((state) => state.addTracks);
  const openPlaylist = usePlaylistStore((state) => state.openPlaylist);
  const selectedTarget = usePlaylistStore((state) => state.selectedTarget);
  const openVirtualDiskPanel = useAppStore((state) => state.openVirtualDiskPanel);
  const configuredOneLibrary = useAppStore(
    (state) => state.settings?.experimental_one_library ?? false,
  );
  const experimentalOneLibrary = LABS_BUILD && configuredOneLibrary;
  const [treeUi, setTreeUi] = useState<OneLibraryTreeUiState>(() => {
    const restored = readSidebarTreeState().oneLibrary;
    return {
      open: restored.open,
      openDevices: new Set(restored.openDevices),
      openFolders: new Set(restored.openFolders),
      knownDevices: new Set(restored.knownDevices),
    };
  });
  const { open, openDevices, openFolders } = treeUi;
  const updateTreeUi = (update: (current: OneLibraryTreeUiState) => OneLibraryTreeUiState) => {
    setTreeUi((current) => {
      const next = update(current);
      writeOneLibraryTreeState({
        open: next.open,
        openDevices: [...next.openDevices],
        openFolders: [...next.openFolders],
        knownDevices: [...next.knownDevices],
      });
      return next;
    });
  };
  const setOpen = (update: (current: boolean) => boolean) =>
    updateTreeUi((current) => ({ ...current, open: update(current.open) }));
  const setOpenDevices = (update: (current: Set<string>) => Set<string>) =>
    updateTreeUi((current) => ({ ...current, openDevices: update(current.openDevices) }));
  const setOpenFolders = (update: (current: Set<string>) => Set<string>) =>
    updateTreeUi((current) => ({ ...current, openFolders: update(current.openFolders) }));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [creating, setCreating] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dragged, setDragged] = useState<DraggedNode | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [deviceDrop, setDeviceDrop] = useState("");

  useEffect(() => setDeleteArmed(false), [menu]);
  useEffect(() => {
    updateTreeUi((current) => {
      const openDevices = new Set(current.openDevices);
      const knownDevices = new Set(current.knownDevices);
      for (const device of devices) {
        // 只自动展开第一次见到的可用设备；用户明确收起过的设备重启后保持收起。
        if (
          !knownDevices.has(device.path) &&
          (device.is_virtual || device.has_one_library)
        ) {
          openDevices.add(device.path);
        }
        knownDevices.add(device.path);
      }
      return { ...current, openDevices, knownDevices };
    });
    // updateTreeUi 只包装稳定的 React setter；设备列表才是这段校准的输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices]);

  const physicalDevices = useMemo(
    () => devices.filter((device) => !device.is_virtual),
    [devices],
  );
  const kdjDevice = devices.find((device) => device.is_virtual) ?? null;

  const startCreate = (device: RemovableDevice, parentId: number, folder: boolean) => {
    if (device.read_only || !device.one_library_file_system || creating) return;
    const initial = folder ? "新建列表文件夹" : "新建播放列表";
    const key = `${device.path}\u0000${parentId}\u0000${folder ? "folder" : "list"}`;
    setCreating(key);
    onNotice("");
    void createPlaylist(device.path, initial, parentId, folder)
      .then((playlist) => {
        setOpenDevices((current) => new Set(current).add(device.path));
        if (parentId !== 0) {
          setOpenFolders((current) => new Set(current).add(nodeKey(device.path, parentId)));
        }
        setEditing({
          devicePath: device.path,
          playlistId: playlist.id,
          original: playlist.name,
          value: playlist.name,
        });
      })
      .catch((error: unknown) => onNotice(`新建失败：${(error as Error).message}`))
      .finally(() => setCreating(""));
  };

  const finishEditing = () => {
    if (!editing) return;
    const current = editing;
    setEditing(null);
    const name = current.value.trim();
    if (!name || name === current.original) return;
    onNotice("");
    void renamePlaylist(current.devicePath, current.playlistId, name).catch(
      (error: unknown) => onNotice(`重命名失败：${(error as Error).message}`),
    );
  };

  const addLocalTracks = (
    device: RemovableDevice,
    playlist: OneLibraryPlaylist,
    ids: number[],
  ) => {
    if (ids.length === 0 || playlist.attribute !== 0 || device.read_only) return;
    onNotice("");
    void addTracks(device.path, playlist.id, ids)
      .then((result) => {
        if (result.skipped_tracks > 0) {
          onNotice(`有 ${result.skipped_tracks} 首未写入；请检查格式、文件是否存在和剩余空间`);
        }
      })
      .catch((error: unknown) => onNotice(`OneLibrary 写入失败：${(error as Error).message}`));
  };

  const renderDevice = (device: RemovableDevice, virtual = false) => {
    const expanded = openDevices.has(device.path);
    const playlists = playlistsByDevice[device.path] ?? [];
    const disabled = device.read_only || !device.one_library_file_system;
    const children = new Map<number, OneLibraryPlaylist[]>();
    for (const playlist of playlists) {
      const group = children.get(playlist.parent_id) ?? [];
      group.push(playlist);
      children.set(playlist.parent_id, group);
    }
    for (const group of children.values()) {
      group.sort((left, right) => left.seq - right.seq || left.id - right.id);
    }
    const toggleDevice = () =>
      setOpenDevices((current) => {
        const next = new Set(current);
        if (next.has(device.path)) next.delete(device.path);
        else next.add(device.path);
        return next;
      });

    const renderNode = (playlist: OneLibraryPlaylist, depth: number): React.ReactNode => {
      const key = nodeKey(device.path, playlist.id);
      const isFolder = playlist.attribute === 1;
      const isWritableList = playlist.attribute === 0;
      const folderOpen = isFolder && openFolders.has(key);
      const target = {
        device_path: device.path,
        device_name: device.name,
        is_virtual: device.is_virtual,
        playlist_id: playlist.id,
        playlist_name: playlist.name,
      };
      const active =
        selectedTarget?.device_path === device.path &&
        selectedTarget.playlist_id === playlist.id;
      const currentDrop = drop?.devicePath === device.path && drop.id === playlist.id;
      return (
        <div key={key}>
          <div
            className="kd-folder kd-playlist-row kd-onelibrary-playlist"
            style={{ paddingLeft: `${2.05 + depth * 0.85}rem` }}
            {...(!disabled && isWritableList
              ? {
                  [PLAYLIST_DROP_ID_ATTR]: String(playlist.id),
                  [PLAYLIST_DROP_DEVICE_ATTR]: device.path,
                }
              : {})}
            data-disabled={disabled || playlist.attribute === 4 || undefined}
            data-active={active || undefined}
            {...midiBrowseItemProps("onelibrary", `onelibrary:${device.path}:${playlist.id}`)}
            data-drop={currentDrop && drop.edge === "inside" ? "true" : undefined}
            data-edge={
              currentDrop && drop.edge !== "inside" ? drop.edge : undefined
            }
            title={isFolder ? "列表文件夹" : playlist.attribute === 4 ? "智能列表" : undefined}
            onClick={() => {
              if (editing?.playlistId === playlist.id) return;
              if (isFolder) {
                if (isMidiBrowseActivate() && folderOpen) return;
                setOpenFolders((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
                return;
              }
              if (!isWritableList) return;
              useAppStore.getState().focusLibrary();
              onNavigate?.("onelibrary");
              void openPlaylist(target).catch((error: unknown) =>
                onNotice(`读取 OneLibrary 列表失败：${(error as Error).message}`),
              );
            }}
            onContextMenu={(event) => {
              if (disabled || playlist.attribute === 4) return;
              event.preventDefault();
              setMenu({ kind: "node", device, playlist, x: event.clientX, y: event.clientY });
            }}
            onDragOverCapture={(event) => {
              if (disabled) return;
              if (dragged?.devicePath === device.path && dragged.id !== playlist.id) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - rect.top) / rect.height;
                const edge = isFolder && ratio >= 0.3 && ratio <= 0.7
                  ? "inside"
                  : ratio < 0.5
                    ? "before"
                    : "after";
                setDrop({ devicePath: device.path, id: playlist.id, edge });
                return;
              }
              if (!isWritableList || (!isTrackDrag(event) && !isSearchDownloadDrag(event))) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => {
              setDrop((current) =>
                current?.devicePath === device.path && current.id === playlist.id ? null : current,
              );
            }}
            onDropCapture={(event) => {
              if (disabled) return;
              if (dragged?.devicePath === device.path && dragged.id !== playlist.id) {
                event.preventDefault();
                event.stopPropagation();
                const edge = drop?.devicePath === device.path && drop.id === playlist.id
                  ? drop.edge
                  : isFolder
                    ? "inside"
                    : "after";
                setDrop(null);
                const { parentId, sequence } = oneLibraryTreeDropPosition(
                  { parent_id: dragged.parentId, seq: dragged.sequence },
                  playlist,
                  edge,
                );
                onNotice("");
                void movePlaylist(device.path, dragged.id, parentId, sequence)
                  .then(() => {
                    if (edge === "inside") {
                      setOpenFolders((current) => new Set(current).add(key));
                    }
                  })
                  .catch((error: unknown) => onNotice(`移动列表失败：${(error as Error).message}`));
                return;
              }
              if (!isWritableList) return;
              if (isSearchDownloadDrag(event)) {
                event.preventDefault();
                event.stopPropagation();
                void enqueueSearchOneLibraryDrop(event, target).catch((error: unknown) =>
                  onNotice(`加入 OneLibrary 下载失败：${(error as Error).message}`),
                );
                return;
              }
              if (!isTrackDrag(event)) return;
              event.preventDefault();
              const ids = readTrackDragIds(event.dataTransfer);
              finishTrackDrop();
              addLocalTracks(device, playlist, ids);
            }}
          >
            <button
              type="button"
              className="kd-folder-caret"
              disabled={!isFolder}
              aria-label={folderOpen ? "收起" : "展开"}
              onClick={(event) => {
                if (!isFolder) return;
                event.stopPropagation();
                setOpenFolders((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              }}
            >
              {isFolder ? folderOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
            </button>
            <span
              className="kd-folder-drag kd-onelibrary-node-icon"
              draggable={!disabled && playlist.attribute !== 4}
              title={!disabled && playlist.attribute !== 4 ? "拖动调整列表位置" : undefined}
              onDragStart={(event) => {
                if (disabled || playlist.attribute === 4) return;
                event.stopPropagation();
                clearTextSelection();
                setDragged({
                  devicePath: device.path,
                  id: playlist.id,
                  parentId: playlist.parent_id,
                  sequence: playlist.seq,
                });
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  PLAYLIST_TREE_DND,
                  JSON.stringify({ devicePath: device.path, id: playlist.id }),
                );
              }}
              onDragEnd={() => {
                setDragged(null);
                setDrop(null);
              }}
            >
              {exporting === key ? (
                <LoaderCircle className="kd-spin" size={12} />
              ) : isFolder ? (
                folderOpen ? <FolderOpen size={12} /> : <Folder size={12} />
              ) : (
                <ListMusic size={12} />
              )}
            </span>
            {editing?.devicePath === device.path && editing.playlistId === playlist.id ? (
              <input
                className="kd-onelibrary-name-input kd-grow"
                value={editing.value}
                aria-label="OneLibrary 列表名称"
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) =>
                  setEditing((current) => current ? { ...current, value: event.target.value } : current)
                }
                onBlur={finishEditing}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span className="kd-truncate">{playlist.name}</span>
            )}
            {isWritableList && playlist.track_count > 0 ? (
              <span className="kd-folder-count">{playlist.track_count}</span>
            ) : null}
            {!disabled && playlist.attribute !== 4 ? (
              <button
                type="button"
                className="kd-folder-more"
                aria-label="OneLibrary 列表操作"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ kind: "node", device, playlist, x: rect.left, y: rect.bottom + 2 });
                }}
              >
                <MoreHorizontal size={12} />
              </button>
            ) : null}
          </div>
          {folderOpen && (children.get(playlist.id) ?? []).map((child) => renderNode(child, depth + 1))}
        </div>
      );
    };

    return (
      <div className="kd-onelibrary-device-group" key={device.path}>
        <div
          className="kd-folder kd-playlist-device"
          data-disabled={disabled || undefined}
          data-drop={deviceDrop === device.path || undefined}
          style={{ paddingLeft: "1.2rem" }}
          title={deviceHint(device)}
          onClick={toggleDevice}
          onDragOver={(event) => {
            if (disabled || dragged?.devicePath !== device.path) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDeviceDrop(device.path);
          }}
          onDragLeave={() => setDeviceDrop((current) => current === device.path ? "" : current)}
          onDrop={(event) => {
            if (disabled || dragged?.devicePath !== device.path) return;
            event.preventDefault();
            event.stopPropagation();
            setDeviceDrop("");
            onNotice("");
            void movePlaylist(device.path, dragged.id, 0, null).catch((error: unknown) =>
              onNotice(`移动列表失败：${(error as Error).message}`),
            );
          }}
        >
          <button
            type="button"
            className="kd-folder-caret"
            aria-label={expanded ? `收起 ${device.name}` : `展开 ${device.name}`}
            onClick={(event) => {
              event.stopPropagation();
              toggleDevice();
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {virtual ? <HardDrive size={13} /> : <Usb size={13} />}
          <span className="kd-truncate">{virtual ? "KDJ" : device.name}</span>
          {playlists.length > 0 ? <span className="kd-folder-count">{playlists.length}</span> : null}
          {!disabled ? (
            <button
              type="button"
              className="kd-folder-more"
              aria-label={`在 ${device.name} 新建 OneLibrary 节点`}
              title="新建播放列表或列表文件夹"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ kind: "create", device, parentId: 0, x: rect.left, y: rect.bottom + 2 });
              }}
            >
              <Plus size={12} />
            </button>
          ) : null}
          {virtual ? (
            <button
              type="button"
              className="kd-folder-more"
              aria-label="管理 KDJ 虚拟磁盘"
              onClick={(event) => {
                event.stopPropagation();
                openVirtualDiskPanel();
              }}
            >
              <MoreHorizontal size={12} />
            </button>
          ) : null}
        </div>
        {expanded && (children.get(0) ?? []).map((playlist) => renderNode(playlist, 0))}
      </div>
    );
  };

  if (!experimentalOneLibrary) return null;

  return (
    <>
      <div
        className="kd-folder kd-playlist-root"
        style={{ paddingLeft: "0.35rem" }}
        aria-expanded={open}
        onClick={openVirtualDiskPanel}
      >
        <button
          type="button"
          className="kd-folder-caret"
          aria-label={open ? "收起 OneLibrary" : "展开 OneLibrary"}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <ListMusic size={13} />
        <span className="kd-truncate">OneLibrary</span>
        {devices.length > 0 ? <span className="kd-folder-count">{devices.length}</span> : null}
        <button
          type="button"
          className="kd-folder-more kd-device-refresh"
          aria-label="刷新 OneLibrary 存储"
          title="刷新 OneLibrary 设备"
          onClick={(event) => {
            event.stopPropagation();
            void refreshDevices();
          }}
        >
          <RefreshCw className={devicesLoading ? "kd-spin" : undefined} size={12} />
        </button>
      </div>

      {open && virtualDisk?.supported && !kdjDevice ? (
        <div
          className="kd-folder kd-playlist-device"
          style={{ paddingLeft: "1.2rem" }}
          title={virtualDisk.imagePath}
          onClick={openVirtualDiskPanel}
        >
          <span className="kd-folder-caret" />
          <HardDrive size={13} />
          <span className="kd-truncate">KDJ</span>
          <button
            type="button"
            className="kd-folder-more"
            aria-label={virtualDisk.exists ? "加载 KDJ" : "创建 KDJ"}
          >
            <Plus size={12} />
          </button>
        </div>
      ) : null}
      {open && kdjDevice ? renderDevice(kdjDevice, true) : null}
      {open ? physicalDevices.map((device) => renderDevice(device)) : null}

      {menu?.kind === "create" ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            onClick={() => {
              const current = menu;
              setMenu(null);
              startCreate(current.device, current.parentId, false);
            }}
          >
            <ListMusic size={12} /> 新建播放列表
          </button>
          <button
            type="button"
            onClick={() => {
              const current = menu;
              setMenu(null);
              startCreate(current.device, current.parentId, true);
            }}
          >
            <Folder size={12} /> 新建列表文件夹
          </button>
        </ContextMenu>
      ) : null}

      {menu?.kind === "node" ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.playlist.attribute === 1 ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const current = menu;
                  setMenu(null);
                  startCreate(current.device, current.playlist.id, false);
                }}
              >
                <ListMusic size={12} /> 新建播放列表
              </button>
              <button
                type="button"
                onClick={() => {
                  const current = menu;
                  setMenu(null);
                  startCreate(current.device, current.playlist.id, true);
                }}
              >
                <Folder size={12} /> 新建列表文件夹
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const current = menu;
              setMenu(null);
              setEditing({
                devicePath: current.device.path,
                playlistId: current.playlist.id,
                original: current.playlist.name,
                value: current.playlist.name,
              });
            }}
          >
            <PencilLine size={12} /> 重命名
          </button>
          <button
            type="button"
            data-danger="true"
            onClick={() => {
              if (!deleteArmed) {
                setDeleteArmed(true);
                return;
              }
              const current = menu;
              setMenu(null);
              onNotice("");
              void deletePlaylist(current.device.path, current.playlist.id).catch(
                (error: unknown) => onNotice(`删除失败：${(error as Error).message}`),
              );
            }}
          >
            <Trash2 size={12} />
            {deleteArmed
              ? "再次点击确认删除"
              : menu.playlist.attribute === 1
                ? "删除列表文件夹"
                : "删除播放列表"}
          </button>
        </ContextMenu>
      ) : null}
    </>
  );
}
