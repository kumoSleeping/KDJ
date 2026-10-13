import assert from "node:assert/strict";
import test from "node:test";
import { shouldFenceStreamSwitch } from "../src/lib/playerTransitionPolicy";

const base = { autoPlay: true, djTransition: false, nextIsStream: true, nextIsUnresolved: false, nextIsCompositionPreview: false, purposeIsComposition: false };

test("switching to any stream stops the outgoing deck at the click, resolved URL or not", () => {
  assert.equal(shouldFenceStreamSwitch(base), true);
});

test("a local file, a paused pick, a DJ overlap and composition previews keep their own handover", () => {
  assert.equal(shouldFenceStreamSwitch({ ...base, nextIsStream: false }), false);
  assert.equal(shouldFenceStreamSwitch({ ...base, autoPlay: false }), false);
  assert.equal(shouldFenceStreamSwitch({ ...base, djTransition: true }), false);
  assert.equal(shouldFenceStreamSwitch({ ...base, nextIsCompositionPreview: true }), false);
  assert.equal(shouldFenceStreamSwitch({ ...base, purposeIsComposition: true }), false);
});

test("a stream whose URL is still being resolved is fenced as before, in the editors too", () => {
  const unresolved = { ...base, nextIsUnresolved: true };
  assert.equal(shouldFenceStreamSwitch({ ...unresolved, nextIsCompositionPreview: true }), true);
  assert.equal(shouldFenceStreamSwitch({ ...unresolved, purposeIsComposition: true }), true);
  assert.equal(shouldFenceStreamSwitch({ ...unresolved, djTransition: true }), false);
});
