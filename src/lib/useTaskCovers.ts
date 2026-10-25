/**
 * The task pictures of `taskCovers.ts`, bound to this app's addresses and memoised for rows.
 *
 * A list is only recomputed when a field it is derived from changes: a row is rendered again on
 * every progress tick of its task, and its cover must keep the very addresses it already loaded.
 */

import { useEffect, useMemo, useState } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import { api } from "./api";
import {
  TASK_COVER_PX,
  downloadTaskCovers,
  taskCoverStack,
  visualizerExportCovers,
  type DownloadCoverTask,
  type TaskCoverAddresses,
  type TaskCoverStackView,
} from "./taskCovers";
import type { VisualizerExportTask } from "./visualizerExportQueue";
import { knownVisualizerExportPoster, visualizerExportPoster } from "./visualizerExportPoster";

/**
 * Where this app serves pictures from. A library cover is asked for under the track's revision
 * in the list, the cache key every other view of that track uses, so a cover written later is
 * shown instead of the cached one.
 */
export const appCoverAddresses: TaskCoverAddresses = {
  library: (trackId, size) =>
    api.coverUrl(trackId, useLibraryStore.getState().summaryById.get(trackId)?.modified_at, size),
};

/** The revisions of these library tracks as one value, so that a memo can depend on them. */
function useTrackRevisions(ids: readonly (number | null | undefined)[]): string {
  return useLibraryStore((state) =>
    ids.map((id) => (typeof id === "number" ? state.summaryById.get(id)?.modified_at ?? "" : "")).join("|"));
}

/** The pictures of a download, from the queue to the history. */
export function useDownloadTaskCovers(task: DownloadCoverTask): string[] {
  const revision = useTrackRevisions([task.track_id]);
  // `revision` is read inside appCoverAddresses; naming it as a dependency (here and in the hooks
  // below) is what makes a new one count.
  return useMemo(() => downloadTaskCovers(task, appCoverAddresses),
    [task.cover, task.track_id, task.platform, task.source_key, revision]);
}

/**
 * The pictures of a visualizer export. The project's own picture is read from the queued
 * snapshot the first time a row asks; `pending` is true until that answer is in, so the box
 * waits for it instead of showing the song's cover and then swapping. The song comes from the
 * task, or from the snapshot for a task queued before tasks recorded it.
 */
export function useVisualizerExportCovers(task: Pick<VisualizerExportTask, "id" | "trackId">): { urls: string[]; pending: boolean } {
  const taskId = task.id;
  const [poster, setPoster] = useState(() => knownVisualizerExportPoster(taskId));
  useEffect(() => {
    let current = true;
    setPoster(knownVisualizerExportPoster(taskId));
    void visualizerExportPoster(taskId).then((value) => { if (current) setPoster(value); });
    return () => { current = false; };
  }, [taskId]);
  const trackId = task.trackId ?? poster?.trackId;
  const revision = useTrackRevisions([trackId]);
  const urls = useMemo(() => visualizerExportCovers({ poster: poster?.url, trackId }, appCoverAddresses),
    [poster, trackId, revision]);
  return { urls, pending: !poster };
}

/** A project export (剪辑, VJ) shows the cover of its project's library row. */
export function useProjectExportCovers(trackId: number): string[] {
  const revision = useTrackRevisions([trackId]);
  return useMemo(() => visualizerExportCovers({ trackId }, appCoverAddresses), [trackId, revision]);
}

/** The pictures of library tracks as a stack, in their order: a set, a playlist, a selection. */
export function useTrackCoverStack(trackIds: readonly number[], max = 3): TaskCoverStackView {
  const key = trackIds.join(",");
  const revision = useTrackRevisions(trackIds.slice(0, max));
  return useMemo(() => taskCoverStack(trackIds.map((id) => [appCoverAddresses.library(id, TASK_COVER_PX)]), max),
    [key, max, revision]);
}
