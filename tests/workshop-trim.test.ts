import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustClip, clipDuration, clipLanes, fadeAlpha, setClipSpeed, sourceAt, splitClip,
  validateProject, visibleFade,
} from "../src/lib/workshop";
import type { CompositionProject, WorkshopClip } from "../src/types/workshop";

function project(): CompositionProject {
  const clip: WorkshopClip = {
    id: "clip", source_id: "source", start_ms: 0, source_in_ms: 0, source_out_ms: 10000,
    speed: { preset: "constant", start: 1, middle: 1, end: 1, domain_start_ms: 0, domain_end_ms: 10000 },
    picture: { x: .5, y: .5, scale: 1, opacity: 1 },
    sound: { muted: false, gain: 1, manual: false },
    fades: { offset_ms: 0, span_ms: 10000, audio_in_ms: 1000, audio_out_ms: 600,
      video_in_ms: 800, video_out_ms: 400, linear: false },
  };
  return {
    id: "project", revision: 0, name: "trim", migrated_from: null,
    sources: [{ id: "source", track_id: 1, path: "/source.mp4", title: "source", duration_ms: 10000,
      video: true, audio: true, width: 1920, height: 1080, fps: 25, signature: "source" }],
    layers: [{ id: "layer", source_id: "source", clips: [clip] }],
    canvas: { width: 1920, height: 1080, fps: 25, initialized: true },
    output: { name: "trim", directory: "", in_ms: 0, out_ms: null, quality: 20, acceleration: "auto" },
  };
}

test("trimming either edge of a split clip never reintroduces hidden parent fades", () => {
  const original = project(), split = splitClip(original, "clip", 5000);
  const [left, right] = split.layers[0].clips;
  for (const [clip, handle, delta, hiddenEnd] of [
    [right, "out", -100, false], [right, "in", 100, false],
    [left, "out", -100, true], [left, "in", 100, true],
  ] as const) {
    const edited = adjustClip(split, clip.id, handle, delta);
    const cut = edited.layers[0].clips.find(c => c.id === clip.id)!;
    for (const audio of [false, true]) {
      assert.equal(visibleFade(cut, hiddenEnd, audio), 0);
      assert.equal(fadeAlpha(cut, hiddenEnd ? clipDuration(cut) : 0, audio), 1);
      assert.equal(visibleFade(cut, !hiddenEnd, audio), visibleFade(clip, !hiddenEnd, audio));
    }
    assert.equal(validateProject(edited), "");
  }
  assert.equal(original.layers[0].clips[0].source_out_ms, 10000, "the input project is immutable");
  assert.equal(right.fades.offset_ms, 5000, "the split snapshot keeps its inherited envelope");
});

test("speed changes preserve visible outer fades and retain the parent source domain", () => {
  const split = splitClip(project(), "clip", 5000);
  for (const [index, hiddenEnd] of [[0, true], [1, false]] as const) {
    const before = split.layers[0].clips[index], clip = structuredClone(before);
    setClipSpeed(clip, 2);
    assert.equal(clipDuration(clip), 2500);
    assert.equal(clip.start_ms, before.start_ms);
    assert.equal(clip.source_in_ms, before.source_in_ms);
    assert.equal(clip.source_out_ms, before.source_out_ms);
    assert.equal(clip.speed.domain_start_ms, 0);
    assert.equal(clip.speed.domain_end_ms, 10000);
    for (const audio of [false, true]) {
      assert.equal(visibleFade(clip, hiddenEnd, audio), 0);
      assert.equal(fadeAlpha(clip, hiddenEnd ? clipDuration(clip) : 0, audio), 1);
      assert.equal(visibleFade(clip, !hiddenEnd, audio), visibleFade(before, !hiddenEnd, audio));
    }
    // Successive rates must use the currently visible cut, not resurrect parent values.
    setClipSpeed(clip, .5);
    assert.equal(clipDuration(clip), 10000);
    assert.equal(visibleFade(clip, hiddenEnd, true), 0);
  }
});

test("curve presets keep source-time mapping and bound visible fades to the new duration", () => {
  const p = project(), clip = p.layers[0].clips[0];
  clip.source_in_ms = 4500; clip.source_out_ms = 5500;
  clip.fades.offset_ms = 0; clip.fades.span_ms = 1000;
  clip.fades.audio_in_ms = 400; clip.fades.audio_out_ms = 400;
  clip.fades.video_in_ms = 400; clip.fades.video_out_ms = 400;
  setClipSpeed(clip, { preset: "ramp", start: .5, middle: 1, end: 2 });
  assert.equal(sourceAt(clip, 0), 4500);
  assert.equal(sourceAt(clip, clipDuration(clip)), 5500);
  assert.equal(clip.speed.domain_start_ms, 0);
  assert.equal(clip.speed.domain_end_ms, 10000);
  assert.ok(clip.fades.audio_in_ms <= clipDuration(clip) / 2);
  assert.equal(validateProject(p), "");
});

test("no-op trims, repeated speed choices, invalid rates and images preserve their envelope", () => {
  const split = splitClip(project(), "clip", 500), right = split.layers[0].clips[1];
  assert.ok(fadeAlpha(right, 0, true) > 0 && fadeAlpha(right, 0, true) < 1);
  for (const [handle, delta] of [["in", 0], ["out", 0], ["out", 100]] as const)
    assert.deepEqual(adjustClip(split, right.id, handle, delta).layers[0].clips[1], right);
  const clip = structuredClone(right);
  for (const rate of [1, 0, 3, NaN, Infinity]) setClipSpeed(clip, rate);
  assert.deepEqual(clip, right);
  clip.display_duration_ms = 5000; clip.animation_offset_ms = 500;
  const image = structuredClone(clip);
  setClipSpeed(clip, 2);
  assert.deepEqual(clip, image);
});

test("slowing a cut keeps neighbours fixed and lays overlaps out in separate visual lanes", () => {
  const split = splitClip(project(), "clip", 5000), [left, right] = split.layers[0].clips;
  setClipSpeed(left, .5);
  assert.equal(right.start_ms, 5000);
  assert.equal(validateProject(split), "");
  const lanes = clipLanes(split.layers[0].clips);
  assert.equal(lanes.get(left.id), 0);
  assert.equal(lanes.get(right.id), 1);
});
