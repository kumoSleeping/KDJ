import assert from "node:assert/strict";
import test from "node:test";

import {
  allStemMask,
  STEM_MODE,
  STEM_RUNTIME_ID,
  stemModeLaneKind,
  stemModeUsesTwoLanes,
  stemRuntimeStatusLabel,
} from "../src/lib/stemMode";

test("lane helpers expose the fixed model-free two-track runtime", () => {
  assert.equal(STEM_MODE, "classical_two");
  assert.equal(STEM_RUNTIME_ID, "classical-redress-v1");
  assert.equal(stemModeUsesTwoLanes(STEM_MODE), true);
  assert.equal(stemModeLaneKind(STEM_MODE), "two");
  assert.equal(allStemMask(STEM_MODE), 0b1100);
  assert.equal(stemRuntimeStatusLabel(STEM_RUNTIME_ID), "Redress");
});
