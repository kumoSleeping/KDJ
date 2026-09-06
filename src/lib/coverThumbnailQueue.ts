const MAX_ACTIVE_COVER_REQUESTS = 2;
const MAX_CACHED_COVERS = 128;

interface CacheEntry {
  objectUrl: string;
  refs: number;
}

interface Client {
  released: boolean;
  priority: number;
  cacheKey: string | null;
  resolve(value: string): void;
  reject(reason: unknown): void;
}

interface CoverTask {
  key: string;
  url: string;
  started: boolean;
  controller: AbortController | null;
  clients: Set<Client>;
}

export interface CoverThumbnailLease {
  promise: Promise<string>;
  release(): void;
  setPriority(priority: number): void;
}

const cache = new Map<string, CacheEntry>();
const tasks = new Map<string, CoverTask>();
const queue: CoverTask[] = [];
let active = 0;

function evictUnused(): void {
  while (cache.size > MAX_CACHED_COVERS) {
    const victim = [...cache.entries()].find(([, entry]) => entry.refs === 0);
    if (!victim) return;
    cache.delete(victim[0]);
    URL.revokeObjectURL(victim[1].objectUrl);
  }
}

function releaseCache(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  evictUnused();
}

function finishTask(task: CoverTask): void {
  if (tasks.get(task.key) === task) tasks.delete(task.key);
  active = Math.max(0, active - 1);
  pump();
}

export class CoverThumbnailError extends Error {
  constructor(readonly status: number) { super(`封面 HTTP ${status}`); }
}

function waitRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, delay);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}

async function fetchCover(url: string, signal: AbortSignal): Promise<Blob> {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(cancel, 10000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store", priority: "low" });
      if (!response.ok) throw new CoverThumbnailError(response.status);
      return await response.blob();
    } catch (error) {
      if (signal.aborted || attempt >= 2 || (error instanceof CoverThumbnailError && error.status < 500)) throw error;
      await waitRetry(attempt === 0 ? 500 : 1500, signal);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    }
  }
}

function start(task: CoverTask): void {
  task.started = true;
  task.controller = new AbortController();
  active += 1;
  void fetchCover(task.url, task.controller.signal)
    .then((blob) => {
      const clients = [...task.clients].filter((client) => !client.released);
      if (clients.length === 0) return;
      const objectUrl = URL.createObjectURL(blob);
      const entry: CacheEntry = { objectUrl, refs: 0 };
      cache.set(task.key, entry);
      for (const client of clients) {
        client.cacheKey = task.key;
        entry.refs += 1;
        client.resolve(objectUrl);
      }
      evictUnused();
    })
    .catch((error: unknown) => {
      for (const client of task.clients) {
        if (!client.released) client.reject(error);
      }
    })
    .finally(() => finishTask(task));
}

function pump(): void {
  while (active < MAX_ACTIVE_COVER_REQUESTS && queue.length > 0) {
    const priority = (task: CoverTask) => Math.min(...[...task.clients].map((client) => client.priority));
    queue.sort((a, b) => priority(a) - priority(b));
    const task = queue.shift();
    if (!task || task.clients.size === 0) continue;
    start(task);
  }
}

/**
 * Low-priority table-artwork lane. Releasing before start removes off-screen work; releasing the
 * final active consumer aborts its fetch. Player/detail artwork deliberately does not use it.
 */
export function acquireCoverThumbnail(key: string, url: string, priority = 1): CoverThumbnailLease {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    cached.refs += 1;
    let released = false;
    return {
      promise: Promise.resolve(cached.objectUrl),
      setPriority() {},
      release() {
        if (released) return;
        released = true;
        releaseCache(key);
      },
    };
  }

  let resolvePromise!: (value: string) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const client: Client = {
    released: false,
    priority,
    cacheKey: null,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
  let task = tasks.get(key);
  if (!task) {
    task = { key, url, started: false, controller: null, clients: new Set() };
    tasks.set(key, task);
    queue.push(task);
  }
  task.clients.add(client);
  pump();

  return {
    promise,
    setPriority(value) { client.priority = value; pump(); },
    release() {
      if (client.released) return;
      client.released = true;
      if (client.cacheKey) releaseCache(client.cacheKey);
      task?.clients.delete(client);
      // Resolve a cancelled queued consumer so no detached rejection is left behind.
      client.resolve("");
      if (task && task.clients.size === 0) {
        if (task.started) {
          if (tasks.get(task.key) === task) tasks.delete(task.key);
          task.controller?.abort();
        } else {
          tasks.delete(task.key);
          const index = queue.indexOf(task);
          if (index >= 0) queue.splice(index, 1);
        }
      }
    },
  };
}

export function coverThumbnailQueueStats(): { active: number; queued: number; cached: number } {
  return { active, queued: queue.length, cached: cache.size };
}
