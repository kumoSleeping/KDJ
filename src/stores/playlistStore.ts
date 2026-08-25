import { create } from "zustand";
import { api } from "../lib/api";
import { getBridge } from "../lib/bridge";
import {
  isOneLibraryTargetConnected,
  reconcileOneLibrarySelection,
} from "../lib/oneLibraryTrack";
import { useAppStore } from "./appStore";
import { useLibraryStore } from "./libraryStore";
import { removePendingVirtualDiskDownloads } from "../lib/oneLibraryDownloadPersistence";
import {
  readWorkspaceSession,
  setRestorableWorkspaceSource,
  updateOneLibraryWorkspaceSession,
} from "../lib/workspaceSession";
import type {
  OneLibraryPlaylist,
  OneLibraryTarget,
  OneLibraryTrack,
  PlaylistExportResult,
  RemovableDevice,
  VirtualDiskStatus,
} from "../types";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const playlistKey = (devicePath: string, playlistId: number) =>
  `${devicePath}\u0000${playlistId}`;
const SELECTED_TARGET_KEY = "kd-onelibrary-selected-target-v1";

function sameOneLibraryTracks(left: OneLibraryTrack[], right: OneLibraryTrack[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((track, index) => JSON.stringify(track) === JSON.stringify(right[index]));
}

function readSelectedTarget(): OneLibraryTarget | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SELECTED_TARGET_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const target = value as Partial<OneLibraryTarget>;
    if (
      typeof target.device_path === "string"
      && typeof target.device_name === "string"
      && typeof target.is_virtual === "boolean"
      && typeof target.playlist_id === "number"
      && typeof target.playlist_name === "string"
    ) return target as OneLibraryTarget;
  } catch {
    // 损坏存档只清掉最后打开的列表。
  }
  return null;
}

function writeSelectedTarget(target: OneLibraryTarget | null): void {
  try {
    if (target) localStorage.setItem(SELECTED_TARGET_KEY, JSON.stringify(target));
    else localStorage.removeItem(SELECTED_TARGET_KEY);
  } catch {
    // 存储不可用不影响当前会话。
  }
}

const RESTORED_ONE_LIBRARY_SESSION = readWorkspaceSession().oneLibrary;
const RESTORED_ONE_LIBRARY_TARGET =
  readSelectedTarget() ?? RESTORED_ONE_LIBRARY_SESSION.target;
const RESTORED_ONE_LIBRARY_FOCUS =
  RESTORED_ONE_LIBRARY_TARGET &&
  RESTORED_ONE_LIBRARY_SESSION.target?.device_path === RESTORED_ONE_LIBRARY_TARGET.device_path &&
  RESTORED_ONE_LIBRARY_SESSION.target.playlist_id === RESTORED_ONE_LIBRARY_TARGET.playlist_id
    ? RESTORED_ONE_LIBRARY_SESSION.focusedContentId
    : null;

export type OneLibrarySelectMode = "replace" | "toggle" | "range";

export interface PlaylistStore {
  devices: RemovableDevice[];
  playlistsByDevice: Record<string, OneLibraryPlaylist[]>;
  virtualDisk: VirtualDiskStatus | null;
  devicesLoading: boolean;
  operation: "mount" | "eject" | "grow" | "delete" | null;
  exporting: string | null;
  deviceError: string;
  lastExport: PlaylistExportResult | null;
  selectedTarget: OneLibraryTarget | null;
  selectedTracks: OneLibraryTrack[];
  /** 当前表格筛选/排序后可见的 id；null 表示列表组件尚未报告视图。 */
  visibleContentIds: number[] | null;
  selectedContentIds: number[];
  focusedContentId: number | null;
  selectionMode: boolean;
  tracksLoading: boolean;
  importing: boolean;

