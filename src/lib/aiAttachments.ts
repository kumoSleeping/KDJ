/**
 * What the listener drags or pastes into Agent Mode (docs/ai-dock.md): songs and videos from the
 * library, the search results, the computer's own files, and pictures. Each becomes a card above the field and goes
 * to the AI with the request, in a `<kdj-attachments>` block (kdj-prompt.md): where the thing
 * is, how long it is, and the time the listener marked on it — the range held on the waveform
 * (Shift + drag, playRange.ts) or, for the song that is playing, where it is now.
 */
import { api } from "./api";
import { formatDuration } from "./format";
import { getPlayerSession } from "./playerSession";
import { getPlayingTrack } from "./playingTrack";
import { usePlayRange } from "./playRange";
import { firstSourceShareLink } from "./shareLink";
import { streamMeta } from "./streamTrack";
import type { ActiveSearchDrag } from "./searchDrag";
import type { SongSource, TrackSummary, VideoDownloadRequest } from "../types";
import { isImageTrack, isVideoTrack } from "./format";

export interface AiAttachment {
  /** One card per thing: the same song dropped twice is one card. */
  key: string;
  kind: "local" | "online" | "file";
  video: boolean;
  /** A picture: the model is shown it with the request (kdj-server reads it from `path`). */
  image?: boolean;
  title: string;
  artist?: string;
  cover?: string;
  /** Seconds. */
  duration?: number;
  trackId?: number;
  path?: string;
  url?: string;
  platform?: string;
  /** Where the song is playing now (seconds), when it is the one playing and no range is held. */
  at?: number;
  /** The range held on the waveform (seconds). */
  range?: { start: number; end: number };
}

/** The marker of the field that takes drops (SearchBar, Agent Mode only). */
export const AI_DROP_ATTR = "data-kd-ai-drop";

/** The Agent Mode field under the pointer, if any. */
export function aiDropElementAt(x: number, y: number): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const hit = document.elementFromPoint(x, y);
  return hit instanceof Element ? hit.closest<HTMLElement>(`[${AI_DROP_ATTR}]`) : null;
}

/** What the time on a card reads: "1:23–1:41", "@ 1:23", or nothing. */
export function timeLabel(item: AiAttachment): string | null {
  if (item.range) return `${formatDuration(item.range.start)}–${formatDuration(item.range.end)}`;
  if (item.at !== undefined) return `@ ${formatDuration(item.at)}`;
  return null;
}

/** The time marked on whatever is playing, when `matches` says it is this thing. */
function markedTime(matches: (playing: ReturnType<typeof getPlayingTrack>) => boolean): Pick<AiAttachment, "at" | "range"> {
  const playing = getPlayingTrack();
  if (!playing || !matches(playing)) return {};
  const range = usePlayRange.getState().range;
  if (range && range.trackId === playing.id) return { range: { start: range.start, end: range.end } };
  const session = getPlayerSession();
  return session.trackId === playing.id && Number.isFinite(session.position) ? { at: session.position } : {};
}

export function fromLocalTracks(tracks: readonly TrackSummary[]): AiAttachment[] {
  return tracks.map(track => ({
    key: `local:${track.id}`,
    kind: "local",
    video: isVideoTrack(track.format),
    title: track.title || track.filename,
    artist: track.artist || undefined,
    cover: api.coverUrl(track.id, track.modified_at, 96),
    duration: track.duration ?? undefined,
    trackId: track.id,
    path: track.path,
    ...markedTime(playing => playing?.id === track.id),
  }));
}

const sameSource = (a: SongSource | null | undefined, b: SongSource) => Boolean(a && a.platform === b.platform && a.key === b.key);

function videoUrl(request: VideoDownloadRequest): string | undefined {
  if (request.url) return request.url;
  if (!request.bvid) return undefined;
  if (request.platform === "youtube") return `https://www.youtube.com/watch?v=${request.bvid}`;
  const page = request.page_index ? `?p=${request.page_index + 1}` : "";
  return `https://www.bilibili.com/video/${request.bvid}${page}`;
}

export function fromSearchDrag(drag: ActiveSearchDrag): AiAttachment[] {
  if (drag.kind === "video") {
    const url = videoUrl(drag.request);
    return [{
      key: `online:${url ?? drag.title ?? ""}`,
      kind: "online",
      video: true,
      title: drag.title || drag.request.page_title || url || "视频",
      artist: drag.artist,
      cover: drag.cover,
      url,
      platform: drag.request.platform ?? "bilibili",
    }];
  }
  const first = drag.sources[0];
  if (!first) return [];
  const url = firstSourceShareLink(drag.sources) ?? undefined;
  return [{
    key: `online:${first.platform}:${first.key}`,
    kind: "online",
    video: false,
    title: first.title,
    artist: first.artists?.join(" / ") || undefined,
    cover: first.cover || undefined,
    duration: first.duration ?? undefined,
    url,
    platform: first.platform,
    ...markedTime(playing => drag.sources.some(source => sameSource(streamMeta(playing)?.source, source))),
  }];
}

export function fromFiles(paths: readonly string[]): AiAttachment[] {
  return paths.map(path => {
    const name = path.split(/[\\/]/).pop() || path;
    const extension = name.split(".").pop() ?? "";
    return {
      key: `file:${path}`,
      kind: "file",
      video: isVideoTrack(extension),
      image: isImageTrack(extension) || undefined,
      title: name,
      path,
    };
  });
}

/** A pasted picture, kept in the AI's workspace at `path`; `preview` shows it on its card. */
export function fromPastedImage(path: string, preview: string): AiAttachment {
  return { key: `file:${path}`, kind: "file", video: false, image: true, title: "粘贴的图片", path, cover: preview };
}

/** The pictures that go with a request, by path. */
export function imagesOf(items: readonly AiAttachment[]): string[] {
  return items.filter(item => item.image && item.path).map(item => item.path!);
}

/**
 * The request as the AI gets it: the listener's words, then one JSON line per card. Times are
 * seconds; the AI's prompt says how to read them.
 */
export function withAttachments(text: string, items: readonly AiAttachment[]): string {
  if (items.length === 0) return text;
  const lines = items.map(item => JSON.stringify({
    kind: item.image ? "image" : item.video ? "video" : "audio",
    title: item.title,
    artist: item.artist,
    track_id: item.trackId,
    path: item.path,
    url: item.url,
    platform: item.platform,
    duration: item.duration,
    at: item.at,
    range: item.range ? [item.range.start, item.range.end] : undefined,
  }));
  return `${text}\n\n<kdj-attachments>\n${lines.join("\n")}\n</kdj-attachments>`;
}
