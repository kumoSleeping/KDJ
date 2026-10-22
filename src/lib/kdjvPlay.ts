/**
 * Playing a `.kdjv` project (docs/kdjv.md). The file is a list of local clips. Playing it asks
 * the server for its sound — the clips' sound mixed into one file, cached, seconds the first
 * time — and plays the same library row with that sound as its file, while the picture is drawn
 * live from the sources themselves (KdjvLivePicture), as the old workshop's preview did. No
 * picture is rendered to play a project; a render, made for 导出 MP4, is played instead once it
 * exists. The row stays the project: its id, title and 工程 mark do not change.
 *
 * Asking again for a project the listener left (another song was started meanwhile) only
 * finishes the mix, so the next play is immediate; it does not take the player back.
 */
import { create } from "zustand";
import { api } from "./api";
import { dismissTask, showTask } from "../components/tasks/taskBubbleStore";
import { getPlayerSession, requestPlayerCommand } from "./playerSession";
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
    .then(({ sound, render, project }) => {
      window.clearTimeout(shown);
      pending.delete(track.id);
      dismissTask(bubbleId(track.id));
      useKdjvLive.setState(({ live }) => {
        const next = { ...live };
        if (render) delete next[track.id];
        else next[track.id] = project;
        return { live: next };
      });
      if (request !== latest) return;
      play({ ...track, path: render ?? sound }, autoPlay, purpose, position);
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
 * document, and its sound (mixed again when the edit changed it) is swapped under the playing row
 * at the same position. Nothing is played anew, so the video window stays as it is.
 */
let refreshes = 0;
export async function refreshPlayingProject(trackId: number): Promise<void> {
  if (getPlayerSession().trackId !== trackId) return;
  // Only the last edit's answer is shown: an earlier one coming back late is not.
  const turn = ++refreshes;
  const preview = await api.previewKdjv(trackId).catch(() => null);
  if (!preview || turn !== refreshes || getPlayerSession().trackId !== trackId) return;
  useKdjvLive.setState(({ live }) => {
    const next = { ...live };
    if (preview.render) delete next[trackId];
    else next[trackId] = preview.project;
    return { live: next };
  });
  requestPlayerCommand({ type: "resound", trackId, path: preview.render ?? preview.sound });
}

const exportId = (trackId: number) => `kdjv-export:${trackId}`;
/** Rows being exported, by id, with their titles. */
const exporting = new Map<number, string>();

/**
 * The library's 导出 MP4 for a project row: the render (the same one playing uses), copied
 * beside the project as an MP4, with the work shown as an export bubble.
 */
export function exportProject(track: { id: number; title: string; filename: string }, options?: ExportOptions): void {
  if (exporting.has(track.id)) return;
  const title = track.title || track.filename;
  exporting.set(track.id, title);
  showTask({ id: exportId(track.id), kind: "export", title, detail: options?.audio_only ? "导出声音" : "导出 MP4", progress: 0, stay: 0 });
  void api
    .exportKdjv(track.id, options)
    .then(({ path }) => {
      showTask({ id: exportId(track.id), kind: "export", title, detail: `已导出 ${path.split(/[\\/]/).pop() ?? path}`, progress: null, tone: "success" });
    })
    .catch((error: unknown) => {
      showTask({ id: exportId(track.id), kind: "export", title: `${title} 导出失败`, detail: error instanceof Error ? error.message : String(error), progress: null, tone: "error" });
    })
    .finally(() => exporting.delete(track.id));
}

/** The server's word on a render under way (`kdjv.progress`). */
export function handleKdjvProgress(payload: KdjvProgress): void {
  const id = payload.track_id;
  if (id !== null && exporting.has(id) && !payload.error && payload.progress < 1) {
    showTask({ id: exportId(id), kind: "export", title: exporting.get(id) ?? "", detail: payload.detail || "导出 MP4",
      progress: Math.max(0, Math.min(1, payload.progress)), stay: 0 });
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
