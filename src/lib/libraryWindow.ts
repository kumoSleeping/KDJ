import type { TrackSummary } from "../types";

/** Keep JSON field types here; the API client stringifies only URL query values. */
export interface LibraryQuery {
  q?: string;
  key?: string;
  bpm_min?: number;
  bpm_max?: number;
  energy_min?: number;
  analyzed?: boolean;
  media?: "audio" | "video";
  folder?: string;
  folder_deep?: boolean;
  sort?: string;
  order?: string;
  sort2?: string;
  order2?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  include_total?: boolean;
}
export interface TrackIndex { track_ids: number[]; total: number }
export interface LibraryWindowSnapshot {
  orderedIds: number[];
  indexById: ReadonlyMap<number, number>;
  summaryById: ReadonlyMap<number, TrackSummary>;
  total: number;
  queryVersion: number;
  loading: boolean;
  loadingMore: boolean;
  error: string;
}
interface Dependencies {
  requestTimeoutMs?: number;
  index(query: LibraryQuery, signal: AbortSignal): Promise<TrackIndex>;
  summaries(ids: number[], query: LibraryQuery, signal: AbortSignal): Promise<TrackSummary[]>;
  publish(snapshot: LibraryWindowSnapshot): void;
}
interface Job { controller: AbortController; ids: number[]; epochs: number[]; generation: number; background: boolean }
/** The summaries endpoint rejects more than 500 IDs per request. */
const BATCH = 500;
const REQUESTS = 2;
/** Whole libraries stay in memory; only larger ones fall back to least-recently-used eviction. */
const CACHE_LIMIT = 50_000;
/** Waits before the rows of a failed request are asked for again; after the last one they stay
 * failed until the retry control, a new demand for them, or an event that names them. */
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

/** A new identity over the live row map: subscribers see a change without the rows being copied. */
class SummaryView implements ReadonlyMap<number, TrackSummary> {
  constructor(private readonly rows: Map<number, TrackSummary>) {}
  get size() { return this.rows.size; }
  get(id: number) { return this.rows.get(id); }
  has(id: number) { return this.rows.has(id); }
  forEach(callback: (value: TrackSummary, key: number, map: ReadonlyMap<number, TrackSummary>) => void, thisArg?: unknown) {
    this.rows.forEach((value, key) => callback.call(thisArg, value, key, this));
  }
  entries() { return this.rows.entries(); }
  keys() { return this.rows.keys(); }
  values() { return this.rows.values(); }
  [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
}

/**
 * ID-addressed data lane. The index is query-scoped; row summaries do not depend on the query, so
 * they outlive it and a new sort, filter or folder only swaps the ID order. All asynchronous
 * writes verify their owner.
 */
export class LibraryWindow {
  private query: LibraryQuery = {};
  private generation = 0;
  /** Generation of the index on display; it trails `generation` until the new index arrives. */
  private indexGeneration = 0;
  private ids: number[] = [];
  private positions = new Map<number, number>();
  private cache = new Map<number, TrackSummary>();
  private revision = 0;
  private view = new SummaryView(this.cache);
  private viewRevision = 0;
  private epochs = new Map<number, number>();
  private stale = new Set<number>();
  /** Rows of a failed request. They are skipped until `retryTimer` puts them back in the queue. */
  private failed = new Set<number>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Automatic retries since the rows last loaded completely. */
  private retries = 0;
  /** The error on display came from a summaries request, so loading those rows clears it. */
  private rowError = false;
  private desired: number[] = [];
  private center = 0;
  /** Rows outside the demanded range may still be missing or stale. */
  private fillPending = false;
  /** A failed request pauses the background fill until a retry, a new query or a fresh index. */
  private fillHalted = false;
  private jobs = new Set<Job>();
  private indexRequest: AbortController | null = null;
  private auxiliary = new Set<AbortController>();
  private auxiliaryWaiting = 0;
  private loading = false;
  private error = "";
  private demandVersion = 0;
  private waiters = new Set<() => void>();
  private missingChecked = new Set<number>();
  private lastSnapshot: LibraryWindowSnapshot | null = null;

  constructor(private readonly dependencies: Dependencies) {}

  dispose(): void {
    // Advancing the generation also releases range waiters and rejects late responses.
    this.generation += 1;
    this.indexGeneration = this.generation;
    this.indexRequest?.abort();
    this.indexRequest = null;
    for (const job of this.jobs) job.controller.abort();
    for (const controller of this.auxiliary) controller.abort();
    this.jobs.clear();
    this.auxiliary.clear();
    this.query = {};
    this.ids = [];
    this.positions = new Map();
    this.cache.clear();
    this.revision += 1;
    this.epochs.clear();
    this.stale.clear();
    this.failed.clear();
    this.cancelRetry();
    this.missingChecked.clear();
    this.desired = [];
    this.fillPending = false;
    this.fillHalted = false;
    this.loading = false;
    this.error = "";
    this.rowError = false;
    this.demandVersion += 1;
    this.publish();
  }

