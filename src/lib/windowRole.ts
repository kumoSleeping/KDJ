export const isKvjWindow = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("window") === "kvj";
export function usesKvjWindow(): boolean {
  return typeof window !== "undefined" && !isKvjWindow && !!window.__TAURI_INTERNALS__
    && ["darwin", "win32", "linux"].includes(window.kdj?.platform ?? "");
}
