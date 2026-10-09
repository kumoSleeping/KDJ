import assert from "node:assert/strict";
import test from "node:test";
import {
  COVER_RETRY_ROUNDS,
  coverFailed,
  coverLoadStart,
  coverLoadView,
  coverLoaded,
  coverRenewed,
  coverRetried,
  newerRevision,
} from "../src/lib/coverLoad";
import { onlineCoverUrls, thumbUrl } from "../src/lib/format";

const sized = "/cover/7?v=a&size=256", original = "/cover/7?v=a";
const urls = [sized, original];

test("a cover that loads is shown, whatever was reported about another track before it", () => {
  let state = coverLoadStart(7, urls);
  assert.deepEqual(coverLoadView(state, 7, urls), { src: sized, face: "loading", retryDue: false });
  state = coverLoaded(state, 7, urls, sized);
  assert.equal(coverLoadView(state, 7, urls).face, "image");
  // The same box now shows track 8: nothing of track 7 counts, neither its picture nor a failure.
  const next = ["/cover/8?v=a&size=256", "/cover/8?v=a"];
  assert.deepEqual(coverLoadView(state, 8, next), { src: next[0], face: "loading", retryDue: false });
  state = coverFailed(coverFailed(state, 8, next, next[0]), 8, next, next[1]);
  assert.equal(coverLoadView(state, 8, next).face, "missing");
  assert.deepEqual(coverLoadView(state, 7, urls), { src: sized, face: "loading", retryDue: false });
  // A load that is reported twice, or before anything else, never leaves the cover hidden.
  state = coverLoaded(coverLoaded(state, 7, urls, sized), 7, urls, sized);
  assert.equal(coverLoadView(state, 7, urls).face, "image");
});

test("the original takes over when the thumbnail cannot be made", () => {
  let state = coverFailed(coverLoadStart(7, urls), 7, urls, sized);
  assert.deepEqual(coverLoadView(state, 7, urls), { src: original, face: "loading", retryDue: false });
  state = coverLoaded(state, 7, urls, original);
  assert.deepEqual(coverLoadView(state, 7, urls), { src: original, face: "image", retryDue: false });
  // Reports about addresses the box no longer offers change nothing.
  assert.equal(coverFailed(state, 7, urls, "/cover/7?v=old&size=256"), state);
  assert.equal(coverLoaded(state, 7, urls, "/cover/7?v=old"), state);
});

test("a list that failed is asked once more behind the no-cover face, and no further", () => {
  let state = coverFailed(coverFailed(coverLoadStart(7, urls), 7, urls, sized), 7, urls, original);
  assert.deepEqual(coverLoadView(state, 7, urls), { src: "", face: "missing", retryDue: true });
  state = coverRetried(state, 7, urls);
  // The second round loads from the first address again without raising the loading placeholder.
  assert.deepEqual(coverLoadView(state, 7, urls), { src: sized, face: "missing", retryDue: false });
  const recovered = coverLoaded(state, 7, urls, sized);
  assert.deepEqual(coverLoadView(recovered, 7, urls), { src: sized, face: "image", retryDue: false });
  state = coverFailed(coverFailed(state, 7, urls, sized), 7, urls, original);
  assert.equal(state.round, COVER_RETRY_ROUNDS);
  assert.deepEqual(coverLoadView(state, 7, urls), { src: "", face: "missing", retryDue: false });
  // A track with nothing to ask for has nothing to retry.
  assert.deepEqual(coverLoadView(coverLoadStart(-3), -3, []), { src: "", face: "missing", retryDue: false });
});

test("a new revision replaces the picture in place and is not held to earlier failures", () => {
  const revised = ["/cover/7?v=b&size=256", "/cover/7?v=b"];
  // Shown, then the track is saved: the old picture stays up while the new address loads.
  let state = coverLoaded(coverLoadStart(7, urls), 7, urls, sized);
  assert.deepEqual(coverLoadView(state, 7, revised), { src: revised[0], face: "image", retryDue: false });
  // The new thumbnail fails: nothing is on screen any more, so the placeholder covers the wait.
  state = coverFailed(state, 7, revised, revised[0]);
  assert.deepEqual(coverLoadView(state, 7, revised), { src: revised[1], face: "loading", retryDue: false });

  // No cover, retries spent, then a cover is written: the new addresses are asked, with a
  // retry owed again, and the box keeps its no-cover face until a picture has arrived.
  state = coverFailed(coverFailed(coverLoadStart(7, urls), 7, urls, sized), 7, urls, original);
  state = coverRetried(state, 7, urls);
  state = coverFailed(coverFailed(state, 7, urls, sized), 7, urls, original);
  assert.deepEqual(coverLoadView(state, 7, revised), { src: revised[0], face: "missing", retryDue: false });
  state = coverFailed(coverFailed(state, 7, revised, revised[0]), 7, revised, revised[1]);
  assert.equal(coverLoadView(state, 7, revised).retryDue, true);
  state = coverLoaded(coverRetried(state, 7, revised), 7, revised, revised[0]);
  assert.equal(coverLoadView(state, 7, revised).face, "image");

  // Written again under an unchanged address: the failures are dropped, the picture is not.
  state = coverFailed(coverFailed(coverLoadStart(7, urls), 7, urls, sized), 7, urls, original);
  assert.deepEqual(coverLoadView(coverRenewed(state, 7, urls), 7, urls), { src: sized, face: "missing", retryDue: false });
  const shown = coverLoaded(coverLoadStart(7, urls), 7, urls, sized);
  assert.equal(coverRenewed(shown, 7, urls), shown);
});

test("an online cover offers its small rendition, then the address as given", () => {
  assert.deepEqual(onlineCoverUrls("http://p1.music.126.net/a/b.jpg", 96),
    ["https://p1.music.126.net/a/b.jpg?param=96y96", "https://p1.music.126.net/a/b.jpg"]);
  assert.deepEqual(onlineCoverUrls("//i2.hdslb.com/bfs/archive/c.jpg", 96),
    ["https://i2.hdslb.com/bfs/archive/c.jpg@192w_192h_1c.jpg", "https://i2.hdslb.com/bfs/archive/c.jpg"]);
  // The player-bar disc loads the first address, so the two share one cached response.
  assert.equal(onlineCoverUrls("https://y.gtimg.cn/music/photo_new/T002R300x300M000x.jpg", 96)[0],
    thumbUrl("https://y.gtimg.cn/music/photo_new/T002R300x300M000x.jpg", 96));
  // An address no rule resizes is offered once; no cover offers nothing.
  assert.deepEqual(onlineCoverUrls("https://example.com/cover.png", 96), ["https://example.com/cover.png"]);
  assert.deepEqual(onlineCoverUrls("", 96), []);
  assert.deepEqual(onlineCoverUrls("  ", 96), []);
});

test("a library cover is asked for under the later of the held and the listed revision", () => {
  assert.equal(newerRevision("2026-10-09T20:08:54Z", "2026-10-09T20:10:54Z"), "2026-10-09T20:10:54Z");
  assert.equal(newerRevision("2026-10-09T20:10:54Z", "2026-10-09T20:08:54Z"), "2026-10-09T20:10:54Z");
  assert.equal(newerRevision("2026-10-09T20:10:54Z", undefined), "2026-10-09T20:10:54Z");
  assert.equal(newerRevision("", "2026-10-09T20:10:54Z"), "2026-10-09T20:10:54Z");
});