  /** The current order and rows stay on display until `refreshIndex` delivers the new order. */
  changeQuery(query: LibraryQuery): void {
    this.generation += 1;
    this.indexRequest?.abort();
    this.indexRequest = null;
    for (const controller of this.auxiliary) controller.abort();
    this.auxiliary.clear();
    this.query = { ...query };
    this.failed.clear();
    this.cancelRetry();
    this.missingChecked.clear();
    this.fillHalted = false;
    this.loading = true;
    this.error = "";
    this.rowError = false;
    this.demandVersion += 1;
    this.publish();
  }

  async refreshIndex(): Promise<void> {
    const generation = this.generation;
    this.indexRequest?.abort();
    const controller = new AbortController();
    this.indexRequest = controller;
    this.loading = true;
    this.publish();
    try {
      const result = await this.request(controller, this.dependencies.index(this.query, controller.signal));
      if (controller !== this.indexRequest || generation !== this.generation) return;
      const ids = [...new Set(result.track_ids)];
      const swapped = this.indexGeneration !== generation;
      if (swapped || ids.length !== this.ids.length || ids.some((id, i) => id !== this.ids[i])) {
        this.ids = ids;
        this.positions = new Map(ids.map((id, index) => [id, index]));
        this.desired = swapped ? [] : this.desired.filter((id) => this.positions.has(id));
        if (swapped) { this.center = 0; this.demandVersion += 1; }
        this.fillPending = true;
      }
      this.indexGeneration = generation;
      this.fillHalted = false;
      for (const id of this.failed) if (!this.positions.has(id)) this.failed.delete(id);
      if (!this.failed.size) { this.error = ""; this.rowError = false; }
    } catch (error) {
      if (controller !== this.indexRequest || generation !== this.generation) return;
      if (this.indexGeneration !== generation) {
        // The previous query's order cannot stand in for a query that failed to load.
        this.ids = [];
        this.positions = new Map();
        this.desired = [];
        this.center = 0;
        this.indexGeneration = generation;
        this.demandVersion += 1;
      }
      this.error = message(error);
      this.rowError = false;
    } finally {
      if (controller === this.indexRequest && generation === this.generation) {
        this.indexRequest = null;
        this.loading = false;
        this.pump();
        this.publish();
      }
    }
  }

