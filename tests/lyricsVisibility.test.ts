import assert from "node:assert/strict";
import test from "node:test";
import { hasVisibleLyrics } from "../src/lib/lyricsVisibility";

test("missing lyrics and instrumental notices have no lyrics widget", () => {
  assert.equal(hasVisibleLyrics([]), false);
  assert.equal(hasVisibleLyrics([{text:"  "}]), false);
  for (const text of ["纯音乐，请欣赏", "纯音乐", "Instrumental", "此歌曲为没有填词的纯音乐，请欣赏。"])
    assert.equal(hasVisibleLyrics([{text:"作曲：作者"},{text}]), false);
  assert.equal(hasVisibleLyrics([{text:"君の声が聞こえる"}]), true);
});
