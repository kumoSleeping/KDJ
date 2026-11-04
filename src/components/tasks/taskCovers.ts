import { api } from "../../lib/api";
import { downloadTaskCovers, visualizerExportCovers, type DownloadCoverTask } from "../../lib/taskCovers";
import { appCoverAddresses } from "../../lib/useTaskCovers";
import { knownVisualizerExportPoster } from "../../lib/visualizerExportPoster";
import type { DownloadTask, Track } from "../../types";
import type { TaskCover } from "./taskBubbleSchema";

/**
 * Where the covers of a task bubble come from. Downloads and exports use the derivation of the
 * task lists (src/lib/taskCovers.ts), so a bubble and its row show the same picture.
 */

/** A library track's cover: the sized thumbnail first, then the embedded original. */
export function libraryCover(trackId: number, revision?: string): TaskCover {
  return { key: trackId, urls: [api.coverUrl(trackId, revision, 256), api.coverUrl(trackId, revision)] };
}

export function trackTaskCover(track: Pick<Track, "id" | "modified_at">, onlineUrls: readonly string[] = []): TaskCover | null {
  if (track.id > 0) return libraryCover(track.id, track.modified_at);
  return onlineUrls.length ? { key: track.id, urls: onlineUrls } : null;
}

/** A download's pictures, best first, from the same derivation the task lists use. */
export function downloadTaskCover(task: Pick<DownloadTask, "id"> & DownloadCoverTask): TaskCover | null {
  const urls = downloadTaskCovers(task, appCoverAddresses);
  return urls.length ? { key: task.id, urls } : null;
}

/** A project export shows the cover of its project's row, as its row in the list does. */
export function projectTaskCover(task: { id: string; trackId: number }): TaskCover | null {
  const urls = visualizerExportCovers({ trackId: task.trackId }, appCoverAddresses);
  return urls.length ? { key: task.id, urls } : null;
}

/** A visualizer export shows its project's own picture once that has been read, else its song. */
export function visualizerTaskCover(task: { id: string; trackId?: number }): TaskCover | null {
  const urls = visualizerExportCovers({ poster: knownVisualizerExportPoster(task.id)?.url, trackId: task.trackId }, appCoverAddresses);
  return urls.length ? { key: task.id, urls } : null;
}
