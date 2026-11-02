import assert from "node:assert/strict";
import test from "node:test";
import { sourceOf } from "../src/lib/clipFrameStrip";

const sources = [
  { file: "/music/remix.m4a#{\"size\":1}" },
  { file: "/vj/clips/ncop.mp4#{\"size\":2}" },
  { file: "C:\\vj\\nced.mp4#{\"size\":3}" },
];

test("a document's src finds the source its live picture numbers", () => {
  assert.equal(sourceOf(sources, "/vj/set.kdjv", "/vj/clips/ncop.mp4"), 1);
  assert.equal(sourceOf(sources, "/vj/set.kdjv", "clips/ncop.mp4"), 1);
  assert.equal(sourceOf(sources, "/vj/set.kdjv", "./clips/ncop.mp4"), 1);
  assert.equal(sourceOf(sources, "C:\\vj\\set.kdjv", "nced.mp4"), 2);
});

test("a name the server resolved differently is found by its file name when only one has it", () => {
  assert.equal(sourceOf(sources, "/vj/set.kdjv", "../elsewhere/link/ncop.mp4"), 1);
  assert.equal(sourceOf(sources, "/vj/set.kdjv", "missing.mp4"), -1);
  assert.equal(sourceOf([...sources, { file: "/other/ncop.mp4#x" }], "/vj/set.kdjv", "../x/ncop.mp4"), -1);
});
