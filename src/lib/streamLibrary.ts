import type { Platform, StreamLibraryItem } from "../types";

export const STREAM_LIBRARY_CHANGED_EVENT = "kd:stream-library-changed";
export const STREAM_LIBRARY_OPEN_EVENT = "kd:stream-library-open";

export interface StreamLibraryOpenDetail {
  platform: Exclude<Platform, "local" | "bilibili">;
  items: StreamLibraryItem[];
}

export function notifyStreamLibraryChanged(): void {
  window.dispatchEvent(new Event(STREAM_LIBRARY_CHANGED_EVENT));
}

export function openStreamLibrary(detail: StreamLibraryOpenDetail): void {
  window.dispatchEvent(new CustomEvent<StreamLibraryOpenDetail>(STREAM_LIBRARY_OPEN_EVENT, { detail }));
}
