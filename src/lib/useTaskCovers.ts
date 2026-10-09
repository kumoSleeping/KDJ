/**
 * The task pictures of `taskCovers.ts`, bound to this app's addresses and memoised for rows.
 *
 * A list is only recomputed when a field it is derived from changes: a row is rendered again on
 * every progress tick of its task, and its cover must keep the very addresses it already loaded.
 */

import { useEffect, useMemo, useState } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import type { CompositionProject, WorkshopJob } from "../types/workshop";
import { api } from "./api";
import {
  TASK_COVER_PX,
  downloadTaskCovers,
  taskCoverStack,
  visualizerExportCovers,
  workshopExportCovers,
  type DownloadCoverTask,
  type TaskCoverAddresses,
  type TaskCoverStackView,
} from "./taskCovers";
import { knownVisualizerExportPoster, visualizerExportPoster } from "./visualizerExportPoster";

/**
 * Where this app serves pictures from. A library cover is asked for under the track's revision
 * in the list, the cache key every other view of that track uses, so a cover written later is
 * shown instead of the cached one.
 */
export const appCoverAddresses: TaskCoverAddresses = {
  library: (trackId, size) =>
    api.coverUrl(trackId, useLibraryStore.getState().summaryById.get(trackId)?.modified_at, size),
  frame: (projectId, sourceId, ms) => api.workshopFrameUrl(projectId, sourceId, ms),
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

/** The pictures of a mixing-editor export as a stack: its sources, or the finished file alone. */
export function useWorkshopExportCovers(project: CompositionProject | undefined, job: WorkshopJob | undefined): TaskCoverStackView {
  const sources = project?.sources;
  const layers = project?.layers;
  // The addresses follow from which sources the clips use and where each starts, not from the
  // rest of an edit; the key keeps a drag on the timeline from handing the cover a new list.
  const shape = useMemo(() => !sources || !layers ? "" : [
    sources.map((source) => `${source.id}:${source.track_id}:${source.video}:${source.kind ?? ""}`).join(","),
    layers.flatMap((layer) => layer.clips).map((clip) => `${clip.source_id}@${clip.source_in_ms}`).join(","),
  ].join("|"), [sources, layers]);
  const revision = useTrackRevisions([job?.track_id, ...(sources ?? []).map((source) => source.track_id)]);
  return useMemo(() => taskCoverStack(workshopExportCovers(project, job, appCoverAddresses)),
    [project?.id, shape, job?.track_id, revision]);
}

/**
 * The pictures of a visualizer export. The project's own picture is read from the queued
 * snapshot the first time a row asks; `pending` is true until that answer is in, so the box
 * waits for it instead of showing the song's cover and then swapping.
 */
export function useVisualizerExportCovers(taskId: string): { urls: string[]; pending: boolean } {
  const [poster, setPoster] = useState(() => knownVisualizerExportPoster(taskId));
  useEffect(() => {
    let current = true;
    setPoster(knownVisualizerExportPoster(taskId));
    void visualizerExportPoster(taskId).then((value) => { if (current) setPoster(value); });
    return () => { current = false; };
  }, [taskId]);
  const revision = useTrackRevisions([poster?.trackId]);
  const urls = useMemo(() => visualizerExportCovers({ poster: poster?.url, trackId: poster?.trackId }, appCoverAddresses),
    [poster, revision]);
  return { urls, pending: !poster };
}

/** The pictures of library tracks as a stack, in their order: a set, a playlist, a selection. */
export function useTrackCoverStack(trackIds: readonly number[], max = 3): TaskCoverStackView {
  const key = trackIds.join(",");
  const revision = useTrackRevisions(trackIds.slice(0, max));
  return useMemo(() => taskCoverStack(trackIds.map((id) => [appCoverAddresses.library(id, TASK_COVER_PX)]), max),
    [key, max, revision]);
}
