import assert from "node:assert/strict";
import test from "node:test";
import { LibraryWindow, type LibraryWindowSnapshot } from "../src/lib/libraryWindow";
import { libraryViewport, restoreLibraryAnchor } from "../src/lib/libraryViewport";
import type { TrackSummary } from "../src/types";

const ids = Array.from({ length: 10000 }, (_, i) => i + 1);
const rows = (values: number[]) => values.map((id) => ({ id, title: `Song ${id}`, modified_at: "a" } as TrackSummary));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let snapshot!: LibraryWindowSnapshot;
  let publications = 0;
  const requests: { ids: number[]; signal: AbortSignal; resolve(value: TrackSummary[]): void; reject(error: Error): void }[] = [];
  const lane = new LibraryWindow({
    index: async () => ({ track_ids: ids, total: ids.length }),
    summaries: (ids, _query, signal) => new Promise((resolve, reject) => requests.push({ ids, signal, resolve, reject })),
    publish: (next) => { snapshot = next; publications++; },
  });
  lane.changeQuery({ folder: "a" });
  return { lane, requests, snapshot: () => snapshot, publications: () => publications };
}

test("ten thousand IDs support direct tail lookup with only one 200-summary request", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const ready = f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].ids, ids.slice(9800));
  f.requests[0].resolve(rows(f.requests[0].ids));
  await ready;
  assert.equal(f.snapshot().total, 10000);
  assert.equal(f.snapshot().summaryById.size, 200);
  const before = f.publications();
  await f.lane.ensureRange(9800, 10000);
  assert.equal(f.publications(), before, "unchanged demand does not cause a React publish loop");
});

test("background refill cannot truncate the page that arrived while it was pending", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const initial = f.lane.ensureRange(0, 200);
  f.requests[0].resolve(rows(ids.slice(0, 200)));
  await initial;
  f.lane.invalidate([1]);
  const update = f.lane.refreshChanged([1]);
  const next = f.lane.ensureRange(200, 400);
  await tick();
  const page = f.requests.find((request) => request.ids.includes(201))!;
  page.resolve(rows(page.ids));
  await next;
  const refill = f.requests.find((request, index) => index > 0 && request.ids.includes(1))!;
  refill.resolve([{ ...rows([1])[0], title: "updated" }]);
  await update;
  assert.equal(f.snapshot().summaryById.size, 400);
  assert.equal(f.snapshot().summaryById.get(1)?.title, "updated");
  assert.equal(f.snapshot().orderedIds.length, 10000);
  assert.ok(f.snapshot().summaryById.has(400));
});

test("obsolete failures cannot clear a new query's loading state", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const old = f.lane.ensureRange(0, 200);
  f.lane.changeQuery({ folder: "b" });
  await f.lane.refreshIndex();
  const next = f.lane.ensureRange(5000, 5200);
  f.requests[0].reject(new Error("obsolete"));
  await tick();
  assert.equal(f.snapshot().loadingMore, true);
  assert.equal(f.snapshot().error, "");
  assert.equal(f.snapshot().summaryById.size, 0);
  f.requests[1].resolve(rows(f.requests[1].ids));
  await Promise.all([old, next]);
  assert.equal(f.snapshot().summaryById.size, 200);
  assert.ok(!f.snapshot().summaryById.has(1));
});

test("in-flight summaries invalidated by an event cannot overwrite newer metadata", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const ready = f.lane.ensureRange(0, 200);
  f.lane.update({ ...rows([1])[0], title: "new" });
  f.requests[0].resolve(rows(f.requests[0].ids));
  await ready;
  assert.equal(f.snapshot().summaryById.get(1)?.title, "new");
});

test("far jumps cancel irrelevant requests; failed and empty ranges pause until retry", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const old = f.lane.ensureRange(0, 200);
  const tail = f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[1].reject(new Error("offline"));
  await tail;
  await old;
  await f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.snapshot().error, "offline");
  await f.lane.retry();
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve([]);
  await tick(); await tick();
  await f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests.length, 3, "missing IDs do not spin on a non-changing index");
  assert.ok(f.snapshot().error);
  f.requests[0].resolve(rows(f.requests[0].ids));
});

