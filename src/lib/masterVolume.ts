import { create } from "zustand";
import { deckGain, previewGain, useCrossfade } from "./crossfade";
import { readLocalStorage, writeLocalStorageSoon } from "./storageWrite";

export const MASTER_VOLUME_STORAGE_KEY = "kd-player-volume";

export function normalizeMasterVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Slider position → linear amplitude. Roughly 60 dB of travel, with true silence at zero.
 * 20/50/80% yield about -50/-30/-12 dB instead of the old -14/-6/-2 dB.
 * Apply once at the output, after clip automation and before the device/player.
 */
export function masterVolumeGain(volume: number): number {
  const position = normalizeMasterVolume(volume);
  if (position === 0 || position === 1) return position;
  return Math.expm1(Math.log(1000) * position) / 999;
}

export function getDeckOutputGain(): number {
  const { coplay, x } = useCrossfade.getState();
  return masterVolumeGain(useMasterVolume.getState().volume) * deckGain(coplay, x);
}

export function getPreviewOutputGain(): number {
  const { coplay, x } = useCrossfade.getState();
  return masterVolumeGain(useMasterVolume.getState().volume) * previewGain(coplay, x);
}

/** Bind before play/source loading; subscriptions also cover non-React mute controls. */
export function bindMediaMasterVolume(media: HTMLMediaElement, route: "master" | "preview" = "master"): () => void {
  const apply = () => {
    media.volume = route === "preview" ? getPreviewOutputGain() : masterVolumeGain(useMasterVolume.getState().volume);
  };
  const unlistenVolume = useMasterVolume.subscribe(apply);
  const unlistenCrossfade = route === "preview" ? useCrossfade.subscribe(apply) : undefined;
  apply();
  return () => { unlistenVolume(); unlistenCrossfade?.(); };
}

function initialMasterVolume(): number {
  const raw = readLocalStorage(MASTER_VOLUME_STORAGE_KEY);
  if (raw === null) return 1;
  const saved = Number(raw);
  return Number.isFinite(saved) ? normalizeMasterVolume(saved) : 1;
}

interface MasterVolumeState {
  /** Persisted slider position, not a linear output gain. */
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
