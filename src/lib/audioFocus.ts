/**
 * 「现在谁在出声」的广播。
 *
 * 播放条（曲库预听）和视频预览是两个互不相识的发声体，同时出声就是两轨混音。
 * 约定：谁开始出声谁喊一声，另一个听到不是自己就自觉暂停。
 * 用全局事件而不是共享 store，和 kd:play / kd:seek 一套思路——
 * 发声体之间不需要知道对方的存在，只需要知道"有别人开口了"。
 */
export const AUDIO_FOCUS_EVENT = "kd:audio-focus";

export type AudioFocusOwner = "player" | "preview" | "song" | "local-video";

export interface AudioFocusDetail {
  owner: AudioFocusOwner;
}

export function announceAudioFocus(owner: AudioFocusOwner): void {
  window.dispatchEvent(
    new CustomEvent<AudioFocusDetail>(AUDIO_FOCUS_EVENT, { detail: { owner } }),
  );
}
