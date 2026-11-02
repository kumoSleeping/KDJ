/**
 * The editor's frames along a video clip (LaneBoard `ClipFrames`): small JPEGs of a project's
 * source decoded in this window with the system decoder (codecFrames.ts), as a library video's
 * cover is. Kept in memory by file and second, a few decodes at a time, the most recent files
 * kept open.
 */
import { openVideoFrames, type VideoFrames } from "./codecFrames";

/** Decodes at once: the strip asks for dozens as it scrolls in. */
const CONCURRENT = 2;
const FRAMES_KEPT = 600;
const FILES_OPEN = 4;

const frames = new Map<string, Promise<string | null>>();
const files = new Map<string, Promise<VideoFrames>>();
let active = 0;
const waiting: Array<() => void> = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENT) await new Promise<void>(resolve => waiting.push(resolve));
  active++;
  try { return await work(); } finally {
    active--;
    waiting.shift()?.();
  }
}

function opened(url: string, file: string, width: number): Promise<VideoFrames> {
  const key = `${file}|${width}`;
  let found = files.get(key);
  if (found) {
    // Most recent last.
    files.delete(key);
    files.set(key, found);
    return found;
  }
  found = openVideoFrames(url, width);
  found.catch(() => files.delete(key));
  files.set(key, found);
  while (files.size > FILES_OPEN) {
    const [oldest] = files.keys();
    void files.get(oldest)?.then(f => f.dispose(), () => undefined);
    files.delete(oldest);
  }
  return found;
}

/**
 * An object URL of the frame of `file` (a project source's name and signature, read from `url`)
 * at `at` seconds, `width` pixels wide; null when it cannot be decoded.
 */
export function stripFrame(url: string, file: string, at: number, width: number): Promise<string | null> {
  const key = `${file}|${at}|${width}`;
  let found = frames.get(key);
  if (found) return found;
  found = slot(async () => {
    const jpeg = await (await opened(url, file, width)).jpeg(at);
    return jpeg ? URL.createObjectURL(jpeg) : null;
  }).catch(() => null);
  frames.set(key, found);
  while (frames.size > FRAMES_KEPT) {
    const [oldest] = frames.keys();
    void frames.get(oldest)?.then(href => { if (href) URL.revokeObjectURL(href); });
    frames.delete(oldest);
  }
  return found;
}

/** Which of the project's sources (`file`: its path, then `#` and its signature) the document's
 *  `src` names: relative names are in the project's folder. -1 when none does. */
export function sourceOf(sources: ReadonlyArray<{ file?: string }>, projectPath: string, src: string): number {
  const slash = (path: string) => path.replace(/\\/g, "/").replace(/\/\.\//g, "/");
  const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(src);
  const folder = slash(projectPath).replace(/\/[^/]*$/, "");
  const wanted = slash(absolute ? src : `${folder}/${src.replace(/^\.[\\/]/, "")}`);
  const paths = sources.map(source => slash((source.file ?? "").replace(/#[^#]*$/, "")));
  const exact = paths.findIndex(path => path === wanted);
  if (exact >= 0) return exact;
  // The server resolves links and `..`: the file's own name, when only one source has it.
  const name = wanted.split("/").pop() ?? "";
  const same = paths.flatMap((path, n) => path.split("/").pop() === name ? [n] : []);
  return same.length === 1 ? same[0] : -1;
}
