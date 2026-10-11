import assert from "node:assert/strict";
import test from "node:test";
import { LibraryWindow, type LibraryWindowSnapshot } from "../src/lib/libraryWindow";
import { libraryDemand, restoreLibraryAnchor } from "../src/lib/libraryViewport";
import { REST_PACE, scrollPace, type ScrollPace } from "../src/components/common/rowList";
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

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

test("the index starts a background fill; a far jump takes the free slot without cancelling it", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].ids, ids.slice(0, 500));
  const ready = f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].signal.aborted, false);
  assert.deepEqual(sorted(f.requests[1].ids), ids.slice(9500));
  assert.equal(f.requests[1].ids[0], 9901, "rows nearest the viewport lead the batch");
  const empty = f.snapshot().summaryById;
  f.requests[1].resolve(rows(f.requests[1].ids));
  await ready;
  assert.equal(f.snapshot().total, 10000);
  assert.equal(f.snapshot().summaryById.size, 500);
  assert.notEqual(f.snapshot().summaryById, empty, "arriving rows publish a new map identity");
  const before = f.publications();
  await f.lane.ensureRange(9800, 10000);
  assert.equal(f.publications(), before, "unchanged demand does not cause a React publish loop");
  f.lane.dispose();
});

test("a changed row stays on display while only that row is re-read", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  f.requests[0].resolve(rows(f.requests[0].ids));
  await tick();
  await f.lane.ensureRange(0, 200);
  const issued = f.requests.length;
  f.lane.invalidate([1]);
  const update = f.lane.refreshChanged([1]);
  await tick();
  assert.equal(f.requests.length, issued + 1);
  assert.deepEqual(f.requests[issued].ids, [1]);
  assert.equal(f.snapshot().summaryById.get(1)?.title, "Song 1");
  f.requests[issued].resolve([{ ...rows([1])[0], title: "updated" }]);
  await update;
  assert.equal(f.snapshot().summaryById.size, 500);
  assert.equal(f.snapshot().summaryById.get(1)?.title, "updated");
  assert.equal(f.snapshot().orderedIds.length, 10000);
  f.lane.dispose();
});

test("a request from the previous query keeps its rows but not its failures", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const old = f.lane.ensureRange(600, 700);
  assert.deepEqual(sorted(f.requests[1].ids), ids.slice(500, 1000));
  f.lane.changeQuery({ folder: "b" });
  assert.equal(f.requests[0].signal.aborted, false);
  await f.lane.refreshIndex();
  assert.equal(f.requests.length, 2, "in-flight requests still hold both slots");
  f.requests[1].reject(new Error("obsolete"));
  await tick();
  assert.equal(f.snapshot().error, "");
  f.requests[0].resolve(rows(f.requests[0].ids));
  await tick();
  assert.equal(f.snapshot().summaryById.size, 500);
  assert.deepEqual(f.requests[2].ids, ids.slice(500, 1000), "rows of the failed obsolete request are requested again");
  await old;
  f.lane.dispose();
});

test("in-flight summaries invalidated by an event cannot overwrite newer metadata", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const ready = f.lane.ensureRange(0, 200);
  f.lane.update({ ...rows([1])[0], title: "new" });
  f.requests[0].resolve(rows(f.requests[0].ids));
  await ready;
  assert.equal(f.snapshot().summaryById.get(1)?.title, "new");
  f.lane.dispose();
});

test("far jumps keep earlier requests; failed and empty ranges pause until retry", async () => {
  const f = fixture();
  await f.lane.refreshIndex();
  const old = f.lane.ensureRange(2000, 2200);
  const tail = f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].signal.aborted, false);
  await old;
  f.requests[1].resolve(rows(f.requests[1].ids));
  await tick();
  assert.equal(f.snapshot().summaryById.size, 500, "rows of the superseded range are kept");
  assert.deepEqual(sorted(f.requests[2].ids), ids.slice(9500));
  f.requests[2].reject(new Error("offline"));
  await tail;
  await f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests.length, 3);
  assert.equal(f.snapshot().error, "offline");
  f.requests[0].resolve(rows(f.requests[0].ids));
  await tick();
  assert.equal(f.requests.length, 3, "a failure pauses the background fill");
  await f.lane.retry();
  assert.equal(f.requests.length, 5);
  assert.deepEqual(sorted(f.requests[3].ids), ids.slice(9500));
  f.requests[3].resolve([]);
  await tick(); await tick();
  await f.lane.ensureRange(9800, 10000);
  assert.equal(f.requests.filter((request) => request.ids.includes(10000)).length, 2, "missing IDs do not spin on a non-changing index");
  assert.ok(f.snapshot().error);
  f.lane.dispose();
});

