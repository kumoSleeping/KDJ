import assert from "node:assert/strict";
import test from "node:test";
import { LibraryWindow, type LibraryWindowSnapshot } from "../src/lib/libraryWindow";
import { LIBRARY_REST_PACE, libraryScrollPace, libraryViewport, libraryWindowTop, restoreLibraryAnchor, type LibraryScrollPace } from "../src/lib/libraryViewport";
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

test("virtual ranges remain bounded and cover every offset of their step", () => {
  for (const total of [0, 1, 200, 10000]) for (const pending of [0, 10000])
    for (const rowHeight of [24, 36, 52]) for (const height of [300, 720, 1100]) {
      const screen = Math.ceil((height - 28) / rowHeight);
      const count = total + pending;
      for (const scrollTop of [0, 17, 3600, 350000, count * rowHeight]) {
        const view = libraryViewport({ total, pending, rowHeight, height, top: libraryWindowTop(scrollTop, rowHeight), headerHeight: 28 });
        assert.ok(0 <= view.start && view.start <= view.end && view.end <= count);
        assert.ok(view.top <= view.maxTop);
        assert.ok(view.end - view.start <= 5 * screen + 2 * 8 + 2);
        assert.ok(view.fetchStart <= view.trackStart && view.trackEnd <= view.fetchEnd, "every rendered row is demanded");
        assert.ok(view.trackEnd <= total && view.fetchEnd <= total);
        // The window is computed from a stepped offset; the rows at the real one must be in it.
        const real = Math.min(scrollTop, Math.max(0, count * rowHeight - (height - 28)));
        const first = Math.min(count, Math.floor(real / rowHeight));
        const last = Math.min(count, Math.ceil((real + height - 28) / rowHeight));
        assert.ok(view.start <= first && last <= view.end, "the visible rows are rendered");
        assert.ok(first - view.start >= Math.min(first, screen) && view.end - last >= Math.min(count - last, screen),
          "at least a screen is rendered beyond each edge");
        // A fast scroll moves rows from behind the motion to ahead of it; a jump renders the screen it landed on.
        for (const direction of [-1, 1] as const) {
          const top = libraryWindowTop(scrollTop, rowHeight);
          const fast = libraryViewport({ total, pending, rowHeight, height, top, headerHeight: 28, direction });
          assert.ok(fast.end - fast.start <= 5 * screen + 2 * 8 + 2, "a fast scroll renders no more rows than a resting table");
          assert.ok(fast.start <= first && last <= fast.end);
          const [behind, ahead] = direction > 0 ? [first - fast.start, fast.end - last] : [fast.end - last, first - fast.start];
          const [roomBehind, roomAhead] = direction > 0 ? [first, count - last] : [count - last, first];
          assert.ok(ahead >= Math.min(roomAhead, 3 * screen), "three screens ahead of the motion");
          assert.ok(behind >= Math.min(roomBehind, screen) && behind <= screen + 8, "one screen behind it");
          const jump = libraryViewport({ total, pending, rowHeight, height, top, headerHeight: 28, direction, jump: true });
          assert.ok(jump.start <= first && last <= jump.end, "the screen a jump landed on is rendered");
          assert.ok(jump.end - jump.start <= 2 * screen + 2 * 8 + 2);
          assert.ok(jump.fetchStart <= jump.trackStart && jump.trackEnd <= jump.fetchEnd);
          // A jump that keeps being outrun renders around where the viewport is going, not where it was.
          const lead = direction * 4 * height;
          const aimed = libraryViewport({ total, pending, rowHeight, height, top, headerHeight: 28, direction, jump: true, lead });
          const aim = Math.min(aimed.maxTop, Math.max(0, aimed.top + lead));
          assert.ok(aimed.start <= Math.min(count, Math.floor(aim / rowHeight)));
          assert.ok(aimed.end >= Math.min(count, Math.ceil((aim + height - 28) / rowHeight)), "the aimed screen is rendered");
          assert.ok(0 <= aimed.start && aimed.start <= aimed.end && aimed.end <= count);
          assert.ok(aimed.end - aimed.start <= 2 * screen + 2 * 8 + 2);
          assert.ok(aimed.fetchStart <= aimed.trackStart && aimed.trackEnd <= aimed.fetchEnd && aimed.fetchEnd <= total);
        }
      }
    }
  assert.equal(restoreLibraryAnchor([1, 3, 4], 2, 1, 5, 36, 0), 41);
  assert.equal(restoreLibraryAnchor([1, 2, 3], 3, 0, 5, 36, 2), 149);
});

