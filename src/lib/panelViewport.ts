import { create } from "zustand";

/** Responsive presentation only. Never write enabled flags, placements or window-size overrides. */
export const usePanelViewport = create<{
  narrow: boolean;
  compact: boolean;
  activeIds: string[];
  setMode(narrow: boolean, compact: boolean): void;
  togglePanel(id: string): void;
  closePanel(id?: string): void;
}>((set) => ({
  narrow: false, compact: false, activeIds: [],
  setMode: (narrow, compact) => set(state => state.narrow === narrow && state.compact === compact ? state
    : { narrow, compact, activeIds: [] }),
  togglePanel: id => set(state => ({ activeIds: state.activeIds.includes(id)
    ? state.activeIds.filter(value => value !== id) : [...state.activeIds, id] })),
  closePanel: id => set(state => !state.activeIds.length ? state
    : { activeIds: id ? state.activeIds.filter(value => value !== id) : [] }),
}));
