export const PERFORMANCE_MIXER_SESSION_KEY = "kd-performance-mixer-session-v1";

/** Manager song loads start a neutral single-track context; DJ loads never call this. */
export function clearPerformanceMixerSession(
  storage: Pick<Storage, "removeItem"> = window.sessionStorage,
): void {
  try {
    storage.removeItem(PERFORMANCE_MIXER_SESSION_KEY);
  } catch {
    // Storage may be unavailable in a restricted WebView; the mounted reset revision still wins.
  }
}
