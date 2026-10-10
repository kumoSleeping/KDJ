/**
 * 歌曲色彩: the look that colours the lyrics panel and the playing song's bubble from the
 * song's cover (SongColorBackdrop draws it). This file holds the listener's choice and finds
 * the colours of the song that is playing.
 *
 * Off is the default, and off costs nothing: the cover is only fetched and read while a
 * backdrop is on screen (`subscribeSongColorField`), and everything stops with the last one.
 */
import { create } from "zustand";
import { api } from "./api";
import { loadableCoverUrl } from "./format";
import { getPlayingTrack, subscribePlayingTrack } from "./playingTrack";
import { DEFAULT_SONG_COLOR, songColorPalette, type SongColorPalette } from "./songColorPalette";
import { songSwapEntranceDelay } from "./songSwapMotion";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";
import { isStreamTrack, streamCoverUrls, streamMeta } from "./streamTrack";
import { extractStudioPalette } from "./visualizerStudioPalette";
import type { Track } from "../types";

const STORAGE_KEY = "kd-song-color";

/** The press that last changed the choice: which way, where the key was on screen, and when. */
export interface SongColorWash {
  on: boolean;
  /** The key's centre in the window, in px: the colour spreads from there and drains to it. */
  x: number;
  y: number;
  /** performance.now() at the press. */
  at: number;
}

export function readSongColorOn(): boolean {
  return readLocalStorage(STORAGE_KEY) === "on";
}

export const useSongColor = create<{
  on: boolean;
  wash: SongColorWash | null;
  /** `key` is the control that was pressed, when there is one on screen. */
  toggle(key?: Element | null): void;
}>((set, get) => ({
  on: readSongColorOn(),
  wash: null,
  toggle(key) {
    const on = !get().on;
    const box = key?.getBoundingClientRect();
    writeLocalStorageNow(STORAGE_KEY, on ? "on" : "off");
    set({
      on,
      wash: box ? { on, x: box.left + box.width / 2, y: box.top + box.height / 2, at: performance.now() } : null,
    });
  },
}));

/** The colours of one song. `key` names the picture they were taken from, where that could be
 *  read; another key is another field, and the backdrop fades from one to the next. */
export interface SongColorField {
  key: string;
  palette: SongColorPalette;
}

/** How long a backdrop that has just been switched on waits for the cover before it shows the
 *  default instead, in ms. A cover from the library is read well inside this. */
const FIRST_FIELD_WAIT_MS = 400;
const PALETTE_CACHE = 32;

const palettes = new Map<string, SongColorPalette>();
const listeners = new Set<() => void>();
let field: SongColorField | null = null;
/** The picture the field is being changed to; a late answer for another one is dropped. */
let wanted = "";
let stopSession: (() => void) | null = null;

function publish(song: string, palette: SongColorPalette): void {
  const next = { key: `${song}|${palette.source}`, palette };
  if (field?.key === next.key) return;
  field = next;
  for (const listener of listeners) listener();
}

/** Whose cover it is and which revision: another value is another picture. */
export function songColorKey(track: Track | null): string {
  if (!track) return "none";
  if (!isStreamTrack(track)) return `library:${track.id}:${track.modified_at ?? ""}`;
  return `stream:${track.id}:${streamMeta(track)?.cover ?? ""}`;
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try { return await loadImage(url, false); } finally { URL.revokeObjectURL(url); }
}

function loadImage(url: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // A picture from another origin can only be read back when its server allows it; without
    // this the canvas it is drawn on is tainted and the read throws.
    if (cors) { image.crossOrigin = "anonymous"; image.referrerPolicy = "no-referrer"; }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("cover"));
    image.src = url;
  });
}