  refreshDevices(): Promise<void>;
  createPlaylist(
    devicePath: string,
    name: string,
    parentId?: number | null,
    folder?: boolean,
  ): Promise<OneLibraryPlaylist>;
  renamePlaylist(devicePath: string, id: number, name: string): Promise<void>;
  movePlaylist(devicePath: string, id: number, parentId: number, sequence?: number | null): Promise<void>;
  deletePlaylist(devicePath: string, id: number): Promise<void>;
  addTracks(devicePath: string, id: number, trackIds: number[]): Promise<PlaylistExportResult>;
  openPlaylist(target: OneLibraryTarget): Promise<void>;
  reorderTracks(contentIds: number[]): Promise<void>;
  rateTrack(contentId: number, rating: number): Promise<void>;
  copyTracks(
    source: OneLibraryTarget,
    targetDevicePath: string,
    targetPlaylistId: number,
    contentIds: number[],
  ): Promise<void>;
  importTracksToFolder(source: OneLibraryTarget, contentIds: number[], dest: string): Promise<number>;
  removeTracks(contentIds: number[]): Promise<void>;
  selectTrack(contentId: number | null, mode?: OneLibrarySelectMode): void;
  selectAllTracks(): void;
  setVisibleContentIds(contentIds: number[] | null): void;
  setSelectionMode(on: boolean): void;
  closePlaylist(): void;
  authorizeDevice(): Promise<RemovableDevice | null>;
  mountVirtualDisk(sizeGib?: number, volumeName?: string): Promise<VirtualDiskStatus>;
  growVirtualDisk(sizeGib: number, volumeName: string): Promise<VirtualDiskStatus>;
  ejectVirtualDisk(): Promise<VirtualDiskStatus>;
  deleteVirtualDisk(): Promise<VirtualDiskStatus>;
  clearError(): void;
  clearLastExport(): void;
}

async function readPlaylists(devices: RemovableDevice[]) {
  const entries = await Promise.all(
    devices
      .filter((device) => device.one_library_file_system)
      .map(async (device) => {
        try {
          return [device.path, await api.oneLibraryPlaylists(device.path)] as const;
        } catch {
          // 一个损坏/刚拔掉的卷不能挡住其它 OneLibrary 设备。
          return [device.path, []] as const;
        }
      }),
  );
  return Object.fromEntries(entries) as Record<string, OneLibraryPlaylist[]>;
}

