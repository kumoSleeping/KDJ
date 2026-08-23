import { create } from "zustand";

/** 右下角浮层默认停留时间。点叉可提前关掉。 */
export const TOAST_DURATION_MS = 10_000;

interface ToastStore {
  text: string;
  /** 同一句话再推一次也要重新计时、重新入场。 */
  token: number;
  show(text: string): void;
  dismiss(): void;
}

export const useToastStore = create<ToastStore>((set) => ({
  text: "",
  token: 0,
  show(text) {
    const next = text.trim();
    if (!next) {
      set({ text: "" });
      return;
    }
    set((state) => ({ text: next, token: state.token + 1 }));
  },
  dismiss() {
    set({ text: "" });
  },
}));
