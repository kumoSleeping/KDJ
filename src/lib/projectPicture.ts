/**
 * Which picture plays a `.kdjv` project on macOS: WebCodecs drawing in the page
 * (KdjvCodecPicture) or mpv's native views under it (KdjvMpvPicture). A trial switch kept on
 * this machine only (localStorage), so the two can be compared; settings.json is not touched.
 */
import { useSyncExternalStore } from "react";
import { webVideoOff } from "./mpvPlayer";

export type ProjectPicture = "codec" | "mpv";

const KEY = "kdj.projectPicture";
const listeners = new Set<() => void>();

/** The WebView decodes video itself (WebKit with Safari 16.4's WebCodecs, WebView2). */
export function codecDecodeAvailable(): boolean {
  return typeof VideoDecoder !== "undefined";
}

function read(): ProjectPicture {
  try {
    return localStorage.getItem(KEY) === "mpv" ? "mpv" : "codec";
  } catch {
    return "codec";
  }
}

export function setProjectPicture(next: ProjectPicture): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private storage off: the choice lasts until the window reloads.
  }
  for (const listener of listeners) listener();
}

export function useProjectPicture(): ProjectPicture {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read,
  );
}

/** Whether a project's picture is mpv's native views (outside controls, holes in the page). */
export function projectPictureNative(choice: ProjectPicture): boolean {
  return webVideoOff() && (choice === "mpv" || !codecDecodeAvailable());
}
