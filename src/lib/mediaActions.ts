/**
 * 媒体用例门面。列表、详情、播放条和拖放入口只表达用户意图，不自行决定
 * 队列何时打开、平台准备何时开始或任务如何注册到 OneLibrary。
 */

import { useAppStore } from "../stores/appStore";
import { useDownloadStore } from "../stores/downloadStore";
import type { DownloadTask, OneLibraryTarget, Quality, SongSource } from "../types";

export interface EnqueueMediaOptions {
  quality?: Quality | null;
  analyze?: boolean | null;
  dest_dir?: string;
  one_library_target?: OneLibraryTarget | null;
  /** 默认 true。显式 false 只给恢复/后台维护用。 */
  revealQueue?: boolean;
  video?: {
    audioOnly: boolean;
    maxHeight: number;
    transcode: boolean;
  };
}

function normalizedDownloadSources(
  sources: SongSource[],
  options: EnqueueMediaOptions,
): SongSource[] {
  if (!options.video) return sources;
  return sources.map((source) =>
    source.platform === "bilibili" || source.platform === "youtube"
      ? {
          ...source,
          payload: {
            ...source.payload,
            audio_only: options.video?.audioOnly,
            max_height: options.video?.maxHeight,
            transcode: options.video?.transcode,
          },
        }
      : source,
  );
}

/** 所有歌曲下载入口的唯一前端用例。队列先响应，平台网络准备永不阻塞面板反馈。 */
export async function enqueueMediaDownloads(
  sources: SongSource[],
  options: EnqueueMediaOptions = {},
): Promise<DownloadTask[]> {
  if (sources.length === 0) return [];
  if (options.revealQueue !== false) useAppStore.getState().openQueuePanel();
  return useDownloadStore.getState().enqueue(normalizedDownloadSources(sources, options), options);
}

/** 设置切到自动下载时恢复所有需要外部准备的任务；调用者不识别具体平台。 */
export function resumePendingDownloadPreparations(): void {
  void import("./api").then(({ api }) =>
    api.preparePendingDownloads().catch((error) => {
      console.warn("下载来源准备失败", error);
    }),
  );
}
