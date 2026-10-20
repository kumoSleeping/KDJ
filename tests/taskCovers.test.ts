import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_COVER_PX,
  downloadTaskCovers,
  platformThumbnail,
  taskCoverKind,
  taskCoverStack,
  taskCovers,
  visualizerExportCovers,
  type TaskCoverAddresses,
} from "../src/lib/taskCovers";

const at: TaskCoverAddresses = {
  library: (trackId, size) => `/cover/${trackId}?size=${size}`,
};
const task = { cover: "", track_id: null, platform: "wyy" as const, source_key: "" };

test("a download keeps the cover it was searched with and falls back to the library, then the platform", () => {
  const cover = "http://p1.music.126.net/abc/1.jpg";
  assert.deepEqual(downloadTaskCovers({ ...task, cover }, at), [
    `https://p1.music.126.net/abc/1.jpg?param=${TASK_COVER_PX}y${TASK_COVER_PX}`,
    "https://p1.music.126.net/abc/1.jpg",
  ], "the small rendition first, then the address as the provider gave it, both over https");
  // Queued, running and finished: the stored cover stays in front, so nothing is asked for
  // again when the task is imported; the library's picture only joins behind it.
  assert.deepEqual(downloadTaskCovers({ ...task, cover, track_id: 12 }, at).slice(0, 2),
    downloadTaskCovers({ ...task, cover }, at));
  assert.equal(downloadTaskCovers({ ...task, cover, track_id: 12 }, at)[2], `/cover/12?size=${TASK_COVER_PX}`);
  // A history entry without a stored cover shows the downloaded file's own picture.
  assert.deepEqual(downloadTaskCovers({ ...task, track_id: 12 }, at), [`/cover/12?size=${TASK_COVER_PX}`]);
  assert.deepEqual(downloadTaskCovers({ ...task, cover: "   ", track_id: 0 }, at), [], "no picture anywhere");
  assert.deepEqual(downloadTaskCovers({ ...task, track_id: 12 }, at, 64), ["/cover/12?size=64"]);
});

test("only YouTube has a thumbnail that follows from the source id", () => {
  assert.equal(platformThumbnail("youtube", "dQw4w9WgXcQ"), "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
  assert.equal(platformThumbnail("ytm", " dQw4w9WgXcQ "), "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
  assert.equal(platformThumbnail("youtube", "https://youtu.be/dQw4w9WgXcQ"), "", "a key that is not a bare id is not guessed at");
  assert.equal(platformThumbnail("bilibili", "BV1xx411c7mD"), "");
  assert.equal(platformThumbnail("wyy", "12345678901"), "");
  assert.equal(platformThumbnail("youtube", undefined), "");
  assert.deepEqual(downloadTaskCovers({ cover: "", track_id: 5, platform: "youtube", source_key: "dQw4w9WgXcQ" }, at),
    [`/cover/5?size=${TASK_COVER_PX}`, "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"]);
});

test("a visualizer export shows the project's picture, then its song's cover", () => {
  assert.deepEqual(visualizerExportCovers({ poster: "blob:poster", trackId: 4 }, at), ["blob:poster", `/cover/4?size=${TASK_COVER_PX}`]);
  assert.deepEqual(visualizerExportCovers({ poster: "", trackId: 4 }, at), [`/cover/4?size=${TASK_COVER_PX}`]);
  assert.deepEqual(visualizerExportCovers({ trackId: null }, at), []);
});

test("one call covers every kind of task, and names the glyph of each", () => {
  assert.deepEqual(taskCovers({ kind: "download", task: { ...task, track_id: 2 } }, at), [`/cover/2?size=${TASK_COVER_PX}`]);
  assert.deepEqual(taskCovers({ kind: "track", trackId: 2 }, at, 64), ["/cover/2?size=64"]);
  assert.deepEqual(taskCovers({ kind: "visualizer", poster: "blob:x" }, at), ["blob:x"]);
  assert.equal(taskCoverKind({ kind: "download", task: { ...task, kind: "audio" } }), "song");
  assert.equal(taskCoverKind({ kind: "download", task: { ...task, kind: "video", quality: "1080" } }), "video");
  assert.equal(taskCoverKind({ kind: "download", task: { ...task, kind: "video", quality: "audio" } }), "song", "a video that only keeps its sound");
  assert.equal(taskCoverKind({ kind: "visualizer" }), "visualizer");
  assert.equal(taskCoverKind({ kind: "track", trackId: 1, video: true }), "video");
});

test("a batch is shown by at most three different pictures and a count of the rest", () => {
  const lists = [["a1", "a2"], ["b"], ["c"], ["d"], ["e"]];
  assert.deepEqual(taskCoverStack(lists), { covers: [["a1", "a2"], ["b"], ["c"]], more: 2 });
  assert.deepEqual(taskCoverStack(lists, 2), { covers: [["a1", "a2"], ["b"]], more: 3 });
  assert.deepEqual(taskCoverStack(lists.slice(0, 2)), { covers: [["a1", "a2"], ["b"]], more: 0 });
  // An album's songs share one cover: one picture, the others counted.
  assert.deepEqual(taskCoverStack([["a"], ["a"], ["a"], ["b"]]), { covers: [["a"], ["b"]], more: 2 });
  // Tasks without a picture never take a place a picture could have.
  assert.deepEqual(taskCoverStack([[], ["a"], [""], ["b"]]), { covers: [["a"], ["b"]], more: 2 });
  // No picture at all: one empty place for the no-picture face, the rest counted.
  assert.deepEqual(taskCoverStack([[], [], []]), { covers: [[]], more: 2 });
  assert.deepEqual(taskCoverStack([]), { covers: [], more: 0 });
  assert.deepEqual(taskCoverStack([["a"], ["b"]], 0), { covers: [["a"]], more: 1 }, "a stack always has room for one");
});
