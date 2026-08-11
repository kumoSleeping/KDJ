import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalTrackCamelot,
  displayTrackKey,
  keyTextToCamelot,
  trackKeyMatches,
  trackKeySortValue,
} from "../src/lib/keyDisplay";

test("djay and KDJ key spellings render consistently", () => {
  for (const input of ["F# M", "F# major", "F#", "Gb maj", "2B", "F♯ M"]) {
    assert.equal(keyTextToCamelot(input), "2B", input);
    assert.equal(displayTrackKey({ music_key: input }, "traditional"), "F# M", input);
  }
  for (const input of ["F# m", "F#m", "F# minor", "Gb min", "11A"]) {
    assert.equal(keyTextToCamelot(input), "11A", input);
    assert.equal(displayTrackKey({ music_key: input }, "traditional"), "F# m", input);
  }
});

test("explicit valid Camelot wins while both notations remain filterable", () => {
  const key = { music_key: "A minor", camelot: "8a" };
  assert.equal(canonicalTrackCamelot(key), "8A");
  assert.equal(displayTrackKey(key, "camelot"), "8A");
  assert.equal(displayTrackKey(key, "traditional"), "A m");
  assert.equal(trackKeyMatches(key, "8A"), true);
  assert.equal(trackKeyMatches(key, "A m"), true);
  assert.equal(trackKeyMatches(key, "A minor"), true);
  assert.equal(trackKeySortValue(key), 16);
});

test("unknown external key text is preserved instead of invented", () => {
  const key = { music_key: "custom mode", camelot: "" };
  assert.equal(displayTrackKey(key, "traditional"), "custom mode");
  assert.equal(displayTrackKey(key, "camelot"), "custom mode");
  assert.equal(trackKeySortValue(key), null);
});
