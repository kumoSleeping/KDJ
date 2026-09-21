import { create } from "zustand";
import { api } from "../lib/api";
import { getBridge } from "../lib/bridge";
import type { FfmpegInstallationStatus, FfmpegInstallProgress } from "../types";

export const mediaToolsInstalling = (progress: FfmpegInstallProgress | null) =>
  !!progress && ["preparing", "downloading", "extracting", "validating"].includes(progress.phase);

interface FfmpegState {
  status: FfmpegInstallationStatus | null;
  progress: FfmpegInstallProgress | null;
  checking: boolean;
  choosing: boolean;
  error: string;
  refresh: () => Promise<void>;
  install: (action: "download" | "zip" | "folder") => Promise<void>;
  setError: (error: string) => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let refreshPromise: Promise<void> | undefined;
function followInstallation() {
  clearTimeout(timer);
  if (!mediaToolsInstalling(useFfmpegStore.getState().progress)) return;
  timer = setTimeout(() => void pollProgress(), 1000);
}
async function pollProgress() {
  try {
    const progress = await getBridge().mediaToolsProgress?.();
    if (!progress) return;
    useFfmpegStore.setState({ progress, error: progress.error ?? "" });
    if (!mediaToolsInstalling(progress)) {
      await useFfmpegStore.getState().refresh();
      return;
    }
  } catch (cause) {
    useFfmpegStore.setState({ error: String(cause) });
  }
  followInstallation();
}

export const useFfmpegStore = create<FfmpegState>((set, get) => ({
  status: null, progress: null, checking: false, choosing: false, error: "",
  setError: error => set({ error }),
  refresh: () => {
    if (refreshPromise) return refreshPromise;
    set({ checking: true });
    refreshPromise = (async () => {
      try {
        const [status, progress] = await Promise.all([
          api.ffmpegInstallationStatus(), getBridge().mediaToolsProgress?.(),
        ]);
        set({ status, progress: progress ?? null, error: progress?.error ?? "" });
        followInstallation();
      } catch (cause) { set({ error: String(cause) }); }
      finally { set({ checking: false }); refreshPromise = undefined; }
    })();
    return refreshPromise;
  },
  install: async action => {
    if (get().choosing || mediaToolsInstalling(get().progress)) return;
    const install = getBridge().installMediaTools;
    if (!install) { set({ error: "请在 Mac 或 Windows 版 KDJ 中安装媒体工具" }); return; }
    set({ choosing: true, error: "" });
    try {
      // Finish an older status check before starting so it cannot overwrite the job.
      if (refreshPromise) await refreshPromise;
      const started = await install(action);
      if (started) {
        // Keep following the native job even if the first progress read fails.
        set({ progress: { phase: "preparing", downloaded: 0, total: null, error: null, component: null } });
        followInstallation();
        const progress = await getBridge().mediaToolsProgress!();
        set({ progress, error: progress.error ?? "" });
        if (mediaToolsInstalling(progress)) followInstallation();
        else await get().refresh();
      }
    } catch (cause) { set({ error: String(cause) }); }
    finally { set({ choosing: false }); }
  },
}));
