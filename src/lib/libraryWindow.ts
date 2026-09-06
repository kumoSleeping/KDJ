import type { TrackSummary } from "../types";

/** Keep JSON field types here; the API client stringifies only URL query values. */
export interface LibraryQuery {
  q?: string;
  key?: string;
  bpm_min?: number;
  bpm_max?: number;
  energy_min?: number;
  analyzed?: boolean;
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
  requestLatency: number;
}
interface Dependencies {
  requestTimeoutMs?: number;
  index(query: LibraryQuery, signal: AbortSignal): Promise<TrackIndex>;
  summaries(ids: number[], query: LibraryQuery, signal: AbortSignal): Promise<TrackSummary[]>;
  publish(snapshot: LibraryWindowSnapshot): void;
}
interface Job { controller: AbortController; ids: number[]; epochs: number[]; generation: number }
const BATCH = 200;
const CACHE_SIZE = 2000;

/** Query-scoped, ID-addressed data lane. All asynchronous writes verify their owner. */
export class LibraryWindow {
  private query: LibraryQuery = {};
  private generation = 0;
  private ids: number[] = [];
  private positions = new Map<number, number>();
  private cache = new Map<number, TrackSummary>();
  private epochs = new Map<number, number>();
  private stale = new Set<number>();
  private failed = new Set<number>();
  private desired: number[] = [];
  private visible = new Set<number>();
  private jobs = new Set<Job>();
  private indexRequest: AbortController | null = null;
  private auxiliary = new Set<AbortController>();
  private loading = false;
  private error = "";
  private latency = 200;
  private demandVersion = 0;
  private waiters = new Set<() => void>();
  private missingChecked = new Set<number>();
  private lastSnapshot: LibraryWindowSnapshot | null = null;

  constructor(private readonly dependencies: Dependencies) {}

  dispose(): void {
    // Advancing the generation also releases range waiters and rejects late responses.
    this.changeQuery({});
    this.loading = false;
    this.publish();
  }

