/**
 * The pictures a task row can show.
 *
 * A row in the download queue, the download history, the export queue or the finished exports is
 * given every address that can show a picture of its task, best first, and the cover box
 * (`TaskCover`) walks down that list through `useCoverLoad`. This file only derives the lists.
 * It knows nothing about the backend's addresses — those come in as `TaskCoverAddresses` — so the
 * derivation is the same in the app and in a test.
 */

import type { DownloadTask } from "../types";
import { onlineCoverUrls } from "./format";

/** The longest side asked for. A row's box is 3rem; this covers it on a 2x screen. */
export const TASK_COVER_PX = 96;

/** The addresses of pictures the app serves itself. */
export interface TaskCoverAddresses {
  /** The sized thumbnail of a library track: its embedded cover, or a frame when it is a video. */
  library(trackId: number, size: number): string;
}

/** What a box draws when no address loads: the glyph of what the task makes. */
export type TaskCoverKind = "song" | "video" | "mix" | "visualizer" | "set";

/** The addresses in order, without blanks and without repeats. */
function distinct(urls: readonly string[]): string[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
}

const libraryCover = (trackId: number | null | undefined, at: TaskCoverAddresses, size: number): string =>
  typeof trackId === "number" && trackId > 0 ? at.library(trackId, size) : "";

/**
 * A thumbnail that follows from the platform and the source's public id alone. Only YouTube
 * publishes one at a fixed address; the other platforms need the search result's own cover.
 */
export function platformThumbnail(platform: string, sourceKey: string | null | undefined): string {
  const key = sourceKey?.trim() ?? "";
  if ((platform === "youtube" || platform === "ytm") && /^[\w-]{11}$/.test(key)) {
    return `https://i.ytimg.com/vi/${key}/mqdefault.jpg`;
  }
  return "";
}

/**
 * A download, from the moment it is queued to its line in the history: the cover it was searched
 * with (small rendition, then as the provider gave it), the library's picture of the file once it
 * has been imported, and last the platform's own thumbnail.
 */
export function downloadTaskCovers(
  task: DownloadCoverTask,
  at: TaskCoverAddresses,
  size = TASK_COVER_PX,
): string[] {
  return distinct([
    ...onlineCoverUrls(task.cover ?? "", size),
    libraryCover(task.track_id, at, size),
    platformThumbnail(task.platform, task.source_key),
  ]);
}

/**
 * A visualizer export: the project's own picture (`poster`, read from the queued snapshot) and
 * then the cover of the song it was made for.
 */
export function visualizerExportCovers(
  source: { poster?: string; trackId?: number | null },
  at: TaskCoverAddresses,
  size = TASK_COVER_PX,
): string[] {
  return distinct([source.poster ?? "", libraryCover(source.trackId, at, size)]);
}

/** The fields of a download that its pictures and its no-picture glyph follow from. */
export type DownloadCoverTask = Pick<DownloadTask, "cover" | "track_id" | "platform" | "source_key">
  & Partial<Pick<DownloadTask, "kind" | "quality">>;

/** Any task of the four pages, for code that handles them together (a batch, a notification). */
export type TaskCoverSubject =
  | { kind: "download"; task: DownloadCoverTask }
  | { kind: "visualizer"; poster?: string; trackId?: number | null }
  | { kind: "track"; trackId: number; video?: boolean };

/** One list for one task. A mix that is still shown by its sources gives all of their addresses. */
export function taskCovers(subject: TaskCoverSubject, at: TaskCoverAddresses, size = TASK_COVER_PX): string[] {
  switch (subject.kind) {
    case "download": return downloadTaskCovers(subject.task, at, size);
    case "visualizer": return visualizerExportCovers(subject, at, size);
    case "track": return distinct([libraryCover(subject.trackId, at, size)]);
  }
}

/** The glyph a task's box falls back to. A video download that only keeps the sound is a song. */
export function taskCoverKind(subject: TaskCoverSubject): TaskCoverKind {
  switch (subject.kind) {
    case "download": return subject.task.kind === "video" && subject.task.quality?.toLowerCase() !== "audio" ? "video" : "song";
    case "visualizer": return "visualizer";
    case "track": return subject.video ? "video" : "song";
  }
}

export interface TaskCoverStackView {
  /** One list of addresses per picture shown, front first. Never longer than `max`. */
  covers: string[][];
  /** How many tasks of the batch are not among the pictures shown. */
  more: number;
}

/**
 * The few pictures that stand for a batch of tasks. `lists` holds one list of addresses per task,
 * in the batch's order. Tasks with the same picture (an album's songs) share one place, and tasks
 * without any are counted in `more`; a batch with no picture at all keeps one empty place so that
 * its box draws the no-picture face.
 */
export function taskCoverStack(lists: readonly (readonly string[])[], max = 3): TaskCoverStackView {
  const limit = Math.max(1, Math.floor(max));
  const covers: string[][] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (covers.length >= limit) break;
    const urls = distinct(list);
    const key = urls.join("\n");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    covers.push(urls);
  }
  if (covers.length === 0 && lists.length > 0) covers.push([]);
  return { covers, more: lists.length - covers.length };
}
