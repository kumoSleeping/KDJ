import { create } from "zustand";

/** 分享到外部应用时，普通文本里附带多少歌曲信息（见 shareLink.ts / shareClipboard.ts）。 */
export type ShareContentMode = "link_only" | "song_info" | "more_info";

/**
 * 分享固定为「更多信息」：歌曲名、艺术家、Share from KDJ 版本水印和小尺寸缩略封面。
 * 设置里不再有这个选项，原链接与包含信息两种方式不再使用；这里只保留一个固定值，
 * 让分享的各处入口读同一个来源。以前存下的选择（`kd-share-prefs`）被忽略。
 */
export const SHARE_CONTENT_MODE: ShareContentMode = "more_info";

export const useSharePrefs = create<{ contentMode: ShareContentMode }>(() => ({
  contentMode: SHARE_CONTENT_MODE,
}));