  /** Scrolling only reorders the queue: requests already in flight finish and their rows are kept. */
  ensureRange(start: number, end: number, visibleStart = start, visibleEnd = end): Promise<void> {
    const lo = Math.max(0, Math.floor(start / BATCH) * BATCH);
    const hi = Math.min(this.ids.length, Math.ceil(end / BATCH) * BATCH);
    const desired = this.ids.slice(lo, hi);
    this.center = Math.max(0, Math.floor((Math.max(0, visibleStart) + Math.max(0, visibleEnd)) / 2));
    if (desired.length !== this.desired.length || desired.some((id, i) => id !== this.desired[i])) {
      this.desired = desired;
      this.demandVersion += 1;
      for (const id of desired) this.touch(id);
      this.evict();
      // Looking at rows that gave up retrying is a new request for them.
      if (this.retryTimer === null && desired.some((id) => this.failed.has(id))) {
        this.retries = 0;
        this.scheduleRetry();
      }
    }
    this.pump();
    this.publish();
    const version = this.demandVersion;
    const generation = this.generation;
    return new Promise((resolve) => {
      const check = () => {
        if (generation !== this.generation || version !== this.demandVersion || desired.every((id) =>
          !this.positions.has(id) || this.failed.has(id) || (this.cache.has(id) && !this.stale.has(id)))) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  /** Stale rows stay on display until the request lanes replace them. */
  invalidate(ids: number[]): void {
    for (const id of ids) {
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
      this.stale.add(id);
      this.failed.delete(id);
      this.missingChecked.delete(id);
    }
    this.fillPending = true;
  }

  /** Rows cached under an earlier query are not in the current index, so name them all. */
  invalidateAll(): void {
    this.invalidate([...this.cache.keys()]);
  }

  async refreshChanged(ids: number[]): Promise<void> {
    const generation = this.generation;
    const cached = ids.filter((id) => this.cache.has(id));
    // Refreshing the small ID index replaces all frontend global sorting/refill logic; the request
    // lanes then re-read whichever of the changed rows it still lists.
    await this.refreshIndex();
    if (generation !== this.generation) return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (generation !== this.generation || this.fillHalted || cached.every((id) =>
          !this.positions.has(id) || this.failed.has(id) || !this.stale.has(id))) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  async retry(): Promise<void> {
    this.failed.clear();
    this.cancelRetry();
    this.missingChecked.clear();
    this.error = "";
    this.rowError = false;
    this.fillPending = true;
    this.fillHalted = false;
    await this.refreshIndex();
  }

  /** Explicit operations may need uncached selected paths; never truncate them to the LRU. */
  async resolveIds(ids: number[]): Promise<TrackSummary[]> {
    const generation = this.generation;
    const result = new Map<number, TrackSummary>();
    const needed: number[] = [];
    for (const id of new Set(ids)) {
      const cached = this.cache.get(id);
      if (cached && !this.stale.has(id)) { result.set(id, cached); this.touch(id); }
      else needed.push(id);
    }
    // Explicit lookup lane shares the two-request budget with viewport work; a waiting lookup
    // reserves the next free slot so the background fill cannot starve it.
    for (let offset = 0; offset < needed.length; offset += BATCH) {
      this.auxiliaryWaiting += 1;
      try {
        while (this.jobs.size + this.auxiliary.size >= REQUESTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          if (generation !== this.generation) return [];
        }
      } finally {
        this.auxiliaryWaiting -= 1;
      }
      const batch = needed.slice(offset, offset + BATCH);
      const epochs = batch.map((id) => this.epochs.get(id) ?? 0);
      const controller = new AbortController();
      this.auxiliary.add(controller);
      try {
        const rows = await this.request(controller, this.dependencies.summaries(batch, this.query, controller.signal));
        if (generation !== this.generation || controller.signal.aborted) return [];
        for (const row of rows) {
          if ((this.epochs.get(row.id) ?? 0) !== epochs[batch.indexOf(row.id)]) continue;
          result.set(row.id, row);
          this.accept(row);
        }
      } catch (error) {
        if (generation !== this.generation || !this.auxiliary.has(controller)) return [];
        this.error = message(error);
        this.rowError = false;
        throw error;
      } finally {
        this.auxiliary.delete(controller);
        if (generation === this.generation) { this.evict(); this.pump(); this.publish(); }
      }
    }
    return ids.flatMap((id) => result.has(id) ? [result.get(id)!] : []);
  }

  update(row: TrackSummary): void {
    this.invalidate([row.id]);
    this.accept(row);
    this.evict();
    this.publish();
  }

  remove(ids: Set<number>): void {
    this.invalidate([...ids]);
    this.ids = this.ids.filter((id) => !ids.has(id));
    this.positions = new Map(this.ids.map((id, index) => [id, index]));
    this.desired = this.desired.filter((id) => !ids.has(id));
    for (const id of ids) if (this.cache.delete(id)) this.revision += 1;
    this.publish();
  }

  accept(row: TrackSummary): void {
    const old = this.cache.get(row.id);
    if (!old || !sameSummary(old, row)) {
      this.cache.set(row.id, row);
      this.revision += 1;
    }
    this.stale.delete(row.id);
    this.failed.delete(row.id);
  }

  private touch(id: number): void {
    const value = this.cache.get(id);
    if (value) { this.cache.delete(id); this.cache.set(id, value); }
  }
  private evict(): void {
    if (this.cache.size <= CACHE_LIMIT) return;
    const pinned = new Set(this.desired);
    for (const id of this.cache.keys()) {
      if (this.cache.size <= CACHE_LIMIT) break;
      if (!pinned.has(id)) { this.cache.delete(id); this.revision += 1; }
    }
  }
  private wanted(id: number, pending: Set<number>): boolean {
    return !pending.has(id) && !this.failed.has(id) && (!this.cache.has(id) || this.stale.has(id));
  }
  /** Demanded rows first, nearest the viewport; then the rest of the index, outward from it. */
  private nextBatch(): { ids: number[]; background: boolean } {
    const pending = new Set<number>();
    let filling = false;
    for (const job of this.jobs) {
      filling ||= job.background;
      for (const id of job.ids) pending.add(id);
    }
    const demand = this.desired.filter((id) => this.wanted(id, pending));
    if (demand.length) {
      const distance = (id: number) => Math.abs((this.positions.get(id) ?? 0) - this.center);
      demand.sort((a, b) => distance(a) - distance(b));
      return { ids: demand.slice(0, BATCH), background: false };
    }
    // One background request at a time leaves the other slot free for wherever the user jumps.
    if (filling || !this.fillPending || this.fillHalted) return { ids: [], background: true };
    const ids: number[] = [];
    let room = CACHE_LIMIT - this.cache.size;
    const take = (id: number) => {
      if (!this.wanted(id, pending)) return;
      if (!this.cache.has(id) && room-- <= 0) return;
      ids.push(id);
    };
    let before = Math.min(this.center, this.ids.length - 1);
    let after = before + 1;
    while (ids.length < BATCH && (before >= 0 || after < this.ids.length)) {
      if (before >= 0) take(this.ids[before--]);
      if (after < this.ids.length && ids.length < BATCH) take(this.ids[after++]);
    }
    if (!ids.length) this.fillPending = false;
    return { ids, background: true };
  }
  private pump(): void {
    // Until the new index arrives, the IDs on display belong to the previous query's filter.
    if (this.indexGeneration !== this.generation) return;
    while (this.jobs.size + this.auxiliary.size + (this.auxiliaryWaiting ? 1 : 0) < REQUESTS) {
      const { ids, background } = this.nextBatch();
      if (!ids.length) break;
      const job: Job = { ids, epochs: ids.map((id) => this.epochs.get(id) ?? 0), background,
        generation: this.generation, controller: new AbortController() };
      this.jobs.add(job);
      void this.request(job.controller, this.dependencies.summaries(ids, this.query, job.controller.signal)).then((rows) => {
        if (!this.jobs.has(job)) return;
        const current = job.generation === this.generation;
        const found = new Set(rows.map((row) => row.id));
        let checkIndex = false;
        // A row absent under an older query's filter says nothing about the current one.
        if (current) for (const [i, id] of ids.entries()) {
          if (!this.positions.has(id) || (this.epochs.get(id) ?? 0) !== job.epochs[i]) continue;
          if (!found.has(id)) {
            this.failed.add(id);
            if (!this.missingChecked.has(id)) { this.missingChecked.add(id); checkIndex = true; }
          }
        }
        const slots = new Map(ids.map((id, i) => [id, i]));
        for (const row of rows) {
          const i = slots.get(row.id);
          if (i !== undefined && (this.epochs.get(row.id) ?? 0) === job.epochs[i]) this.accept(row);
        }
        if (checkIndex) {
          this.error = "部分曲目已变化，请重试";
          this.rowError = true;
          void this.refreshIndex();
        }
        this.evict();
      }).catch((error: unknown) => {
        if (!this.jobs.has(job) || job.generation !== this.generation) return;
        for (const id of ids) this.failed.add(id);
        this.fillHalted = true;
        this.error = message(error);
        this.rowError = true;
      }).finally(() => {
        if (!this.jobs.delete(job)) return;
        // Rows this request did not deliver are open to the background fill again.
        this.fillPending = true;
        this.pump();
        if (!this.failed.size && !this.jobs.size) {
          // Nothing failed and nothing is left in flight: the retried rows have loaded.
          this.retries = 0;
          if (this.rowError) { this.error = ""; this.rowError = false; }
        }
        this.scheduleRetry();
        this.publish();
      });
    }
  }
  /**
   * A failed request must not leave its rows as placeholders for good: nothing else asks for
   * them again while the viewport rests on them. They rejoin the queue after a growing delay.
   */
  private scheduleRetry(): void {
    if (this.retryTimer !== null || !this.failed.size || this.retries >= RETRY_DELAYS.length) return;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.failed.clear();
      this.fillHalted = false;
      this.fillPending = true;
      this.pump();
      this.publish();
    }, RETRY_DELAYS[this.retries]);
    this.retries += 1;
    // Only Node returns a handle here; a waiting retry must not keep its process alive.
    (timer as { unref?: () => void }).unref?.();
    this.retryTimer = timer;
  }
  private cancelRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retries = 0;
  }
  private async request<T>(controller: AbortController, work: Promise<T>): Promise<T> {
    let cancel!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    const timer = setTimeout(() => controller.abort(new Error("读取曲库超时，请重试")), this.dependencies.requestTimeoutMs ?? 15000);
    try { return await Promise.race([work, cancellation]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener("abort", cancel); }
  }
  private publish(): void {
    if (this.viewRevision !== this.revision) {
      this.view = new SummaryView(this.cache);
      this.viewRevision = this.revision;
    }
    let demanded = false;
    for (const job of this.jobs) demanded ||= !job.background;
    const previous = this.lastSnapshot;
    const snapshot: LibraryWindowSnapshot = { orderedIds: this.ids, indexById: this.positions,
      summaryById: this.view,
      total: this.ids.length,
      queryVersion: this.indexGeneration, loading: this.loading, loadingMore: demanded,
      error: this.error };
    if (!previous || Object.keys(snapshot).some((key) =>
      snapshot[key as keyof LibraryWindowSnapshot] !== previous[key as keyof LibraryWindowSnapshot])) {
      this.lastSnapshot = snapshot;
      this.dependencies.publish(snapshot);
    }
    for (const check of this.waiters) check();
  }

}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sameSummary(a: TrackSummary, b: TrackSummary): boolean {
  return Object.keys(b).every((key) => a[key as keyof TrackSummary] === b[key as keyof TrackSummary]);
}
