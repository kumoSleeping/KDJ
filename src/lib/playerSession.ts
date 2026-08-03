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

let snapshot = EMPTY_SESSION;
const listeners = new Set<() => void>();

export function getPlayerSession(): PlayerSessionSnapshot {
  return snapshot;
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
  snapshot = next;
  for (const listener of listeners) listener();
}

export const PLAYER_COMMAND_EVENT = "kd:player-command";

export type PlayerCommand =
  | { type: "toggle" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; position: number };

export function requestPlayerCommand(command: PlayerCommand): void {
  window.dispatchEvent(new CustomEvent<PlayerCommand>(PLAYER_COMMAND_EVENT, { detail: command }));
}
