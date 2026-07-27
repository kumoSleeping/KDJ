import { create } from "zustand";
import { api } from "./api";
import {
  AUDIO_FOCUS_EVENT,
  announceAudioFocus,
  type AudioFocusDetail,
} from "./audioFocus";
import type { SongSource } from "../types";

/**
 * 搜索结果里的「试听」：不下载、不入库，问后端要一条**最低码率**直链
 * 塞进一个模块级的 <audio> 里放。整个应用同一时刻只可能试听一首，
 * 所以元素只有一个、状态是全局的——每行按钮只需要问"现在放的是不是我"。
 *
 * 出声走 audioFocus 的约定（owner = "song"）：试听一响，播放条和视频预览
 * 自觉闭嘴；反过来它们谁开声，这边立刻停。试听是三种声源里最"临时"的，
 * 不参与协同播放那套推子。
 */

interface SongPreviewState {
  /** 正在放的来源标识（platform:key），null = 没在试听。 */
  playingKey: string | null;
  /** 正在解析直链的来源标识：从点击到出声有一次网络往返，按钮要有个等待脸。 */
  loadingKey: string | null;
  /** 最近一次失败：{哪一行, 为什么}。挂在行上显示，换一行操作就清掉。 */
  error: { key: string; message: string } | null;
}

export const useSongPreview = create<SongPreviewState>(() => ({
  playingKey: null,
  loadingKey: null,
  error: null,
}));

/** 一行来源的身份证：跨平台去重后同一首歌可能有多个来源，得分开认。 */
export function sourceKey(source: SongSource): string {
  return `${source.platform}:${source.key}`;
}

let element: HTMLAudioElement | null = null;
/** 点击序号：解析直链期间用户又点了别的，晚回来的结果直接作废。 */
let seq = 0;

function ensureElement(): HTMLAudioElement {
  if (element) return element;
  element = new Audio();
  element.preload = "none";
  element.addEventListener("ended", () => {
    useSongPreview.setState({ playingKey: null });
  });
  // 别人开声（播放条 / 视频预览）就自己停，见 audioFocus.ts 的约定
  window.addEventListener(AUDIO_FOCUS_EVENT, (event) => {
    if ((event as CustomEvent<AudioFocusDetail>).detail.owner !== "song") {
      stopSongPreview();
    }
  });
  return element;
}

export function stopSongPreview(): void {
  seq += 1;
  element?.pause();
  const state = useSongPreview.getState();
  if (state.playingKey !== null || state.loadingKey !== null) {
    useSongPreview.setState({ playingKey: null, loadingKey: null });
  }
}

/** 行内按钮的唯一入口：没在放就放这首，正在放这首就停。 */
export async function toggleSongPreview(source: SongSource): Promise<void> {
  const key = sourceKey(source);
  const state = useSongPreview.getState();
  if (state.playingKey === key || state.loadingKey === key) {
    stopSongPreview();
    return;
  }

  const mySeq = ++seq;
  const audio = ensureElement();
  audio.pause();
  useSongPreview.setState({ playingKey: null, loadingKey: key, error: null });
  try {
    const { url } = await api.songPreview(source);
    if (seq !== mySeq) return; // 等待期间用户点了别的行
    audio.src = url;
    announceAudioFocus("song");
    await audio.play();
    if (seq !== mySeq) return;
    useSongPreview.setState({ playingKey: key, loadingKey: null });
  } catch (err) {
    if (seq !== mySeq) return;
    useSongPreview.setState({
      playingKey: null,
      loadingKey: null,
      error: { key, message: err instanceof Error ? err.message : String(err) },
    });
  }
}
