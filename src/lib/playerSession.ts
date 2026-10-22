/**
 * 播放条对右侧详情/歌词栏公开的只读会话快照与命令总线。
 *
 * 真正持有媒体元素的仍只有 PlayerBar；旁路面板不能再创建第二个 audio，
 * 否则暂停、进度、下一首和系统媒体键会各管各的。
 */
export type PlayerSessionStatus =
  | "idle"
  | "resolving"
  | "loading"
  | "buffering"
  | "playing"
  | "paused"
  | "ended"
  | "error";

/** A load failure belongs to the track, not the lifetime of its dismissible toast. */
export function playerSessionFailed(
  trackId: number | null,
  failedLoadTrackId: number | null,
  mediaStatus: PlayerSessionStatus,
  _notice: string,
): boolean {
  return trackId !== null && (
    failedLoadTrackId === trackId || mediaStatus === "error"
  );
}

export interface PlayerSessionSnapshot {
  trackId: number | null;
  status: PlayerSessionStatus;
  playing: boolean;
  position: number;
  duration: number;
  error: string;
}

const EMPTY_SESSION: PlayerSessionSnapshot = {
  trackId: null,
  status: "idle",
  playing: false,
  position: 0,
  duration: 0,
  error: "",
};

/** The session without its clock: which track, in what state. */
export type PlayerSessionState = Omit<PlayerSessionSnapshot, "position">;

let snapshot = EMPTY_SESSION;
let state: PlayerSessionState = EMPTY_SESSION;
const listeners = new Set<() => void>();

/** Everything, the position included: a new object on every tick of the player clock. */
export function getPlayerSession(): PlayerSessionSnapshot {
  return snapshot;
}

/**
 * The same session for a surface that does not show the position. The object is replaced only
 * when the track, its status, its duration or its error changes, so `useSyncExternalStore` on it
 * does not re-render at the rate of the player clock.
 */
export function getPlayerSessionState(): PlayerSessionState {
  return state;
}

export function subscribePlayerSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishPlayerSession(next: PlayerSessionSnapshot): void {
  if (
    next.trackId === snapshot.trackId &&
    next.status === snapshot.status &&
    next.playing === snapshot.playing &&
    next.position === snapshot.position &&
    next.duration === snapshot.duration &&
    next.error === snapshot.error
  ) {
    return;
  }
  if (
    next.trackId !== state.trackId ||
    next.status !== state.status ||
    next.playing !== state.playing ||
    next.duration !== state.duration ||
    next.error !== state.error
  ) {
    state = next;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

export const PLAYER_COMMAND_EVENT = "kd:player-command";

export type PlayerCommand =
  | { type: "toggle" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; position: number }
  /** The row playing now plays from another file, from where it is: an edited project's new sound. */
  | { type: "resound"; trackId: number; path: string };

export function requestPlayerCommand(command: PlayerCommand): void {
  window.dispatchEvent(new CustomEvent<PlayerCommand>(PLAYER_COMMAND_EVENT, { detail: command }));
}
