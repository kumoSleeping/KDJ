import assert from "node:assert/strict";
import test from "node:test";
import { createKdjAiPrompt } from "../src/lib/kdjAiPrompt";

test("AI prompt carries the detected CLI invocation", () => {
  const invocation = "'/Applications/KDJ.app/Contents/MacOS/kdj-app'";
  const prompt = createKdjAiPrompt(invocation);

  assert.match(prompt, new RegExp(invocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /下文用 kdj 作为命令简称/);
  assert.match(prompt, /kdj library list/);
});

test("AI prompt keeps a safe default for non-desktop previews", () => {
  assert.match(createKdjAiPrompt(""), /当前可用的 CLI 完整入口是：kdj/);
});
