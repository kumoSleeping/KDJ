import type { StreamPlaylist, StreamPlaylistResponse } from "../types";
import type { WorkspaceSession } from "./workspaceSession";

export type StreamStartupPlatform = StreamPlaylist["platform"];

export interface ForegroundStreamStartup {
  playlist: StreamPlaylist;
  accountKey: string;
}

/** Keep the foreground target visible even when a bounded directory cache omitted it. */
export function withForegroundStreamPlaceholder(
  playlists: StreamPlaylist[],
  platform: StreamStartupPlatform,
  target: ForegroundStreamStartup | null,
): StreamPlaylist[] {
  if (
    !target ||
    target.playlist.platform !== platform ||
    playlists.some((playlist) => playlist.key === target.playlist.key)
  ) {
    return playlists;
  }
  return [target.playlist, ...playlists];
}

/**
 * Only the online playlist that owned foreground focus when the app closed may make a startup
 * provider request. A pinned/background pane or a merely expanded provider root is not intent.
 */
export function resolveForegroundStreamStartup(
  session: WorkspaceSession,
  accountKeys: Partial<Record<StreamStartupPlatform, string | null>>,
): ForegroundStreamStartup | null {
  const playlist = session.stream.playlist;
  if (session.source !== "stream" || !playlist) return null;
  const persistedAccountKey = session.stream.accountKey;
  const currentAccountKey = accountKeys[playlist.platform] ?? null;
  if (
    !persistedAccountKey ||
    !currentAccountKey ||
    // volatile keys only distinguish Account objects inside one process. Their counter restarts
    // with the app, so the same text on a later launch is not proof of the same private account.
    !persistedAccountKey.startsWith("persistent:") ||
    !currentAccountKey.startsWith("persistent:") ||
    persistedAccountKey !== currentAccountKey
  ) {
    return null;
  }
  return { playlist, accountKey: currentAccountKey };
}

function startupRequestKey(target: ForegroundStreamStartup): string {
  return JSON.stringify([
    target.accountKey,
    target.playlist.platform,
    target.playlist.key,
  ]);
}

let foregroundRequest:
  | { key: string; promise: Promise<StreamPlaylistResponse> }
  | null = null;

/**
 * React StrictMode remounts the workspace during development. Retain the one startup promise for
 * the process lifetime so both mounts observe the same provider request instead of hitting the
 * account twice. Explicit user refreshes do not use this lane.
 */
export function loadForegroundStreamOnce(
  target: ForegroundStreamStartup,
  load: () => Promise<StreamPlaylistResponse>,
): Promise<StreamPlaylistResponse> {
  const key = startupRequestKey(target);
  if (foregroundRequest?.key === key) return foregroundRequest.promise;
  const promise = Promise.resolve().then(load);
  foregroundRequest = { key, promise };
  return promise;
}

/** Test-only process-state reset. */
export function resetForegroundStreamStartupForTests(): void {
  foregroundRequest = null;
}
