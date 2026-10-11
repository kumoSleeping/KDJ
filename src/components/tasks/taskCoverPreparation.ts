import { useEffect, useState } from "react";
import { COVER_RETRY_MS } from "../../lib/coverLoad";
import { TASK_COVER_LIMIT, type TaskCover } from "./taskBubbleSchema";

/** A slow or broken cover must not keep a notification (or the only transport) waiting. */
const COVER_READY_MS = 1_500;
const CACHE_LIMIT = 24;

type PreparedCover = {
  image: HTMLImageElement | null;
  ready: boolean;
  retryAt: number;
  done: Promise<void>;
};

// Keep the decoded image, not just its URL, until the bubble has taken it. The small shared
// cache also joins a song's early preparation to the host's request, without a second fetch.
const prepared = new Map<string, PreparedCover>();
const addresses = (cover: TaskCover): readonly string[] => typeof cover === "string" ? [cover] : cover.urls;
const addressKey = (cover: TaskCover): string => JSON.stringify(addresses(cover));

function decodeCover(url: string, timeout: number): Promise<HTMLImageElement | null> {
  if (typeof Image !== "function" || timeout <= 0) return Promise.resolve(null);
  return new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = image.onerror = null;
      if (!loaded) image.removeAttribute("src");
      resolve(loaded ? image : null);
    };
    const timer = window.setTimeout(() => finish(false), timeout);
    image.referrerPolicy = "no-referrer";
    image.fetchPriority = "high";
    image.decoding = "async";
    image.onload = () => {
      if (typeof image.decode === "function") void image.decode().then(() => finish(true), () => finish(false));
      else finish(image.naturalWidth > 0);
    };
    image.onerror = () => finish(false);
    image.src = url;
  });
}

function knownCover(cover: TaskCover): PreparedCover | undefined {
  const known = prepared.get(addressKey(cover));
  // Failed covers can be tried on the next opening, but not on every progress/lyric update.
  return known && (!known.ready || known.image || performance.now() < known.retryAt) ? known : undefined;
}

function prepareCover(cover: TaskCover): PreparedCover {
  const key = addressKey(cover);
  const known = knownCover(cover);
  if (known) {
    prepared.delete(key);
    prepared.set(key, known);
    return known;
  }
  const entry: PreparedCover = { image: null, ready: false, retryAt: 0, done: Promise.resolve() };
  prepared.set(key, entry);
  while (prepared.size > CACHE_LIMIT) prepared.delete(prepared.keys().next().value!);
  const urls = [...new Set(addresses(cover).filter(Boolean))];
  entry.done = (async () => {
    const until = performance.now() + COVER_READY_MS;
    for (let index = 0; index < urls.length; index += 1) {
      // Leave time for the original when a thumbnail server hangs, not only when it refuses.
      entry.image = await decodeCover(urls[index], (until - performance.now()) / (urls.length - index));
      if (entry.image) break;
    }
    entry.ready = true;
    entry.retryAt = performance.now() + COVER_RETRY_MS;
  })();
  return entry;
}

function readyCover(cover: TaskCover, entry: PreparedCover): TaskCover {
  return {
    key: typeof cover === "string" ? cover : cover.key,
    // Start at the address that actually decoded; do not retry a refused thumbnail on mount.
    // A failed/timed-out preparation keeps its no-cover face for this arrival, rather than
    // popping a late image into the middle of a bubble that has already arrived.
    urls: entry.image ? [entry.image.src] : [],
  };
}

/** Start before the entrance/old song's exit. All visible covers prepare in parallel. */
export async function prepareTaskCovers(covers: readonly TaskCover[]): Promise<readonly TaskCover[]> {
  return Promise.all(covers.map(async (cover, index) => {
    if (index >= TASK_COVER_LIMIT) return cover;
    const entry = prepareCover(cover);
    await entry.done;
    return readyCover(cover, entry);
  }));
}

/** Null until the visible covers have decoded or are known to be unavailable. */
export function usePreparedTaskCovers(covers: readonly TaskCover[]): readonly TaskCover[] | null {
  const key = JSON.stringify(covers);
  const [result, setResult] = useState<{ key: string; covers: readonly TaskCover[] } | null>(null);
  useEffect(() => {
    let current = true;
    void prepareTaskCovers(covers).then(value => { if (current) setResult({ key, covers: value }); });
    return () => { current = false; };
  }, [key]);
  if (result?.key === key) return result.covers;
  const known = covers.slice(0, TASK_COVER_LIMIT).map(knownCover);
  if (known.some(entry => !entry?.ready)) return null;
  return covers.map((cover, index) => index < TASK_COVER_LIMIT ? readyCover(cover, known[index]!) : cover);
}