test("LRU eviction preserves complete order, with at most two summary requests and 2000 cached rows", async () => {
  let snapshot!: LibraryWindowSnapshot;
  let active = 0, peak = 0;
  const lane = new LibraryWindow({ index: async () => ({ track_ids: ids, total: ids.length }),
    summaries: async (values) => { peak = Math.max(peak, ++active); await tick(); active--; return rows(values); },
    publish: (value) => { snapshot = value; } });
  lane.changeQuery({});
  await lane.refreshIndex();
  for (let start = 0; start < 10000; start += 400) await lane.ensureRange(start, start + 400);
  assert.ok(peak <= 2);
  assert.equal(snapshot.total, 10000);
  assert.equal(snapshot.summaryById.size, 2000);
  assert.equal(snapshot.indexById.get(1), 0);
  assert.equal(snapshot.indexById.get(10000), 9999);
  const selected = ids.slice(99, 9900);
  assert.equal(selected.length, 9801, "selection is independent of cached summaries");
  const explicit = await lane.resolveIds([1, 10000]);
  assert.deepEqual(explicit.map((row) => row.id), [1, 10000]);
  assert.equal(snapshot.summaryById.size, 2000);
});

test("virtual ranges remain bounded across shrink, pending rows, resize, row height and velocity", () => {
  for (const total of [0, 1, 200, 10000]) for (const pending of [0, 10000])
    for (const rowHeight of [24, 36, 52]) for (const height of [300, 720, 1100])
      for (const velocity of [-30, 0, 30]) {
        const view = libraryViewport({ total, pending, rowHeight, height, velocity, top: 350000, headerHeight: 28, latency: 400 });
        assert.ok(0 <= view.start && view.start <= view.end && view.end <= total + pending);
        assert.ok(view.top <= view.maxTop);
        assert.ok(view.end - view.start <= 5 * Math.ceil((height - 28) / rowHeight) + 2);
        assert.ok(view.trackEnd <= total && view.fetchEnd <= total);
      }
  assert.equal(restoreLibraryAnchor([1, 3, 4], 2, 1, 5, 36, 0), 41);
  assert.equal(restoreLibraryAnchor([1, 2, 3], 3, 0, 5, 36, 2), 149);
});


test("late index response cannot replace the newer query order", async () => {
  let snapshot!: LibraryWindowSnapshot;
  const pending: ((value: { track_ids: number[]; total: number }) => void)[] = [];
  const lane = new LibraryWindow({ index: () => new Promise(resolve => pending.push(resolve)),
    summaries: async values => rows(values), publish: value => { snapshot = value; } });
  lane.changeQuery({ folder: "first" });
  const first = lane.refreshIndex();
  lane.changeQuery({ folder: "second" });
  const second = lane.refreshIndex();
  pending[1]({ track_ids: [42], total: 1 });
  await second;
  pending[0]({ track_ids: ids, total: ids.length });
  await first;
  assert.deepEqual(snapshot.orderedIds, [42]);
  assert.equal(snapshot.loading, false);
});

test("hung summary requests time out, release their slots, and wait for explicit retry", async () => {
  let snapshot!: LibraryWindowSnapshot;
  let requests = 0;
  const lane = new LibraryWindow({ requestTimeoutMs: 5,
    index: async () => ({ track_ids: ids, total: ids.length }),
    summaries: () => { requests++; return new Promise(() => {}); },
    publish: value => { snapshot = value; } });
  lane.changeQuery({});
  await lane.refreshIndex();
  await lane.ensureRange(0, 200);
  assert.equal(snapshot.loadingMore, false);
  assert.match(snapshot.error, /超时/);
  await lane.ensureRange(0, 200);
  assert.equal(requests, 1);
});
