/**
 * 当前主唱盘正在播（或已装入）的曲目，包含在线试听临时曲目。
 * PlayerBar 写入；工作台歌词与曲库工具读取——避免从大组件反向 import。
 */

import type { Track } from "../types";

let playing: Track | null = null;
const listeners = new Set<() => void>();

export function setPlayingTrack(track: Track | null): void {
  if (playing === track) return;
  if (playing?.id === track?.id && track !== null && playing !== null) {
    // 同 id 换对象通常就是在线分析回填。外部 store 必须收到通知，否则详情仍拿着
    // 播放前的空 BPM/Key Track，只有 PlayerBar 自己知道新元数据。
    playing = track;
    for (const listener of listeners) listener();
    return;
  }
  playing = track;
  for (const listener of listeners) listener();
}

export function getPlayingTrack(): Track | null {
  return playing;
}

export function subscribePlayingTrack(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}
