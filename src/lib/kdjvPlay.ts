/**
 * Playing a `.kdjv` project (docs/kdjv.md). The file is a list of local clips; KDJ plays its
 * render, made once by the server into its cache. Playing a project asks for the render — at
 * once when it is cached, after a while when it is not, with the work shown as a task bubble —
 * and then plays the same library row with the render as its file. The row stays the project:
 * its id, title and 工程 mark do not change.
 *
 * Asking again for a project the listener left (another song was started meanwhile) only
 * finishes the render, so the next play is immediate; it does not take the player back.
 */
import { api } from "./api";
import { dismissTask, showTask } from "../components/tasks/taskBubbleStore";
import type { KdjvProgress, PlayableTrack } from "../types";

type Play = (track: PlayableTrack, autoPlay?: boolean, purpose?: "composition", position?: number) => number;

/** A project row whose file is still the project, not its render. */
export function needsRender(track: PlayableTrack): boolean {
  return /\.kdjv$/i.test(track.path);
}

/** Bumped by every play: a render that finishes after another play does not start itself. */
let latest = 0;
export function notePlay(): void {
  latest += 1;
}

const bubbleId = (trackId: number) => `kdjv:${trackId}`;
/** Rows whose render is under way, by id: progress events find their bubble here. */
const pending = new Map<number, string>();
/** A cached render answers at once; the bubble only comes up for one that takes a while. */
const BUBBLE_DELAY_MS = 400;

export function playProject(track: PlayableTrack, play: Play, autoPlay = true, purpose?: "composition", position?: number): void {
  const request = ++latest;
  const title = track.title || track.filename;
  pending.set(track.id, title);
  const shown = window.setTimeout(() => {
    if (pending.has(track.id)) showTask({ id: bubbleId(track.id), kind: "render", title, detail: "准备工程", progress: 0, stay: 0 });
  }, BUBBLE_DELAY_MS);
  void api
    .renderKdjv(track.id)
    .then(({ path }) => {
      window.clearTimeout(shown);
      pending.delete(track.id);
      dismissTask(bubbleId(track.id));
      if (request !== latest) return;
      play({ ...track, path }, autoPlay, purpose, position);
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

/** The server's word on a render under way (`kdjv.progress`). */
export function handleKdjvProgress(payload: KdjvProgress): void {
  const id = payload.track_id;
  if (id === null || !pending.has(id) || payload.error) return;
  showTask({
    id: bubbleId(id),
    kind: "render",
    title: pending.get(id) ?? "",
    detail: payload.detail || "准备工程",
    progress: Math.max(0, Math.min(1, payload.progress)),
    stay: 0,
  });
}