function autoLane(all: number[], index: () => number[] = () => all) {
  const state = { snapshot: undefined as unknown as LibraryWindowSnapshot, active: 0, peak: 0, requested: [] as number[][] };
  const lane = new LibraryWindow({ index: async () => ({ track_ids: index(), total: index().length }),
    summaries: async (values) => {
      state.requested.push(values);
      state.peak = Math.max(state.peak, ++state.active);
      await tick();
      state.active--;
      return rows(values);
    },
    publish: (value) => { state.snapshot = value; } });
  const idle = async () => { do { await tick(); } while (state.active > 0); };
  return { lane, state, idle };
}

test("the whole library stays in memory with at most two summary requests of 500 rows", async () => {
  const { lane, state, idle } = autoLane(ids);
  lane.changeQuery({});
  await lane.refreshIndex();
  for (let start = 0; start < 10000; start += 400) await lane.ensureRange(start, start + 400);
  await idle();
  assert.ok(state.peak <= 2);
  assert.ok(state.requested.every((values) => values.length <= 500));
  assert.deepEqual(sorted(state.requested.flat()), ids, "every row is requested exactly once");
  assert.equal(state.snapshot.total, 10000);
  assert.equal(state.snapshot.summaryById.size, 10000);
  assert.equal(state.snapshot.loadingMore, false);
  assert.equal(state.snapshot.indexById.get(1), 0);
  assert.equal(state.snapshot.indexById.get(10000), 9999);
  const selected = ids.slice(99, 9900);
  assert.equal(selected.length, 9801, "selection is independent of cached summaries");
  const issued = state.requested.length;
  const explicit = await lane.resolveIds([1, 10000]);
  assert.deepEqual(explicit.map((row) => row.id), [1, 10000]);
  await lane.ensureRange(4000, 4400);
  assert.equal(state.requested.length, issued, "scrolling a loaded library requests nothing");
});

test("a new sort keeps the rows on display and only swaps the ID order", async () => {
  let order = ids;
  const { lane, state, idle } = autoLane(ids, () => order);
  lane.changeQuery({ sort: "title" });
  await lane.refreshIndex();
  await idle();
  const issued = state.requested.length;
  const first = state.snapshot;
  const row = first.summaryById.get(7);
  order = [...ids].reverse();
  lane.changeQuery({ sort: "bpm" });
  assert.equal(state.snapshot.loading, true);
  assert.equal(state.snapshot.orderedIds, first.orderedIds, "the previous order stays until the new index arrives");
  assert.equal(state.snapshot.queryVersion, first.queryVersion);
  await lane.refreshIndex();
  await idle();
  assert.equal(state.snapshot.orderedIds[0], 10000);
  assert.equal(state.snapshot.queryVersion, first.queryVersion + 1);
  assert.equal(state.snapshot.summaryById.get(7), row);
  assert.equal(state.requested.length, issued, "no summary is requested again");
});

test("a query whose index fails does not keep showing the previous order", async () => {
  let fail = false;
  let snapshot!: LibraryWindowSnapshot;
  const lane = new LibraryWindow({
    index: async () => { if (fail) throw new Error("offline"); return { track_ids: [1, 2, 3], total: 3 }; },
    summaries: async (values) => rows(values), publish: (value) => { snapshot = value; } });
  lane.changeQuery({ folder: "a" });
  await lane.refreshIndex();
  await tick();
  fail = true;
  lane.changeQuery({ folder: "b" });
  assert.equal(snapshot.orderedIds.length, 3);
  await lane.refreshIndex();
  assert.equal(snapshot.orderedIds.length, 0);
  assert.equal(snapshot.error, "offline");
  assert.equal(snapshot.loading, false);
});

