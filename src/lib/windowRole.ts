export const editorWindowLabels = ["kvj", "visualizer-studio", "live-vj-control", "preferences"] as const;
export type EditorWindowLabel = typeof editorWindowLabels[number];
const windowKind = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("window") : null;
export const isKvjWindow = windowKind === "kvj";
export const isPreferencesWindow = windowKind === "preferences";
export const isVisualizerWindow = windowKind === "visualizer-studio";
export const isEditorWindow = editorWindowLabels.some(label => label === windowKind);
export function usesKvjWindow(): boolean {
  return typeof window !== "undefined" && !isKvjWindow && !!window.__TAURI_INTERNALS__
    && ["darwin", "win32", "linux"].includes(window.kdj?.platform ?? "");
}
export function usesPreferencesWindow(): boolean {
  return !isPreferencesWindow && typeof window !== "undefined" && !!window.__TAURI_INTERNALS__
    && ["darwin", "win32", "linux"].includes(window.kdj?.platform ?? "");
}
export function usesVisualizerWindow(): boolean {
  return !isVisualizerWindow && typeof window !== "undefined" && !!window.__TAURI_INTERNALS__
    && ["darwin", "win32", "linux"].includes(window.kdj?.platform ?? "");
}