  changeQuery(query: LibraryQuery): void {
    this.generation += 1;
    this.indexRequest?.abort();
    this.indexRequest = null;
    for (const job of this.jobs) job.controller.abort();
    for (const controller of this.auxiliary) controller.abort();
    this.auxiliary.clear();
    this.jobs.clear();
    this.query = { ...query };
    this.ids = [];
    this.positions = new Map();
    this.cache.clear();
    this.epochs.clear();
    this.failed.clear();
    this.stale.clear();
    this.missingChecked.clear();
    this.desired = [];
    this.visible.clear();
    this.loading = true;
    this.error = "";
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
      if (ids.length !== this.ids.length || ids.some((id, i) => id !== this.ids[i])) {
        this.ids = ids;
        this.positions = new Map(ids.map((id, index) => [id, index]));
        for (const id of this.cache.keys()) if (!this.positions.has(id)) this.cache.delete(id);
        this.desired = this.desired.filter((id) => this.positions.has(id));
      }
      for (const id of this.failed) if (!this.positions.has(id)) this.failed.delete(id);
      if (!this.failed.size) this.error = "";
    } catch (error) {
      if (controller !== this.indexRequest || generation !== this.generation) return;
      this.error = message(error);
    } finally {
      if (controller === this.indexRequest && generation === this.generation) {
        this.indexRequest = null;
        this.loading = false;
        this.pump();
        this.publish();
      }
    }
  }

  ensureRange(start: number, end: number, visibleStart = start, visibleEnd = end): Promise<void> {
    const lo = Math.max(0, Math.floor(start / BATCH) * BATCH);
    const hi = Math.min(this.ids.length, Math.ceil(end / BATCH) * BATCH);
    const desired = this.ids.slice(lo, hi);
    this.visible = new Set(this.ids.slice(Math.max(0, visibleStart), Math.max(0, visibleEnd)));
    if (desired.length !== this.desired.length || desired.some((id, i) => id !== this.desired[i])) {
      this.desired = desired;
      this.demandVersion += 1;
    }
    const wanted = new Set(desired);
    for (const job of this.jobs) {
      if (!job.ids.some((id) => wanted.has(id))) {
        job.controller.abort();
        this.jobs.delete(job);
      }
    }
    for (const id of desired) this.touch(id);
    this.evict();
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

  invalidate(ids: number[]): void {
    for (const id of ids) {
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
      this.stale.add(id);
      this.failed.delete(id);
      this.missingChecked.delete(id);
    }
  }

  async refreshChanged(ids: number[]): Promise<void> {
    const generation = this.generation;
    const cached = ids.filter((id) => this.cache.has(id));
    // Refreshing the small ID index replaces all frontend global sorting/refill logic.
    await this.refreshIndex();
    if (generation !== this.generation) return;
    if (cached.length) await this.resolveIds(cached);
    this.pump();
    this.publish();
  }

  async retry(): Promise<void> {
    this.failed.clear();
    this.missingChecked.clear();
    this.error = "";
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
    // Explicit lookup lane shares the two-request budget with viewport work.
    for (let offset = 0; offset < needed.length; offset += BATCH) {
      while (this.jobs.size + this.auxiliary.size >= 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        if (generation !== this.generation) return [];
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
          if (this.positions.has(row.id)) this.accept(row);
        }
      } catch (error) {
        if (generation !== this.generation || !this.auxiliary.has(controller)) return [];
        this.error = message(error);
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
    if (this.positions.has(row.id)) this.accept(row);
    this.evict();
    this.publish();
  }

  remove(ids: Set<number>): void {
    this.invalidate([...ids]);
    this.ids = this.ids.filter((id) => !ids.has(id));
    this.positions = new Map(this.ids.map((id, index) => [id, index]));
    this.desired = this.desired.filter((id) => !ids.has(id));
    for (const id of ids) this.cache.delete(id);
    this.publish();
  }

  accept(row: TrackSummary): void {
    const old = this.cache.get(row.id);
    this.cache.set(row.id, old && sameSummary(old, row) ? old : row);
    this.stale.delete(row.id);
    this.failed.delete(row.id);
  }

  private touch(id: number): void {
    const value = this.cache.get(id);
    if (value) { this.cache.delete(id); this.cache.set(id, value); }
  }
  private evict(): void {
    const pinned = new Set(this.desired);
    for (const id of this.cache.keys()) {
      if (this.cache.size <= CACHE_SIZE) break;
      if (!pinned.has(id)) this.cache.delete(id);
    }
  }
  private pump(): void {
    const pending = new Set([...this.jobs].flatMap((job) => job.ids));
    const needed = this.desired.filter((id) => !pending.has(id) && !this.failed.has(id)
      && (!this.cache.has(id) || this.stale.has(id)));
    needed.sort((a, b) => Number(this.visible.has(b)) - Number(this.visible.has(a)));
    while (this.jobs.size + this.auxiliary.size < 2 && needed.length) {
      const ids = needed.splice(0, BATCH);
      const job: Job = { ids, epochs: ids.map((id) => this.epochs.get(id) ?? 0),
        generation: this.generation, controller: new AbortController() };
      this.jobs.add(job);
      const started = performance.now();
      void this.request(job.controller, this.dependencies.summaries(ids, this.query, job.controller.signal)).then((rows) => {
        if (!this.owns(job)) return;
        this.latency = this.latency * 0.7 + (performance.now() - started) * 0.3;
        const found = new Set(rows.map((row) => row.id));
        let checkIndex = false;
        for (const [i, id] of ids.entries()) {
          if (!this.positions.has(id) || (this.epochs.get(id) ?? 0) !== job.epochs[i]) continue;
          if (!found.has(id)) {
            this.failed.add(id);
            if (!this.missingChecked.has(id)) { this.missingChecked.add(id); checkIndex = true; }
          }
        }
        for (const row of rows) {
          const i = ids.indexOf(row.id);
          if (i >= 0 && this.positions.has(row.id) && (this.epochs.get(row.id) ?? 0) === job.epochs[i]) this.accept(row);
        }
        if (checkIndex) {
          this.error = "部分曲目已变化，请重试";
          void this.refreshIndex();
        }
        this.evict();
      }).catch((error: unknown) => {
        if (!this.owns(job)) return;
        for (const id of ids) this.failed.add(id);
        this.error = message(error);
      }).finally(() => {
        if (!this.owns(job)) return;
        this.jobs.delete(job);
        this.pump();
        this.publish();
      });
    }
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
  private owns(job: Job): boolean {
    return job.generation === this.generation && this.jobs.has(job);
  }
  private publish(): void {
    const previous = this.lastSnapshot;
    const sameCache = previous && previous.summaryById.size === this.cache.size
      && [...this.cache].every(([id, row]) => previous.summaryById.get(id) === row);
    const snapshot: LibraryWindowSnapshot = { orderedIds: this.ids, indexById: this.positions,
      summaryById: sameCache ? previous.summaryById : new Map(this.cache),
      total: this.ids.length,
      queryVersion: this.generation, loading: this.loading, loadingMore: this.jobs.size > 0,
      error: this.error, requestLatency: this.latency };
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
