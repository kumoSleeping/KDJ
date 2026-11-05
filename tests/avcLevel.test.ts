import assert from "node:assert/strict";
import test from "node:test";
import { decodableCodec } from "../src/lib/avcLevel";

test("H.264 above level 5.2 is asked for as 5.2, anything else as it is", () => {
  assert.equal(decodableCodec("avc1.64003e"), "avc1.640034");
  assert.equal(decodableCodec("avc1.64003C"), "avc1.640034");
  assert.equal(decodableCodec("avc3.4d003d"), "avc3.4d0034");
  assert.equal(decodableCodec("avc1.640034"), "avc1.640034");
  assert.equal(decodableCodec("avc1.64002a"), "avc1.64002a");
  assert.equal(decodableCodec("hvc1.1.6.L153.B0"), "hvc1.1.6.L153.B0");
});
