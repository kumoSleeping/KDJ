/**
 * The picture of a queued visualizer export.
 *
 * An export task records a name, a size and a path; the project it was made from — the song and
 * the pictures the user chose — is frozen beside it in the export queue's snapshot store. A task
 * row reads the first picture from there once, keeps a small copy of it for the session and shows
 * that. The snapshot is only read; nothing is written back.
 */

import { TASK_COVER_PX } from "./taskCovers";
import { loadVisualizerExportSnapshot } from "./visualizerExportQueue";

export interface VisualizerExportPoster {
  /** An object URL of the project's first picture, scaled down; "" when it could not be read. */
  url: string;
  /** The song the project belongs to, when the snapshot names one. */
  trackId: number | null;
}

/** How many exports keep their small picture. The oldest is let go beyond that. */
const MAX_POSTERS = 96;
const posters = new Map<string, VisualizerExportPoster>();
const pending = new Map<string, Promise<VisualizerExportPoster>>();
/** A snapshot holds full-size pictures, so they are read one after another. */
let lane: Promise<unknown> = Promise.resolve();

/** A copy of `picture` no larger than twice a cover box, as an object URL. */
async function small(picture: Blob): Promise<string> {
  const source = URL.createObjectURL(picture);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = source;
    await image.decode();
    const side = TASK_COVER_PX * 2;
    const scale = Math.min(1, side / Math.min(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    return blob ? URL.createObjectURL(blob) : "";
  } catch {
    // A picture this webview cannot decode has no small copy; the row falls back to the song's cover.
    return "";
  } finally {
    URL.revokeObjectURL(source);
  }
}

async function read(taskId: string): Promise<VisualizerExportPoster> {
  try {
    const draft = await loadVisualizerExportSnapshot(taskId);
    const trackId = Number(draft.project.track?.id);
    return {
      url: draft.images[0] ? await small(draft.images[0]) : "",
      trackId: Number.isFinite(trackId) && trackId > 0 ? trackId : null,
    };
  } catch {
    return { url: "", trackId: null };
  }
}

/** The poster already read for this task in this session, if any. */
export function knownVisualizerExportPoster(taskId: string): VisualizerExportPoster | undefined {
  return posters.get(taskId);
}

/** Reads the poster of one export, once per session however many rows ask. */
export function visualizerExportPoster(taskId: string): Promise<VisualizerExportPoster> {
  const known = posters.get(taskId);
  if (known) return Promise.resolve(known);
  let request = pending.get(taskId);
  if (!request) {
    request = lane.then(() => read(taskId)).then((poster) => {
      pending.delete(taskId);
      posters.set(taskId, poster);
      while (posters.size > MAX_POSTERS) {
        const [oldest, dropped] = posters.entries().next().value as [string, VisualizerExportPoster];
        posters.delete(oldest);
        if (dropped.url) URL.revokeObjectURL(dropped.url);
      }
      return poster;
    });
    lane = request.catch(() => undefined);
    pending.set(taskId, request);
  }
  return request;
}