test("scroll pace: wheel notches stay calm, a flick turns fast with hysteresis, a jump is one long frame", () => {
  const run = (pace: LibraryScrollPace, frames: number, travel: number, elapsed = 16) => {
    for (let i = 0; i < frames; i += 1) pace = libraryScrollPace(pace, travel, elapsed, 700);
    return pace;
  };
  // One notch moves a hundred pixels in a single frame; ten a second is still an ordinary scroll.
  let pace = LIBRARY_REST_PACE;
  for (let notch = 0; notch < 10; notch += 1) {
    pace = libraryScrollPace(pace, 100, notch ? 100 : 16, 700);
    assert.deepEqual([pace.fast, pace.direction, pace.jump, pace.lead], [false, 0, false, 0]);
  }
  // Reading speed: a screen and a half per second.
  assert.equal(run(LIBRARY_REST_PACE, 60, 16).fast, false);
  // A trackpad flick at 6000 px/s is fast within a few frames, in its own direction.
  const flick = run(LIBRARY_REST_PACE, 6, 96);
  assert.deepEqual([flick.fast, flick.direction, flick.jump], [true, 1, false]);
  assert.deepEqual([run(LIBRARY_REST_PACE, 6, -96).direction, run(flick, 1, -96).direction], [-1, -1]);
  // Momentum decays: still fast at 2000 px/s, calm again below 1200 px/s.
  assert.equal(run(flick, 30, 32).fast, true);
  const calm = run(flick, 40, 12);
  assert.deepEqual([calm.fast, calm.direction], [false, 0]);
  assert.equal(run(LIBRARY_REST_PACE, 40, 32).fast, false, "2000 px/s does not start a fast scroll");
  // A dragged handle, or a page that stalled while the WebView kept scrolling: two screens in one frame.
  const jump = libraryScrollPace(LIBRARY_REST_PACE, -1400, 16, 700);
  assert.deepEqual([jump.fast, jump.direction, jump.jump], [true, -1, true]);
  const stalled = libraryScrollPace(calm, 1500, 400, 700);
  assert.deepEqual([stalled.fast, stalled.direction, stalled.jump], [true, 1, true]);
  assert.equal(libraryScrollPace(jump, -200, 16, 700).jump, false, "a jump lasts one frame");
  // A frame with no travel keeps the direction of the scroll it belongs to.
  assert.equal(libraryScrollPace(flick, 0, 16, 700).direction, 1);
  // Outrun twice in a row by the scrolling thread: aim a frame of travel ahead, within a limit.
  const first = libraryScrollPace(flick, 2000, 60, 700, true);
  assert.deepEqual([first.jump, first.lead], [true, 0], "one long frame may be a single stall");
  assert.equal(libraryScrollPace(first, 2100, 60, 700, true).lead, 2100);
  assert.equal(libraryScrollPace(first, 90_000, 60, 700, true).lead, 5600);
  assert.equal(libraryScrollPace(first, -2100, 60, 700, true).lead, 0, "a reversal is not the same scroll");
  assert.equal(libraryScrollPace(first, 2100, 60, 700).lead, 0, "a scroll the page performs is where it says");
  assert.equal(libraryScrollPace(libraryScrollPace(first, 2100, 60, 700, true), 300, 16, 700, true).lead, 0);
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
