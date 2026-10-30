import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The window's own fullscreen, for the previews that fill it. Android has no Tauri window
 * plugin (every call is rejected with "Plugin window not initialized"): there the app already
 * fills the screen, and fullscreen hides the status and navigation bars (MainActivity's
 * `kdjAndroid.setImmersive`). A swipe from the edge shows them for a moment; the back key leaves
 * fullscreen as Esc does.
 */
interface AndroidActivity {
  setImmersive?(on: boolean): void;
}

function android(): AndroidActivity | null {
  if (window.kdj?.platform !== "android") return null;
  return (window as unknown as { kdjAndroid?: AndroidActivity }).kdjAndroid ?? null;
}

let immersive = false;

export function isWindowFullscreen(): Promise<boolean> {
  if (window.kdj?.platform === "android") return Promise.resolve(immersive);
  return getCurrentWindow().isFullscreen();
}

export async function setWindowFullscreen(on: boolean): Promise<void> {
  if (window.kdj?.platform === "android") {
    const activity = android();
    if (!activity?.setImmersive) throw new Error("这个版本的安卓外壳不能隐藏系统栏");
    activity.setImmersive(on);
    immersive = on;
    return;
  }
  await getCurrentWindow().setFullscreen(on);
}

/** Tauri rejects with `{ message }`, not an Error: never show it as "[object Object]". */
export function fullscreenErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}
