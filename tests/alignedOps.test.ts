import assert from "node:assert/strict";
import test from "node:test";
import { alignedOps, type AlignPlan, type LaneClip } from "../src/lib/lanes";

const clip: LaneClip = { id: "c2", src: "/v/op.mp4", at: 10, in: 0, out: 90, muted: true, fill: true };
const plan: AlignPlan = {
  id: "melody-1-beat", label: "裁切匹配段", auto: false,
  segments: [{ video_in: 20, video_out: 78, ref_at: 37.379, speed: 0.90625 }],
};

test("a plan lands where the song's second plays, at the song's speed too", () => {
  // The song from its 10th second, played 1.1 times as fast, from the project's 5th.
  const ops = alignedOps(clip, "v1", plan, { at: 5, in: 10, length: 240, speed: 1.1 });
  assert.equal(ops[0].op, "remove");
  const add = ops[1];
  assert.ok(add.op === "add");
  assert.equal(add.at, Math.round((5 + (37.379 - 10) / 1.1) * 1000) / 1000);
  assert.equal(add.clip.speed, Math.round(0.90625 * 1.1 * 1e6) / 1e6);
  assert.equal(add.clip.in, 20);
  assert.equal(add.clip.out, 78);
  assert.equal(add.clip.muted, true);
});

test("a song at its own speed keeps the plan's speed to a millionth", () => {
  const ops = alignedOps(clip, "v1", { ...plan, segments: [{ ...plan.segments[0], speed: 0.906234 }] }, { at: 0, in: 0, length: 275 });
  assert.ok(ops[1].op === "add");
  assert.equal(ops[1].clip.speed, 0.906234);
  assert.equal(ops[1].at, 37.379);
});
