export const STEM_DEBUG_OPEN_EVENT = "kdj:stem-debug-open";

export function openStemDebug(): void {
  window.dispatchEvent(new Event(STEM_DEBUG_OPEN_EVENT));
}
