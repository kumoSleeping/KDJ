import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { folderScore, foldName, walk } from "../crates/kdj-server/src/ai/kdj-folders";

test("a folder is found by the name as it is said", () => {
  assert.equal(foldName("8 月"), foldName("8月"));
  assert.equal(foldName("八月"), "8月");
  assert.equal(foldName("7yue"), "7月");
  assert.equal(folderScore("8 月", "8月"), 100);
  assert.equal(folderScore("12_13", "1213"), 100);
  assert.ok(folderScore("温州_2", "温州") > folderScore("杭州3_7", "温州"));
  assert.equal(folderScore("remix", "8月"), 0);
});

test("every folder under a root is listed, hidden ones left out, with its songs", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "kdj-folders-"));
  try {
    mkdirSync(join(rootDir, "无锡", "剪辑工作区"), { recursive: true });
    mkdirSync(join(rootDir, ".kdj"));
    writeFileSync(join(rootDir, "无锡", "a.mp3"), "");
    writeFileSync(join(rootDir, "无锡", "b.txt"), "");
    const found = walk(rootDir);
    const names = found.map(folder => folder.path.slice(rootDir.length) || "/").sort();
    assert.deepEqual(names, ["/", "/无锡", "/无锡/剪辑工作区"]);
    assert.equal(found.find(folder => folder.path.endsWith("无锡"))?.songs, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
