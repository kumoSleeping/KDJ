import { create } from "zustand";
import { readLocalStorage, writeLocalStorageSoon } from "./storageWrite";

export const MASTER_VOLUME_STORAGE_KEY = "kd-player-volume";

export function normalizeMasterVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function initialMasterVolume(): number {
  const raw = readLocalStorage(MASTER_VOLUME_STORAGE_KEY);
  if (raw === null) return 1;
  const saved = Number(raw);
  return Number.isFinite(saved) ? normalizeMasterVolume(saved) : 1;
}

interface MasterVolumeState {
  volume: number;
  setVolume(volume: number): void;
}

/**
 * 应用的最终 MASTER 音量。唱盘、HTML 视频和平台官方播放器都订阅同一份状态，
 * 避免底栏推子只改 Rust/CPAL、在线视频仍保持 100%。
 */
export const useMasterVolume = create<MasterVolumeState>((set) => ({
  volume: initialMasterVolume(),
  setVolume: (rawVolume) => {
    const volume = normalizeMasterVolume(rawVolume);
    writeLocalStorageSoon(MASTER_VOLUME_STORAGE_KEY, String(volume), 1_000);
    set({ volume });
  },
}));
