/**
 * 视频和曲库音频之间的同步协议。
 *
 * 播放器和视频组件的生命周期不同，直接互传 ref 会让换页、卸载和 DJ
 * 双 deck 变得很脆。用事件传递走带动作和音频时钟，两边只需要认自己的
 * owner；position 由音频播放器广播，视频侧按需要纠偏。
 */
export const MEDIA_SYNC_EVENT = "kd:media-sync";

export type MediaSyncOwner = "player" | "preview" | "local-video";
export type MediaSyncAction = "play" | "pause" | "seek" | "position";

export interface MediaSyncDetail {
  owner: MediaSyncOwner;
  action: MediaSyncAction;
  /** 本地视频和音频要配对；在线预览由当前协同会话隐式配对。 */
  trackId?: number;
  /** position 对 player 是音频时间，对视频是修正后的目标时间。 */
  position?: number;
}

export function broadcastMediaSync(detail: MediaSyncDetail): void {
  window.dispatchEvent(new CustomEvent<MediaSyncDetail>(MEDIA_SYNC_EVENT, { detail }));
}