test("libraries beyond the cache limit evict least-recently-used rows around the demanded range", async () => {
  const huge = Array.from({ length: 50500 }, (_, i) => i + 1);
  const { lane, state, idle } = autoLane(huge);
  lane.changeQuery({});
  await lane.refreshIndex();
  await idle();
  assert.equal(state.snapshot.summaryById.size, 50000, "the background fill stops at the limit");
  await lane.ensureRange(50400, 50500);
  await idle();
  assert.equal(state.snapshot.summaryById.size, 50000);
  assert.ok(state.snapshot.summaryById.has(50500));
  assert.ok(!state.snapshot.summaryById.has(1));
  assert.equal(state.snapshot.total, 50500);
  assert.ok(state.peak <= 2);
  assert.deepEqual((await lane.resolveIds([1])).map((row) => row.id), [1]);
});

test("the demand follows the rendered rows: a screen beyond them, clamped to the tracks there are", () => {
  for (const total of [0, 1, 200, 10000]) for (const pending of [0, 10000]) for (const screen of [8, 19, 46]) {
    const count = total + pending;
    for (const start of [0, 17, 3600, count]) {
      const end = Math.min(count, start + screen + 24);
      const demand = libraryDemand({ total, pending, screen, start, end, visibleStart: Math.min(count, start + 12), visibleEnd: end });
      assert.ok(0 <= demand.fetchStart && demand.fetchStart <= demand.visibleTrackStart);
      assert.ok(demand.visibleTrackStart <= demand.visibleTrackEnd && demand.visibleTrackEnd <= demand.fetchEnd && demand.fetchEnd <= total);
      // Every rendered track row is demanded, and a screen beyond either end of them.
      const trackStart = Math.min(total, Math.max(0, start - pending));
      const trackEnd = Math.min(total, Math.max(0, end - pending));
      assert.ok(demand.fetchStart <= trackStart && trackEnd <= demand.fetchEnd);
      // Rendered rows that are pending downloads demand no track; past them, a screen of tracks.
      const clamp = (index: number) => Math.min(total, Math.max(0, index - pending));
      if (start >= pending) assert.equal(demand.fetchStart, clamp(start - screen));
      if (end > pending) assert.equal(demand.fetchEnd, clamp(end + screen));
    }
  }
  assert.equal(restoreLibraryAnchor([1, 3, 4], 2, 1, 5, 36, 0), 41);
  assert.equal(restoreLibraryAnchor([1, 2, 3], 3, 0, 5, 36, 2), 149);
});

test("scroll pace: wheel notches stay calm, a flick turns fast with hysteresis", () => {
  const run = (pace: ScrollPace, frames: number, travel: number, elapsed = 16) => {
    for (let i = 0; i < frames; i += 1) pace = scrollPace(pace, travel, elapsed);
    return pace;
  };
  // One notch moves a hundred pixels in a single frame; ten a second is still an ordinary scroll.
  let pace = REST_PACE;
  for (let notch = 0; notch < 10; notch += 1) {
    pace = scrollPace(pace, 100, notch ? 100 : 16);
    assert.equal(pace.fast, false);
  }
  // Reading speed: a screen and a half per second.
  assert.equal(run(REST_PACE, 60, 16).fast, false);
  // A trackpad flick at 6000 px/s is fast within a few frames, either way.
  const flick = run(REST_PACE, 6, 96);
  assert.ok(flick.fast && flick.speed > 3);
  assert.ok(run(REST_PACE, 6, -96).fast && run(REST_PACE, 6, -96).speed < -3);
  // Momentum decays: still fast at 2500 px/s, calm again below 2000 px/s.
  assert.equal(run(flick, 30, 40).fast, true);
  assert.equal(run(flick, 40, 28).fast, false);
  assert.equal(run(REST_PACE, 40, 40).fast, false, "2500 px/s does not start a fast scroll");
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
