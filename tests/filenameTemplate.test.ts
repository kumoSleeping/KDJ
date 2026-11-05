import assert from "node:assert/strict";
import test from "node:test";
import { exampleName, parseTemplate, templateOf } from "../src/lib/filenameTemplate";

const song = { title: "夜曲", artist: "周杰伦", album: "十一月的萧邦" };
const noAlbum = { ...song, album: "" };
const name = (template: string, values = song) => exampleName(parseTemplate(template)!, values);

test("a template becomes its pieces and the pieces the same template", () => {
  for (const template of ["{title} - {artist}", "{artist}_{title} [{album}]", "{title} · {album} ({artist})", "{title}-{artist}", "{title} feat {artist}"]) {
    assert.equal(templateOf(parseTemplate(template)!), template);
  }
  assert.deepEqual(parseTemplate("{title} - {artist}"), [
    { kind: "field", field: "title" }, { kind: "mark", text: " - " }, { kind: "field", field: "artist" },
  ]);
  assert.deepEqual(parseTemplate("{artists}"), [{ kind: "field", field: "artist" }], "an alias the server knows");
});

test("a template the server would not use has no pieces", () => {
  assert.equal(parseTemplate("{title} [{bogus}]"), null);
  assert.equal(parseTemplate("{title"), null);
});

test("the example is named the way the server names the file (paths.rs)", () => {
  assert.equal(name("{title} - {artist}"), "夜曲 - 周杰伦");
  assert.equal(name("{title} ({album})", noAlbum), "夜曲");
  assert.equal(name("{title} ({album})"), "夜曲 (十一月的萧邦)");
  assert.equal(name("{album} - {title}", noAlbum), "夜曲");
  assert.equal(name("({album}) {title}", noAlbum), "夜曲");
  assert.equal(name("{title} - {album} - {artist}", noAlbum), "夜曲 - 周杰伦");
  assert.equal(name("{artist}_{title} [{album}]", noAlbum), "周杰伦_夜曲");
  assert.equal(name("{album}", noAlbum), "夜曲 - 周杰伦", "nothing left: the default");
});
