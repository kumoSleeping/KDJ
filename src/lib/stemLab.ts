export const STEM_LAB_OPEN_EVENT = "kdj:stem-lab-open";

export function openStemLab(): void {
  window.dispatchEvent(new Event(STEM_LAB_OPEN_EVENT));
}
