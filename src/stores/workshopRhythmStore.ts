import { create } from "zustand";
import { api } from "../lib/api";
import { rhythmKey, type WorkshopRhythmResults } from "../lib/workshopRhythm";
import type { RhythmResponse, WorkshopSource } from "../types/workshop";

interface RhythmStore {
  results: WorkshopRhythmResults;
  errors: Record<string, string | undefined>;
  requesting: Record<string, boolean | undefined>;
}
export const useWorkshopRhythmStore = create<RhythmStore>()(() => ({results: {}, errors: {}, requesting: {}}));
const watches = new Map<string, { users: number; refresh(): void; stop(): void }>();
const busy = (value?: RhythmResponse) => value?.status && ["queued", "analyzing"].includes(value.status.phase);

/** One full-track precise analysis per source, shared by every split/copy; never detail-wave decoding. */
export function watchWorkshopRhythm(source: WorkshopSource): () => void {
  const key = rhythmKey(source);
  let entry = watches.get(key);
  if (!entry) {
    let live = true, running = false, again = false, automaticRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!live) return;
      if (running) { again = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        let value = await api.rhythm(source.track_id);
        if (!live) return;
        if (!value.analysis?.precise && !busy(value) && !automaticRequested
          && (!value.status || value.status.phase === "complete")) {
          automaticRequested = true;
          await api.analyzeRhythm(source.track_id, true);
          if (!live) return;
          value = await api.rhythm(source.track_id);
          if (!live) return;
        }
        useWorkshopRhythmStore.setState(s => ({results: {...s.results, [key]: value}, errors: {...s.errors, [key]: value.status?.error || undefined}}));
        if (busy(value)) timer = setTimeout(() => void poll(), 800);
      } catch (error) {
        if (live) useWorkshopRhythmStore.setState(s => ({errors: {...s.errors, [key]: String(error)}}));
      } finally {
        running = false;
        if (live && again) { again = false; void poll(); }
      }
    };
    entry = {users: 0, refresh: () => { void poll(); }, stop: () => { live = false; clearTimeout(timer); }};
    watches.set(key, entry);
    entry.refresh();
  }
  entry.users++;
  return () => {
    if (--entry.users === 0) { entry.stop(); watches.delete(key); }
  };
}

export async function analyzeWorkshopRhythm(source: WorkshopSource): Promise<void> {
  const key = rhythmKey(source);
  if (useWorkshopRhythmStore.getState().requesting[key]) return;
  useWorkshopRhythmStore.setState(s => ({requesting: {...s.requesting, [key]: true}, errors: {...s.errors, [key]: undefined}}));
  try {
    await api.analyzeRhythm(source.track_id, true, true);
    watches.get(key)?.refresh();
  } catch (error) {
    useWorkshopRhythmStore.setState(s => ({errors: {...s.errors, [key]: String(error)}}));
  } finally {
    useWorkshopRhythmStore.setState(s => ({requesting: {...s.requesting, [key]: false}}));
  }
}
