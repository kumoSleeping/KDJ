import assert from "node:assert/strict";
import test from "node:test";
import { isPiText, piRequestText, withoutPiPrefix, withPiPrefix } from "../src/lib/piPrefix";
import { peekShots, peekUnshown } from "../src/lib/aiShots";

test("/pi at the start hands the rest to the AI, nothing else does", () => {
  for (const text of ["/pi", "/pi ", "/pi 下载这首", "/PI 下载", "/pi\n两行"]) assert.equal(isPiText(text), true, text);
  for (const text of ["", "/p", "/pix", "周杰伦 /pi", " /pi 前面有空格"]) assert.equal(isPiText(text), false, text);
  assert.equal(piRequestText("/pi   帮我下载  "), "帮我下载");
  assert.equal(piRequestText("/pi "), "");
});

test("the AI key puts the prefix in front once and takes it out again", () => {
  assert.equal(withPiPrefix(""), "/pi ");
  assert.equal(withPiPrefix("  周杰伦"), "/pi 周杰伦");
  assert.equal(withPiPrefix("/pi 周杰伦"), "/pi 周杰伦");
  assert.equal(withoutPiPrefix("/pi 周杰伦"), "周杰伦");
});

test("a frame cut shows the pictures the model was handed, with their moments", () => {
  const image = (data: string) => ({ type: "image", data, mimeType: "image/jpeg" });
  const frames = { content: [{ type: "text", text: "{}" }, image("AAA"), image("BBB")],
    details: { frames: [{ at: 75, path: "/a.jpg" }, { at: 90, path: "/b.jpg" }, { at: 105, path: "/c.jpg" }] } };
  assert.deepEqual(peekShots(frames), [
    { src: "data:image/jpeg;base64,AAA", label: "1:15" },
    { src: "data:image/jpeg;base64,BBB", label: "1:30" },
  ]);
  assert.equal(peekUnshown(frames), 1);
  assert.equal(peekShots(frames), peekShots(frames), "read once per result");

  const sheet = { content: [image("SHEET")], details: { sheet: { path: "/s.jpg" }, frames: [{ at: 1 }, { at: 2 }, { at: 3 }] } };
  assert.deepEqual(peekShots(sheet), [{ src: "data:image/jpeg;base64,SHEET", label: "3 帧" }]);
  assert.equal(peekUnshown(sheet), 0);

  // A model that sees no pictures is handed none: nothing to show.
  assert.deepEqual(peekShots({ content: [{ type: "text", text: "{}" }], details: { frames: [{ at: 1 }] } }), []);
});
