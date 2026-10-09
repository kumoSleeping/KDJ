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
  workshopExportCovers,
  workshopSourceCover,
  workshopSourceCovers,
  type TaskCoverAddresses,
} from "../src/lib/taskCovers";
import type { CompositionProject, WorkshopClip, WorkshopSource } from "../src/types/workshop";

const at: TaskCoverAddresses = {
  library: (trackId, size) => `/cover/${trackId}?size=${size}`,
  frame: (projectId, sourceId, ms) => `/frame/${projectId}/${sourceId}?ms=${ms}`,
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

const source = (id: string, patch: Partial<WorkshopSource> = {}): WorkshopSource => ({
  id, track_id: 0, path: `/media/${id}`, title: id, duration_ms: 60_000, video: false, audio: true,
  width: 0, height: 0, fps: 0, signature: id, ...patch,
});
const clip = (sourceId: string, sourceIn = 0) => ({ id: `${sourceId}-clip-${sourceIn}`, source_id: sourceId, source_in_ms: sourceIn }) as unknown as WorkshopClip;
const project = (sources: WorkshopSource[], layers: [string, number][][]): Pick<CompositionProject, "id" | "sources" | "layers"> => ({
  id: "p", sources,
  layers: layers.map((clips, index) => ({ id: `layer-${index}`, source_id: clips[0]?.[0] ?? "", clips: clips.map(([id, start]) => clip(id, start)) })) as CompositionProject["layers"],
});

test("a mix is shown by its sources: pictures before sounds, library picture before a frame", () => {
  const mix = project(
    [source("song", { track_id: 3 }), source("clip", { video: true, track_id: 7 }), source("still", { kind: "image", audio: false }),
      source("voice"), source("unused", { video: true })],
    [[["song", 0]], [["clip", 4000], ["clip", 1500]], [["still", 0]], [["voice", 0]]],
  );
  assert.deepEqual(workshopSourceCovers(mix, at), [
    [`/cover/7?size=${TASK_COVER_PX}`, "/frame/p/clip?ms=1500"],
    ["/frame/p/still?ms=0"],
    [`/cover/3?size=${TASK_COVER_PX}`],
  ], "the frame is where the source's earliest cut starts; a sound outside the library and an unused source show nothing");
  assert.deepEqual(workshopSourceCover("p", mix.sources[1], at), [`/cover/7?size=${TASK_COVER_PX}`, "/frame/p/clip?ms=0"]);
  assert.deepEqual(workshopSourceCover("p", mix.sources[3], at), []);
  // Two layers cut from one source are one picture.
  const twice = project([source("clip", { video: true })], [[["clip", 0]], [["clip", 0]]]);
  assert.equal(workshopSourceCovers(twice, at).length, 1);
});

test("a finished export shows the finished file and falls back to what it was made of", () => {
  const mix = project([source("song", { track_id: 3 }), source("clip", { video: true })], [[["clip", 0]], [["song", 0]]]);
  const sources = [["/frame/p/clip?ms=0"], [`/cover/3?size=${TASK_COVER_PX}`]];
  assert.deepEqual(workshopExportCovers(mix, undefined, at), sources);
  assert.deepEqual(workshopExportCovers(mix, { track_id: null }, at), sources, "exported but not in the library");
  assert.deepEqual(workshopExportCovers(mix, { track_id: 9 }, at),
    [[`/cover/9?size=${TASK_COVER_PX}`, "/frame/p/clip?ms=0", `/cover/3?size=${TASK_COVER_PX}`]]);
  assert.deepEqual(workshopExportCovers(undefined, { track_id: 9 }, at), [[`/cover/9?size=${TASK_COVER_PX}`]], "the project was deleted since");
  assert.deepEqual(workshopExportCovers(undefined, undefined, at), []);
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
  const mix = project([source("song", { track_id: 3 }), source("clip", { video: true })], [[["clip", 0]], [["song", 0]]]);
  assert.deepEqual(taskCovers({ kind: "workshop", project: mix }, at), ["/frame/p/clip?ms=0", `/cover/3?size=${TASK_COVER_PX}`]);
  assert.equal(taskCoverKind({ kind: "download", task: { ...task, kind: "audio" } }), "song");
  assert.equal(taskCoverKind({ kind: "download", task: { ...task, kind: "video", quality: "1080" } }), "video");
  assert.equal(taskCoverKind({ kind: "download", task: { ...task, kind: "video", quality: "audio" } }), "song", "a video that only keeps its sound");
  assert.equal(taskCoverKind({ kind: "workshop" }), "mix");
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