export const usePlaylistStore = create<PlaylistStore>()((set, get) => ({
  devices: [],
  playlistsByDevice: {},
  virtualDisk: null,
  devicesLoading: false,
  operation: null,
  exporting: null,
  deviceError: "",
  lastExport: null,
  selectedTarget: RESTORED_ONE_LIBRARY_TARGET,
  selectedTracks: [],
  visibleContentIds: null,
  selectedContentIds: RESTORED_ONE_LIBRARY_FOCUS ? [RESTORED_ONE_LIBRARY_FOCUS] : [],
  focusedContentId: RESTORED_ONE_LIBRARY_FOCUS,
  selectionMode: false,
  tracksLoading: false,
  importing: false,

  async refreshDevices() {
    if (get().devicesLoading) return;
    set({ devicesLoading: true });
    try {
      const bridge = getBridge();
      // 状态命令会把由 KDJ 管理的 VHD/DMG 挂载点登记给进程内 server；必须先等它，
      // 否则用户在 Finder/资源管理器手动重新加载后，本轮设备枚举会慢一拍。
      const virtualDisk = await (bridge.virtualDisk?.status() ?? Promise.resolve(null));
      const devices = await api.removableDevices();
      const playlistsByDevice = await readPlaylists(devices);
      const selectedBeforeRefresh = get().selectedTarget;
      set((state) => {
        const selectedTarget = state.selectedTarget;
        const disconnected =
          selectedTarget !== null &&
          !isOneLibraryTargetConnected(selectedTarget, devices);
        return {
          devices,
          playlistsByDevice,
          virtualDisk,
          devicesLoading: true,
          deviceError: "",
          ...(disconnected
            ? {
                selectedTarget: null,
                selectedTracks: [],
                visibleContentIds: null,
                selectedContentIds: [],
                focusedContentId: null,
                selectionMode: false,
                tracksLoading: false,
              }
            : {}),
        };
      });
      const selected = get().selectedTarget;
      if (selectedBeforeRefresh && !selected) {
        writeSelectedTarget(null);
        updateOneLibraryWorkspaceSession({ target: null, focusedContentId: null, scrollTop: 0 });
        if (readWorkspaceSession().source === "onelibrary") {
          setRestorableWorkspaceSource("local");
        }
      } else if (selected) {
        const playlist = playlistsByDevice[selected.device_path]?.find(
          (candidate) => candidate.id === selected.playlist_id && candidate.attribute === 0,
        );
        if (!playlist) {
          writeSelectedTarget(null);
          get().closePlaylist();
        } else {
          const device = devices.find((candidate) => candidate.path === selected.device_path);
          const restored = {
            ...selected,
            device_name: device?.name || selected.device_name,
            playlist_name: playlist.name,
          };
          writeSelectedTarget(restored);
          updateOneLibraryWorkspaceSession({ target: restored });
          set((state) => ({
            selectedTarget: restored,
            tracksLoading: state.selectedTracks.length === 0,
          }));
          const tracks = await api.oneLibraryPlaylistTracks(
            restored.device_path,
            restored.playlist_id,
          );
          const currentTarget = get().selectedTarget;
          if (
            currentTarget?.device_path === restored.device_path
            && currentTarget.playlist_id === restored.playlist_id
          ) {
            set((state) => {
              const selection = reconcileOneLibrarySelection(
                tracks,
                state.selectedContentIds,
                state.focusedContentId,
              );
              return {
                selectedTracks: sameOneLibraryTracks(state.selectedTracks, tracks)
                  ? state.selectedTracks
                  : tracks,
                ...selection,
                tracksLoading: false,
                deviceError: "",
              };
            });
            updateOneLibraryWorkspaceSession({
              focusedContentId: get().focusedContentId,
            });
          }
        }
      }
      set({ devicesLoading: false });
      void import("../lib/oneLibraryDownloads").then(({ resumeOneLibraryDownloads }) =>
        resumeOneLibraryDownloads(),
      );
    } catch (error) {
      set({ devicesLoading: false, tracksLoading: false, deviceError: message(error) });
    }
  },

  async createPlaylist(devicePath, name, parentId = null, folder = false) {
    const playlist = await api.createOneLibraryPlaylist(
      devicePath,
      name,
      parentId,
      folder,
    );
    set((state) => ({
      playlistsByDevice: {
        ...state.playlistsByDevice,
        [devicePath]: [...(state.playlistsByDevice[devicePath] ?? []), playlist],
      },
      deviceError: "",
    }));
    void get().refreshDevices();
    return playlist;
  },

  async renamePlaylist(devicePath, id, name) {
    await api.renameOneLibraryPlaylist(devicePath, id, name);
    set((state) => ({
      playlistsByDevice: {
        ...state.playlistsByDevice,
        [devicePath]: (state.playlistsByDevice[devicePath] ?? []).map((playlist) =>
          playlist.id === id ? { ...playlist, name } : playlist,
        ),
      },
      selectedTarget:
        state.selectedTarget?.device_path === devicePath && state.selectedTarget.playlist_id === id
          ? { ...state.selectedTarget, playlist_name: name }
          : state.selectedTarget,
      deviceError: "",
    }));
    writeSelectedTarget(get().selectedTarget);
    await get().refreshDevices();
  },

  async movePlaylist(devicePath, id, parentId, sequence = null) {
    try {
      const playlists = await api.moveOneLibraryPlaylist(
        devicePath,
        id,
        parentId,
        sequence,
      );
      set((state) => ({
        playlistsByDevice: { ...state.playlistsByDevice, [devicePath]: playlists },
        deviceError: "",
      }));
    } catch (error) {
      set({ deviceError: message(error) });
      throw error;
    }
  },

  async deletePlaylist(devicePath, id) {
    await api.deleteOneLibraryPlaylist(devicePath, id);
    set((state) => ({
      playlistsByDevice: {
        ...state.playlistsByDevice,
        [devicePath]: (state.playlistsByDevice[devicePath] ?? []).filter(
          (playlist) => playlist.id !== id && playlist.parent_id !== id,
        ),
      },
      deviceError: "",
      ...(state.selectedTarget?.device_path === devicePath && state.selectedTarget.playlist_id === id
        ? {
            selectedTarget: null,
            selectedTracks: [],
            visibleContentIds: null,
            selectedContentIds: [],
            focusedContentId: null,
            selectionMode: false,
            tracksLoading: false,
          }
        : {}),
    }));
    if (!get().selectedTarget) {
      writeSelectedTarget(null);
      updateOneLibraryWorkspaceSession({ target: null, focusedContentId: null, scrollTop: 0 });
    }
    await get().refreshDevices();
  },

  async addTracks(devicePath, id, trackIds) {
    const key = playlistKey(devicePath, id);
    set({ exporting: key, lastExport: null, deviceError: "" });
    try {
      let targetPath = devicePath;
      const plan = await api.oneLibraryCapacity(devicePath, trackIds);
      const device = get().devices.find((candidate) => candidate.path === devicePath);
      if (!plan.sufficient && device?.is_virtual) {
        if (!(useAppStore.getState().settings?.virtual_disk_auto_grow ?? true)) {
          throw new Error(
            "KDJ 空间不足；“空间不足时自动迁移至更大的镜像”已在设置中关闭",
          );
        }
        const virtualDisk = getBridge().virtualDisk;
        if (!virtualDisk) throw new Error("当前桌面壳不能改变 KDJ 虚拟磁盘容量");
        set({ operation: "grow" });
        const status = await virtualDisk.ensureCapacity(plan.required_bytes);
        targetPath = status.mountPath;
        set({ virtualDisk: status, operation: null });
      }
      const result = await api.addOneLibraryPlaylistTracks(targetPath, id, trackIds);
      set({ exporting: null, lastExport: result, operation: null });
      const selected = get().selectedTarget;
      if (selected?.playlist_id === id && selected.device_path === devicePath) {
        await get().openPlaylist({ ...selected, device_path: targetPath });
      }
      window.dispatchEvent(new CustomEvent("kd:onelibrary-tracks-changed", {
        detail: { devicePath: targetPath, playlistId: id },
      }));
      await get().refreshDevices();
      return result;
    } catch (error) {
      set({ exporting: null, operation: null, deviceError: message(error) });
      throw error;
    }
  },

  async openPlaylist(target) {
    writeSelectedTarget(target);
    setRestorableWorkspaceSource("onelibrary");
    updateOneLibraryWorkspaceSession({ target, focusedContentId: null, scrollTop: 0 });
    set({
      selectedTarget: target,
      selectedTracks: [],
      visibleContentIds: null,
      selectedContentIds: [],
      focusedContentId: null,
      selectionMode: false,
      tracksLoading: true,
      deviceError: "",
    });
    try {
      const tracks = await api.oneLibraryPlaylistTracks(target.device_path, target.playlist_id);
      const selected = get().selectedTarget;
      if (
        selected?.device_path !== target.device_path ||
        selected.playlist_id !== target.playlist_id
      ) return;
      set({ selectedTracks: tracks, tracksLoading: false });
    } catch (error) {
      set({ selectedTracks: [], visibleContentIds: [], tracksLoading: false, deviceError: message(error) });
      throw error;
    }
  },

  async reorderTracks(contentIds) {
    const target = get().selectedTarget;
    if (!target) return;
    const previous = get().selectedTracks;
    const positions = new Map(contentIds.map((id, index) => [id, index]));
    const optimistic = [...previous]
      .sort((a, b) => (positions.get(a.content_id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.content_id) ?? Number.MAX_SAFE_INTEGER))
      .map((track, sequence) => ({ ...track, sequence }));
    set({ selectedTracks: optimistic, deviceError: "" });
    try {
      const tracks = await api.reorderOneLibraryPlaylistTracks(
        target.device_path,
        target.playlist_id,
        contentIds,
      );
      set({ selectedTracks: tracks });
    } catch (error) {
      set({ selectedTracks: previous, deviceError: message(error) });
      throw error;
    }
  },

  async rateTrack(contentId, rating) {
    const target = get().selectedTarget;
    if (!target) return;
    const nextRating = Math.max(0, Math.min(5, Math.round(rating)));
    const previous = get().selectedTracks;
    set({
      selectedTracks: previous.map((track) =>
        track.content_id === contentId ? { ...track, rating: nextRating } : track,
      ),
      deviceError: "",
    });
    try {
      await api.setOneLibraryRating(target.device_path, contentId, nextRating);
    } catch (error) {
      set({ selectedTracks: previous, deviceError: message(error) });
      throw error;
    }
  },

  async copyTracks(source, targetDevicePath, targetPlaylistId, contentIds) {
    if (contentIds.length === 0) return;
    set({ deviceError: "" });
    try {
      const tracks = await api.copyOneLibraryPlaylistTracks(
        source.device_path,
        source.playlist_id,
        targetDevicePath,
        targetPlaylistId,
        contentIds,
      );
      const selected = get().selectedTarget;
      if (
        selected?.device_path === targetDevicePath &&
        selected.playlist_id === targetPlaylistId
      ) {
        set({ selectedTracks: tracks });
      }
      window.dispatchEvent(new CustomEvent("kd:onelibrary-tracks-changed", {
        detail: { devicePath: targetDevicePath, playlistId: targetPlaylistId },
      }));
      await get().refreshDevices();
    } catch (error) {
      set({ deviceError: message(error) });
      throw error;
    }
  },

  async importTracksToFolder(source, contentIds, dest) {
    const ids = [...new Set(contentIds.filter((id) => id > 0))];
    if (ids.length === 0) return 0;
    set({ importing: true, deviceError: "" });
    try {
      const result = await api.importOneLibraryTracks(
        source.device_path,
        source.playlist_id,
        ids,
        dest,
      );
      await Promise.all([
        useLibraryStore.getState().refresh(),
        useLibraryStore.getState().refreshFolders(),
        useLibraryStore.getState().refreshStats(),
      ]);
      const failures = Object.values(result.errors);
      if (failures.length > 0) {
        throw new Error(
          result.track_ids.length > 0
            ? `已导入 ${result.track_ids.length} 首，${failures.length} 首失败：${failures[0]}`
            : failures[0],
        );
      }
      set({ importing: false });
      return result.track_ids.length;
    } catch (error: unknown) {
      set({ importing: false, deviceError: message(error) });
      throw error;
    }
  },

  async removeTracks(contentIds) {
    const target = get().selectedTarget;
    if (!target || contentIds.length === 0) return;
    set({ deviceError: "" });
    try {
      const tracks = await api.removeOneLibraryPlaylistTracks(
        target.device_path,
        target.playlist_id,
        contentIds,
      );
      const remaining = new Set(tracks.map((track) => track.content_id));
      set((state) => ({
        selectedTracks: tracks,
        selectedContentIds: state.selectedContentIds.filter((id) => remaining.has(id)),
        focusedContentId:
          state.focusedContentId !== null && remaining.has(state.focusedContentId)
            ? state.focusedContentId
            : null,
      }));
      await get().refreshDevices();
    } catch (error) {
      set({ deviceError: message(error) });
      throw error;
    }
  },

  selectTrack(contentId, mode = "replace") {
    if (contentId === null) {
      updateOneLibraryWorkspaceSession({ focusedContentId: null });
      set({ selectedContentIds: [], focusedContentId: null, selectionMode: false });
      return;
    }
    const { focusedContentId, selectedContentIds, selectedTracks } = get();
    if (mode === "toggle") {
      const has = selectedContentIds.includes(contentId);
      const next = has
        ? selectedContentIds.filter((id) => id !== contentId)
        : [...selectedContentIds, contentId];
      const nextFocused = has ? (next[next.length - 1] ?? null) : contentId;
      updateOneLibraryWorkspaceSession({ focusedContentId: nextFocused });
      set({
        selectedContentIds: next,
        focusedContentId: nextFocused,
      });
      return;
    }
    if (mode === "range" && focusedContentId !== null) {
      const from = selectedTracks.findIndex((track) => track.content_id === focusedContentId);
      const to = selectedTracks.findIndex((track) => track.content_id === contentId);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        updateOneLibraryWorkspaceSession({ focusedContentId: contentId });
        set({
          selectedContentIds: selectedTracks
            .slice(lo, hi + 1)
            .map((track) => track.content_id),
          focusedContentId: contentId,
        });
        return;
      }
    }
    updateOneLibraryWorkspaceSession({ focusedContentId: contentId });
    set({ selectedContentIds: [contentId], focusedContentId: contentId });
  },

  selectAllTracks() {
    const { selectedTracks, visibleContentIds, focusedContentId } = get();
    const ids = visibleContentIds ?? selectedTracks.map((track) => track.content_id);
    const nextFocused = focusedContentId !== null && ids.includes(focusedContentId)
      ? focusedContentId
      : (ids[0] ?? null);
    updateOneLibraryWorkspaceSession({ focusedContentId: nextFocused });
    set({
      selectedContentIds: ids,
      focusedContentId: nextFocused,
      selectionMode: true,
    });
  },

  setVisibleContentIds(contentIds) {
    set((state) => {
      if (
        state.visibleContentIds === contentIds
        || (state.visibleContentIds !== null
          && contentIds !== null
          && state.visibleContentIds.length === contentIds.length
          && state.visibleContentIds.every((id, index) => id === contentIds[index]))
      ) return state;
      return { visibleContentIds: contentIds };
    });
  },

  setSelectionMode(on) {
    set({ selectionMode: on });
  },

  closePlaylist() {
    writeSelectedTarget(null);
    updateOneLibraryWorkspaceSession({ target: null, focusedContentId: null, scrollTop: 0 });
    if (readWorkspaceSession().source === "onelibrary") {
      setRestorableWorkspaceSource("local");
    }
    set({
      selectedTarget: null,
      selectedTracks: [],
      visibleContentIds: null,
      selectedContentIds: [],
      focusedContentId: null,
      selectionMode: false,
      tracksLoading: false,
    });
  },

  async authorizeDevice() {
    set({ deviceError: "" });
    try {
      const path = await getBridge().pickFolder();
      if (!path) return null;
      const device = await api.authorizeRemovableDevice(path);
      await get().refreshDevices();
      return device;
    } catch (error) {
      set({ deviceError: message(error) });
      throw error;
    }
  },

  async mountVirtualDisk(sizeGib = 8, volumeName = "KDJ") {
    const virtualDisk = getBridge().virtualDisk;
    if (!virtualDisk) throw new Error("KDJ 虚拟磁盘只支持 macOS 和 Windows");
    set({ operation: "mount", deviceError: "" });
    try {
      const status = await virtualDisk.mount(sizeGib, volumeName);
      set({ virtualDisk: status, operation: null });
      await get().refreshDevices();
      return status;
    } catch (error) {
      set({ operation: null, deviceError: message(error) });
      throw error;
    }
  },

  async ejectVirtualDisk() {
    const virtualDisk = getBridge().virtualDisk;
    if (!virtualDisk) throw new Error("KDJ 虚拟磁盘只支持 macOS 和 Windows");
    set({ operation: "eject", deviceError: "" });
    try {
      const status = await virtualDisk.eject();
      set({ virtualDisk: status, operation: null });
      await get().refreshDevices();
      return status;
    } catch (error) {
      set({ operation: null, deviceError: message(error) });
      throw error;
    }
  },

  async growVirtualDisk(sizeGib, volumeName) {
    const virtualDisk = getBridge().virtualDisk;
    if (!virtualDisk) throw new Error("KDJ 虚拟磁盘只支持 macOS 和 Windows");
    set({ operation: "grow", deviceError: "" });
    try {
      const status = await virtualDisk.grow(sizeGib, volumeName);
      set({ virtualDisk: status, operation: null });
      await get().refreshDevices();
      return status;
    } catch (error) {
      set({ operation: null, deviceError: message(error) });
      throw error;
    }
  },

  async deleteVirtualDisk() {
    const virtualDisk = getBridge().virtualDisk;
    if (!virtualDisk) throw new Error("KDJ 虚拟磁盘只支持 macOS 和 Windows");
    set({ operation: "delete", deviceError: "" });
    try {
      const status = await virtualDisk.delete();
      removePendingVirtualDiskDownloads();
      set({ virtualDisk: status, operation: null });
      await get().refreshDevices();
      return status;
    } catch (error) {
      set({ operation: null, deviceError: message(error) });
      throw error;
    }
  },

  clearError() {
    set({ deviceError: "" });
  },

  clearLastExport() {
    set({ lastExport: null });
  },
}));
