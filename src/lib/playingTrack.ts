/**
 * 当前主唱盘正在播（或已装入）的本地曲目。
 * PlayerBar 写入；曲库「定位正在播」读取——避免从大组件反向 import。
 */

import type { Track } from "../types";

let playing: Track | null = null;
const listeners = new Set<() => void>();

export function setPlayingTrack(track: Track | null): void {
  if (playing === track) return;
  if (playing?.id === track?.id && track !== null && playing !== null) {
    // 同 id 换了对象（分析回填元数据）也要更新快照，但不强制打扰订阅者重渲
    playing = track;
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
