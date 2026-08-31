import assert from "node:assert/strict";
import test from "node:test";
import { nextAutoAnalysisMode, resolveAutoAnalysisMode } from "../src/lib/autoAnalysisMode";

test("automatic analysis cycles light to full to paused", () => {
  assert.equal(nextAutoAnalysisMode("light"), "full");
  assert.equal(nextAutoAnalysisMode("full"), "paused");
  assert.equal(nextAutoAnalysisMode("paused"), "light");
});

test("legacy enabled settings resolve to the lightweight default", () => {
  assert.equal(resolveAutoAnalysisMode({ auto_analyze: true }), "light");
  assert.equal(resolveAutoAnalysisMode({ auto_analyze: false }), "paused");
  assert.equal(
    resolveAutoAnalysisMode({ auto_analyze: true, auto_analysis_mode: "full" }),
    "full",
  );
});
