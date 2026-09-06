import { create } from "zustand";

export interface ManagerMixerValues {
  gain: number;
  high: number;
  mid: number;
  low: number;
  filter: number;
  volume: number;
}

export const DEFAULT_MANAGER_MIXER: ManagerMixerValues = {
  gain: 0,
  high: 0,
  mid: 0,
  low: 0,
  filter: 0,
  volume: 1,
};

interface ManagerMixerState {
  values: ManagerMixerValues;
  setValues(values: ManagerMixerValues): void;
}

/**
 * Manager mixer controls belong to the listening session rather than an individual song.
 * Keep this store intentionally memory-only: switching tracks or rebuilding the keyed detail
 * panel retains the knobs, while a fresh application session still starts from neutral.
 */
export const useManagerMixer = create<ManagerMixerState>((set) => ({
  values: { ...DEFAULT_MANAGER_MIXER },
  setValues: (values) => set({ values }),
}));
