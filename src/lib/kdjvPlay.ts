/**
 * Playing a `.kdjv` project (docs/kdjv.md). The file is a list of local clips. Playing it asks
 * the server for its sound — the clips' sound mixed into one file, cached, seconds the first
 * time — and plays the same library row with that sound as its file, while the picture is drawn
 * live from the sources themselves (KdjvLivePicture), as the old workshop's preview did. No
 * picture is rendered to play a project, and a render made for 导出 MP4 is not played either: it
 * is keyed every few seconds, so each start and jump decoded seconds of it and fell behind the
 * sound, and the picture was handed between decoders around the ninth second; the live picture
 * reads proxies keyed every half second. The row stays the project: its id, title and 工程 mark
 * do not change.
 *
 * Asking again for a project the listener left (another song was started meanwhile) only
 * finishes the mix, so the next play is immediate; it does not take the player back.
 */
import { create } from "zustand";
import { api } from "./api";
import { dismissTask, showTask } from "../components/tasks/taskBubbleStore";
import { getPlayerSession, requestPlayerCommand } from "./playerSession";
import { useProjectExportStore } from "../stores/projectExportStore";
import type { KdjvLive, KdjvProgress, PlayableTrack } from "../types";
import type { ExportOptions } from "./lanes";

type Play = (track: PlayableTrack, autoPlay?: boolean, purpose?: "composition", position?: number) => number;

/** A project row whose file is still the project, not its sound or render. */
export function needsRender(track: PlayableTrack): boolean {
  return /\.kdjv$/i.test(track.path);
}

/** The projects playing from their sound, by row id: their video surfaces draw them live. */
export const useKdjvLive = create<{ live: Record<number, KdjvLive> }>(() => ({ live: {} }));

/** Bumped by every play: a mix that finishes after another play does not start itself. */
let latest = 0;
export function notePlay(): void {
  latest += 1;
}

const bubbleId = (trackId: number) => `kdjv:${trackId}`;
/** Rows whose sound is under way, by id: progress events find their bubble here. */
const pending = new Map<number, string>();
/** A cached sound answers at once; the bubble only comes up for one that takes a while. */
const BUBBLE_DELAY_MS = 400;

export function playProject(track: PlayableTrack, play: Play, autoPlay = true, purpose?: "composition", position?: number): void {
  const request = ++latest;
  const title = track.title || track.filename;
  pending.set(track.id, title);
  const shown = window.setTimeout(() => {
    if (pending.has(track.id)) showTask({ id: bubbleId(track.id), kind: "render", title, detail: "准备工程", progress: 0, stay: 0 });
  }, BUBBLE_DELAY_MS);
  void api
    .previewKdjv(track.id)
    .then(({ sound, project }) => {
      window.clearTimeout(shown);
      pending.delete(track.id);
      dismissTask(bubbleId(track.id));
      useKdjvLive.setState(({ live }) => ({ live: { ...live, [track.id]: project } }));
      if (request !== latest) return;
      play({ ...track, path: sound }, autoPlay, purpose, position);
    })
    .catch((error: unknown) => {
      window.clearTimeout(shown);
      pending.delete(track.id);
      showTask({
        id: bubbleId(track.id),
        kind: "render",
        title: `${title} 无法播放`,
        detail: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    });
}

/**
 * A project edited while it plays shows the edit where it is: its picture is drawn from the new
 * document at once (`live`, the edit's own answer), and its sound — the same file when only the
 * picture changed, else mixed again from the cached pieces that did not change — is swapped under
 * the playing row at the same position when it is ready. Nothing is played anew, so the video
 * window stays as it is.
 */
let refreshes = 0;
/**
 * The clips drawn for the row: the same object while nothing in them changed, so the picture
 * keeps its decoders as they are (a new one, even equal, starts every clip settling again).
 */
function showLive(trackId: number, project: KdjvLive): void {
  const now = useKdjvLive.getState().live[trackId];
  if (now && JSON.stringify(now) === JSON.stringify(project)) return;
  useKdjvLive.setState(({ live }) => ({ live: { ...live, [trackId]: project } }));
}
export async function refreshPlayingProject(trackId: number, live?: KdjvLive | null): Promise<void> {
  if (getPlayerSession().trackId !== trackId) return;
  // Only the last edit's answer is shown: an earlier one coming back late is not.
  const turn = ++refreshes;
  if (live) showLive(trackId, live);
  const preview = await api.previewKdjv(trackId).catch(() => null);
  if (!preview || turn !== refreshes || getPlayerSession().trackId !== trackId) return;
  showLive(trackId, preview.project);
  requestPlayerCommand({ type: "resound", trackId, path: preview.sound });
}

/** Rows whose live picture is being asked for (ensureProjectLive). */
const fetching = new Set<number>();
/**
 * A project row shown without its live picture — the window was loaded again while the player
 * went on with its sound — gets it, without playing anything. Nothing is loaded as a video for a
 * project meanwhile.
 */
export function ensureProjectLive(trackId: number): void {
  if (useKdjvLive.getState().live[trackId] || fetching.has(trackId)) return;
  fetching.add(trackId);
  void api.previewKdjv(trackId)
    .then(preview => showLive(trackId, preview.project))
    .catch(() => undefined)
    .finally(() => fetching.delete(trackId));
}

/**
 * A source's preview proxy is made: the projects drawn live that use it get their picture again,
 * which now loads the proxy. Only the picture: the sound playing is not touched.
 */
export function handleKdjvProxy(source: string): void {
  for (const [id, project] of Object.entries(useKdjvLive.getState().live)) {
    if (!project.sources.some(s => s.file?.startsWith(`${source}#`) && !s.proxy)) continue;
    const trackId = Number(id);
    void api.previewKdjv(trackId).then(preview => {
      if (useKdjvLive.getState().live[trackId]) showLive(trackId, preview.project);
    }).catch(() => undefined);
  }
}

/**
 * 导出 for a project row (the editor's, the library's 导出 MP4): a task in the export queue
 * (下载 → 导出), which renders it, copies it beside the project, can be paused there, and stops
 * when the project is changed meanwhile. Its bubble is the queue's.
 */
export function exportProject(track: { id: number; title: string; filename: string; path: string }, options?: ExportOptions): void {
  void useProjectExportStore.getState().enqueue(track, options);
}

/** The server's word on a render under way (`kdjv.progress`). */
export function handleKdjvProgress(payload: KdjvProgress): void {
  const id = payload.track_id;
  const task = payload.export;
  if (task) {
    if (!payload.error && payload.progress < 1) useProjectExportStore.getState().progress(task, payload.progress, payload.detail);
    return;
  }
  if (id === null || !pending.has(id) || payload.error) return;
  showTask({
    id: bubbleId(id),
    kind: "render",
    title: pending.get(id) ?? "",
    detail: payload.detail || "预渲染工程",
    progress: Math.max(0, Math.min(1, payload.progress)),
    stay: 0,
  });
}