async function coverColours(track: Track): Promise<readonly { color: string; share: number }[] | null> {
  // The extractor is the visualizer's: the colours of a picture and the share each covers.
  const read = (image: ImageBitmap | HTMLImageElement) => {
    try { return extractStudioPalette(image).colors; } finally { if ("close" in image) image.close(); }
  };
  if (!isStreamTrack(track)) {
    // The thumbnail the list already asked for; the local server answers this origin with
    // CORS headers, so the pixels can be read.
    const response = await fetch(api.coverUrl(track.id, track.modified_at, 64));
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/")) return null;
    return read(await decode(await response.blob()));
  }
  for (const url of streamCoverUrls(track)) {
    try { return read(await loadImage(url, true)); } catch { /* the next address, then the proxy */ }
  }
  // A provider whose image server sends no CORS headers: the two the backend can fetch for us.
  const meta = streamMeta(track), platform = meta?.source?.platform;
  if (meta?.cover && (platform === "wyy" || platform === "qqm")) {
    return read(await decode(await api.onlineCover(platform, loadableCoverUrl(meta.cover.trim()))));
  }
  return null;
}

function remember(key: string, palette: SongColorPalette): void {
  palettes.delete(key);
  palettes.set(key, palette);
  if (palettes.size > PALETTE_CACHE) palettes.delete(palettes.keys().next().value as string);
}

function startSession(): () => void {
  let timer = 0, firstWait = 0;
  const show = (key: string, palette: SongColorPalette, enterAt: number) => {
    window.clearTimeout(timer);
    // The colours of the next song come in when what belongs to the last one has left
    // (src/lib/songSwapMotion.ts); until then, and until they are known, the last ones stay.
    timer = window.setTimeout(() => {
      window.clearTimeout(firstWait);
      if (wanted === key) publish(key, palette);
    }, Math.max(0, enterAt - performance.now()));
  };
  const follow = () => {
    const track = getPlayingTrack(), key = songColorKey(track);
    if (key === wanted) return;
    wanted = key;
    const enterAt = field ? performance.now() + songSwapEntranceDelay() : 0;
    const known = palettes.get(key);
    if (known || !track) { show(key, known ?? DEFAULT_SONG_COLOR, enterAt); return; }
    void coverColours(track).catch(() => null).then(colours => {
      if (wanted !== key) return;
      // No cover, or one whose pixels cannot be read (an image server without CORS headers
      // that the backend does not fetch for us): the calm default, and it is asked again the
      // next time the song plays.
      if (!colours?.length) { show(key, DEFAULT_SONG_COLOR, enterAt); return; }
      const palette = songColorPalette(colours);
      remember(key, palette);
      show(key, palette, enterAt);
    });
  };
  // A backdrop that is switched on shows something soon, whatever the cover does.
  if (!field) {
    firstWait = window.setTimeout(() => { if (!field) publish(wanted, DEFAULT_SONG_COLOR); }, FIRST_FIELD_WAIT_MS);
  }
  wanted = "";
  // A song whose colours are already known is there at once.
  const start = getPlayingTrack(), startKey = songColorKey(start);
  const ready = palettes.get(startKey);
  if (ready) { wanted = startKey; field = { key: `${startKey}|${ready.source}`, palette: ready }; window.clearTimeout(firstWait); }
  else follow();
  const unsubscribeTrack = subscribePlayingTrack(follow);
  return () => {
    unsubscribeTrack();
    window.clearTimeout(timer);
    window.clearTimeout(firstWait);
    field = null;
    wanted = "";
  };
}

/**
 * The colours of the playing song, for as long as someone is subscribed. Null until the first
 * colours are known (a few frames; `FIRST_FIELD_WAIT_MS` at most).
 */
export function getSongColorField(): SongColorField | null {
  return field;
}

export function subscribeSongColorField(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopSession) stopSession = startSession();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopSession) {
      stopSession();
      stopSession = null;
    }
  };
}

/** Whether anything is reading covers right now: false whenever no backdrop is on screen. */
export function songColorSessionRunning(): boolean {
  return stopSession !== null;
}
