import assert from "node:assert/strict";
import test from "node:test";
import {
  barTime, forkMoments, forkProblems, forkSpan, replaceRange, repeats, songPlace, visibleAt, type Doc, type Fork,
} from "../crates/kdj-server/src/ai/kdj-timeline";
import { forkStrip, laneView, rulerStep, type AskTimeline } from "../src/lib/aiTimeline";

// 120 BPM in 4/4: a bar every 2 s, the first downbeat at 0.5 s.
const DOWNBEATS = Array.from({ length: 40 }, (_, n) => 0.5 + n * 2);
const BASE = "/music/set";

function draft(): Doc {
  return {
    kdjv: 1,
    title: "草稿",
    extra: { kept: true },
    tracks: [
      { clips: [] },
      { clips: [
        { src: "/vj/nced.mp4", at: 0, in: 0, out: 30, muted: true },
        { src: "/vj/ncop.mp4", at: 46.5, in: 10, out: 40, muted: true, fade_in: 1 },
      ] },
      { clips: [{ src: "song.flac", at: 0, in: 0, out: 80 }] },
    ],
  };
}

const gap: Fork = {
  id: "gap-1", kind: "gap", from_bar: 16, to_bar: 24, track: 1, question: "空档怎么补",
  options: [
    { id: "ncop", label: "NCOP", clips: [{ src: "/vj/ncop.mp4", at: 30.5, in: 60, out: 76, muted: true }] },
    { id: "black", label: "留黑", clips: [] },
  ],
};

test("a bar is its downbeat, the bar after the last one is reckoned, and no further", () => {
  assert.equal(barTime(DOWNBEATS, 1), 0.5);
  assert.equal(barTime(DOWNBEATS, 16), 30.5);
  assert.equal(barTime(DOWNBEATS, 41), 80.5);
  assert.throws(() => barTime(DOWNBEATS, 42), /超出/);
  assert.throws(() => barTime([], 1), /没有小节线/);
  assert.throws(() => barTime(DOWNBEATS, 0), /无效/);
});

test("bars are placed by where the song sits in the draft", () => {
  const doc = draft();
  const place = songPlace(doc, "/music/set/song.flac", BASE);
  assert.deepEqual(forkSpan(gap, DOWNBEATS, place), { start: 30.5, end: 46.5 });
  const later = { ...doc, tracks: [{ clips: [{ src: "/music/set/song.flac", at: 10, in: 4, out: 80 }] }] };
  assert.deepEqual(forkSpan(gap, DOWNBEATS, songPlace(later, "/music/set/song.flac", BASE)), { start: 36.5, end: 52.5 });
  assert.throws(() => songPlace(doc, "/other.flac", BASE), /不在草稿里/);
});

test("an option replaces what its track holds in the place; a clip across an edge keeps its outside part", () => {
  const doc = draft();
  const across = replaceRange(doc, 1, 20, 50, gap.options[0].clips);
  const clips = across.tracks![1].clips!;
  assert.deepEqual(clips.map(clip => [clip.src, clip.at, clip.in, clip.out]), [
    ["/vj/nced.mp4", 0, 0, 20],
    ["/vj/ncop.mp4", 30.5, 60, 76],
    ["/vj/ncop.mp4", 50, 13.5, 40],
  ]);
  assert.equal(clips[2].fade_in, undefined, "the fade on the cut side goes");
  assert.deepEqual(across.extra, { kept: true }, "unknown fields stay");
  assert.equal(doc.tracks![1].clips!.length, 2, "the draft itself is left as it was");
  const empty = replaceRange(doc, 1, 30.5, 46.5, []);
  assert.equal(empty.tracks![1].clips!.length, 2, "clips that only touch the place stay whole");
  assert.throws(() => replaceRange(doc, 5, 0, 1, []), /track 5/);
});

test("forks are refused for options outside their place, too few options, the same filling twice and overlaps", () => {
  const span = { start: 30.5, end: 46.5 };
  assert.deepEqual(forkProblems([gap], [span]), []);
  const outside: Fork = { ...gap, options: [gap.options[0], { id: "late", label: "晚了", clips: [{ src: "/vj/a.mp4", at: 40, in: 0, out: 10 }] }] };
  assert.match(forkProblems([outside], [span]).join(), /超出岔口/);
  assert.match(forkProblems([{ ...gap, options: [gap.options[0]] }], [span]).join(), /2–4 个选项/);
  assert.match(forkProblems([{ ...gap, options: [gap.options[1], { ...gap.options[1], id: "x" }] }], [span]).join(), /一样/);
  assert.match(forkProblems([{ ...gap, default: "none" }], [span]).join(), /default/);
  assert.match(forkProblems([gap, { ...gap, id: "gap-2" }], [span, { start: 40, end: 50 }]).join(), /重叠/);
});

test("an option that shows a stretch of footage the draft shows elsewhere is a repeat", () => {
  const doc = draft();
  const reuse = [{ src: "/vj/ncop.mp4", at: 30.5, in: 20, out: 36, muted: true }];
  assert.match(repeats(replaceRange(doc, 1, 30.5, 46.5, reuse), reuse, BASE).join(), /重复/);
  assert.deepEqual(repeats(replaceRange(doc, 1, 30.5, 46.5, gap.options[0].clips), gap.options[0].clips, BASE), []);
});

test("the picture at a moment is the top track's, at its time inside the source", () => {
  const doc = replaceRange(draft(), 0, 10, 12, [{ src: "flash.mov", at: 10, in: 0, out: 2 }]);
  assert.deepEqual(visibleAt(doc, 11, BASE), { src: "/music/set/flash.mov", at: 1, image: false });
  assert.deepEqual(visibleAt(doc, 5, BASE), { src: "/vj/nced.mp4", at: 5, image: false });
  assert.equal(visibleAt(doc, 35, BASE), null, "nothing on screen in the gap");
  assert.deepEqual(forkMoments(0, 12, 80), { before: null, inside: [2, 6, 10], after: 12.2 });
});

test("the bubble's lanes put the picked option in the fork's place, and the ruler names about a dozen bars", () => {
  const timeline: AskTimeline = {
    project: "/music/set/a.kdjv", title: "a", duration: 80, bars: [], frames: {},
    tracks: [[{ at: 0, length: 30, label: "nced", kind: "video" }, { at: 46.5, length: 30, label: "ncop", kind: "video" }]],
    forks: [{
      id: "gap-1", kind: "gap", question: "", from_bar: 16, to_bar: 24, track: 0, start: 20, end: 50, default: "ncop",
      before: "a@1", after: null,
      options: [
        { id: "ncop", label: "NCOP", note: "", frames: ["b@1", "b@2", ""], clips: [{ at: 20, length: 30, label: "ncop", kind: "video" }] },
        { id: "black", label: "留黑", note: "", frames: ["", "", ""], clips: [] },
      ],
    }],
  };
  const lane = laneView(timeline, { "gap-1": "ncop" })[0];
  assert.deepEqual(lane.map(clip => [clip.label, clip.at, clip.length, clip.filled]), [
    ["nced", 0, 20, false], ["ncop", 20, 30, true], ["ncop", 50, 26.5, false],
  ]);
  assert.equal(laneView(timeline, { "gap-1": "black" })[0].length, 2);
  assert.deepEqual(forkStrip(timeline.forks[0], timeline.forks[0].options[0]).map(item => item.key), ["a@1", "b@1", "b@2", "", null]);
  assert.equal(rulerStep(96), 8);
  assert.equal(rulerStep(10), 1);
});
