import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TrackSummary } from "../src/types";
import type { VisualizerFeatureTimeline } from "../src/types/audioVisualizer";
import { createVisualizerProject, validateVisualizerProject, syncVisualizerImages, parseVisualizerLyrics, lyricIndex, sampleStudioFeatures, prepareStudioMotion, sampleStudioMotion, safeVisualizerName, studioClock, serializeVisualizerDraft, deserializeVisualizerDraft, studioCredits, fillStudioCredits, studioPictures, withStudioPictures } from "../src/lib/visualizerStudio";
const track = { id: 42, path: "/music/pinned.wav", title: "JAPANIZED BLUE", artist: "cold kiss", album: "Album", filename: "pinned.wav" } as TrackSummary;
function project() { const p = createVisualizerProject(track); syncVisualizerImages(p, 1); return p; }
function timeline(): VisualizerFeatureTimeline { return { version: 1, sample_rate: 22050, sample_count: 22050 * 3, fps: 30, frames: Array.from({ length: 90 }, (_, i) => ({ bands: Array(64).fill(i === 30 ? .8 : 0), bass: i === 30 ? .8 : 0, rms: i === 30 ? .2 : 0, onset: i === 30 ? .7 : 0 })) }; }

test("reference defaults: required cover, 1080p canvas, small top disc, transparent mixed spectrum", () => {
  const empty = createVisualizerProject(track); assert.throws(() => validateVisualizerProject(empty), /图片/);
  const p = project(); validateVisualizerProject(p);
  assert.equal(p.scene.canvas.width, 1920); assert.equal(p.scene.canvas.height, 1080);
  assert.equal(p.scene.left.rotation_deg, 180); assert.equal(p.scene.disc.mode, "cover"); assert.ok(p.scene.disc.size < .3);
  assert.equal(p.look.smallSpectrum, "mixed"); assert.equal(p.lyrics.mode, "off"); assert.equal(p.track.id, 42);
});
test("one to three asset slots; deleting the rest normalizes every reference", () => {
  const p = project(); syncVisualizerImages(p, 2); p.scene.left.image = 1; p.scene.right.image = 1; p.scene.disc.image = 1;
  validateVisualizerProject(p); syncVisualizerImages(p, 1); validateVisualizerProject(p);
  assert.deepEqual([p.scene.left.image, p.scene.right.image, p.scene.disc.image], [0, 0, 0]);
  syncVisualizerImages(p, 3); validateVisualizerProject(p); syncVisualizerImages(p, 4); assert.throws(() => validateVisualizerProject(p), /图片/);
});
test("invalid colors, unbounded effect values and unsupported FPS rejected", () => {
  const p = project(); p.look.motion = NaN; assert.throws(() => validateVisualizerProject(p));
  p.look.motion = .5; p.look.accent = "url(private)"; assert.throws(() => validateVisualizerProject(p));
  p.look.accent = "#44ccff"; p.output.fps = 120 as 60; assert.throws(() => validateVisualizerProject(p));
});
test("LRC merges bilingual tags, fractional timestamps and global offsets", () => {
  const lines = parseVisualizerLyrics("[offset:100]\n[00:01.5][00:03.500]A\n[00:02.05]B", "[00:01.600]译文\n[00:02.150]翻译");
  assert.deepEqual(lines, [{ time: 1.6, lines: ["A", "译文"] }, { time: 2.15, lines: ["B", "翻译"] }, { time: 3.6, lines: ["A"] }]);
  assert.equal(lyricIndex(lines, 1.59), -1); assert.equal(lyricIndex(lines, 2.15), 1); assert.equal(lyricIndex(lines, 99), 2);
});
test("blank LRC timestamps clear a sentence; untimed text is not fake-synchronized", () => {
  assert.deepEqual(parseVisualizerLyrics("[00:01]line\n[00:02]\nuntimed\n[00:99]bad"), [{ time: 1, lines: ["line"] }, { time: 2, lines: [] }]);
});
test("feature interpolation supports half frames for 60 fps", () => {
  const t = timeline(); assert.equal(sampleStudioFeatures(t, 1).bands[0], .8);
  assert.ok(Math.abs(sampleStudioFeatures(t, 1 - 1 / 60).bands[0] - .4) < 1e-10);
  assert.equal(sampleStudioFeatures(t, -3).bass, 0); assert.equal(sampleStudioFeatures(t, 999).bass, 0);
});
test("reusable feature output matches independent sampling across backward seeks without mutating the timeline", () => {
  const t = timeline(), before = structuredClone(t), output = { bands: [123], bass: 0, rms: 0, onset: 0 }, bands = output.bands;
  for (const time of [1.01, 2.5, -.1, .98333, 999, .25]) {
    assert.equal(sampleStudioFeatures(t, time, output), output);
    assert.equal(output.bands, bands);
    assert.deepEqual(output, sampleStudioFeatures(t, time));
  }
  assert.deepEqual(t, before);
  sampleStudioFeatures({ ...t, frames: [] }, 1, output);
  assert.deepEqual(output, { bands: Array(64).fill(0), bass: 0, rms: 0, onset: 0 });
});
test("spring motion is bounded, decays after sound and is independent of seek order", () => {
  const t = timeline(), frames = prepareStudioMotion(t), once = sampleStudioMotion(frames, 1.1);
  for (const time of [2.8, .1, 2, 0, 1.5]) sampleStudioMotion(frames, time);
  assert.deepEqual(sampleStudioMotion(frames, 1.1), once);
  assert.deepEqual(frames, prepareStudioMotion(t)); assert.ok(frames[30].pulse > .5);
  assert.ok(frames[89].pulse < .001); assert.ok(frames.every(m => [m.bass, m.pulse, m.energy].every(v => v >= 0 && v <= 1)));
});
test("safe filenames and clocks do not leak paths or use unsafe Windows device names", () => {
  assert.equal(safeVisualizerName("CON.mp3"), "KDJ-Visualizer");
  assert.equal(safeVisualizerName("../../a:b?"), ".._.._a_b_");
  assert.equal(studioClock(-5), "0:00"); assert.equal(studioClock(125.9), "2:05");
});
test("portable project keeps current pinned song, never imports foreign source identity", async () => {
  const p = project(); const draft = { project: p, images: [new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })] };
  const json = await serializeVisualizerDraft(draft); const restored = deserializeVisualizerDraft(json, { ...track, id: 99, path: "/current.wav" });
  assert.equal(restored.project.track.id, 99); assert.equal(restored.project.track.path, "/current.wav"); assert.equal(restored.project.output.directory, "");
  assert.equal(restored.images.length, 1); assert.equal(restored.images[0].size, 3);
  assert.throws(() => deserializeVisualizerDraft(json.replace("image/png", "image/svg+xml"), track), /图片/);
});
test("main entry is lazy and the reference small spectrum never paints a black area", () => {
  const renderer = readFileSync(new URL("../src/lib/visualizerStudioRenderer.ts", import.meta.url), "utf8");
  const small = renderer.slice(renderer.indexOf("function paintSmallSpectrum"), renderer.indexOf("function paintLights"));
  assert.ok(!/fillStyle\s*=\s*["'](?:black|#000)/.test(small)); assert.ok(!small.includes('globalCompositeOperation = "multiply"'));
  assert.ok(readFileSync(new URL("../src/components/composition/VisualizerDock.tsx", import.meta.url), "utf8").includes('lazy(() => import("./VisualizerStudioPanel"))'));
});

test("作词、作曲、编曲 are read from timed lines and provider JSON lines, and are not sung as lyrics", () => {
  const plain = "[00:00.00] 作词 : 小林\n[00:01.00] 作曲 : Aki\n[00:02.00]编曲：Ren\n[00:10.00]第一句";
  assert.deepEqual(studioCredits(plain), { lyricist: "小林", composer: "Aki", arranger: "Ren" });
  assert.deepEqual(parseVisualizerLyrics(plain).flatMap(cue => cue.lines), ["第一句"]);
  const json = '{"t":0,"c":[{"tx":"作词: "},{"tx":"森"}]}\n{"t":1000,"c":[{"tx":"作曲: "},{"tx":"林"}]}\n[00:10.00]歌';
  assert.deepEqual(studioCredits(json), { lyricist: "森", composer: "林" });
  const p = project(); p.text.composer = "kept";
  fillStudioCredits(p, plain);
  assert.equal(p.text.lyricist, "小林"); assert.equal(p.text.composer, "kept"); assert.equal(p.text.arranger, "Ren");
  p.text.arranger = "x".repeat(501); assert.throws(() => validateVisualizerProject(p), /文字过长/);
});

test("the disc and the background take the main picture until each has its own", () => {
  const main = new Blob(["m"]), disc = new Blob(["d"]), background = new Blob(["b"]);
  const only = withStudioPictures(project(), { main });
  assert.deepEqual(studioPictures(only), { main, background: undefined, disc: undefined });
  const all = withStudioPictures(only.project, { main, background, disc });
  assert.equal(all.images.length, 3); validateVisualizerProject(all.project);
  assert.deepEqual(studioPictures(all), { main, background, disc });
  const back = withStudioPictures(all.project, { ...studioPictures(all), background: undefined });
  assert.deepEqual(back.images, [main, disc]); assert.equal(back.project.scene.right.image, 0); assert.equal(back.project.scene.disc.image, 1);
});
