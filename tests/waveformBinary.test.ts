import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeWaveformBinary,
  isWaveformBinaryContentType,
  WAVEFORM_BINARY_MIME,
  type WaveformProfile,
} from "../src/lib/waveformBinary";

const HEADER_BYTES = 36;

function fixture(profile: WaveformProfile, revision?: number): ArrayBuffer {
  const values = [0.25, 0.75];
  const buffer = new ArrayBuffer(HEADER_BYTES + values.length * 7);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x4b, 0x44, 0x4a, 0x57, 0x56, 0x46, 0x4d, 0x00]);
  const view = new DataView(buffer);
  view.setUint16(8, 1, true);
  view.setUint8(10, profile === "current" ? 1 : 2);
  view.setUint8(11, 0);
  view.setUint32(12, revision ?? (profile === "current" ? 6 : 5), true);
  view.setBigInt64(16, -42n, true);
  view.setFloat64(24, 3.5, true);
  view.setUint32(32, values.length, true);
  values.forEach((value, index) => view.setFloat32(HEADER_BYTES + index * 4, value, true));
  bytes.set([255, 32, 64, 128, 32, 255], HEADER_BYTES + values.length * 4);
  return buffer;
}

test("binary waveform roundtrips compact zero-copy amplitude and RGB channels", () => {
  const payload = fixture("current");
  const wave = decodeWaveformBinary(payload, "current");
  assert.equal(wave.track_id, -42);
  assert.equal(wave.duration, 3.5);
  assert.ok(wave.amp instanceof Float32Array);
  assert.ok(wave.r instanceof Uint8Array);
  assert.ok(wave.g instanceof Uint8Array);
  assert.ok(wave.b instanceof Uint8Array);
  assert.equal(wave.amp.buffer, payload);
  assert.equal(wave.r.buffer, payload);
  assert.equal(wave.g.buffer, payload);
  assert.equal(wave.b.buffer, payload);
  assert.deepEqual(Array.from(wave.amp), [0.25, 0.75]);
  assert.deepEqual(Array.from(wave.r), [255, 32]);
  assert.deepEqual(Array.from(wave.g), [64, 128]);
  assert.deepEqual(Array.from(wave.b), [32, 255]);
});

test("wire profile and algorithm revision are enforced", () => {
  assert.throws(
    () => decodeWaveformBinary(fixture("release-overview"), "current"),
    /profile 不匹配/,
  );
  assert.throws(
    () => decodeWaveformBinary(fixture("current", 7), "current"),
    /profile 不匹配/,
  );
});

test("truncated and overlong payloads are rejected before channel allocation", () => {
  const valid = fixture("current");
  assert.throws(
    () => decodeWaveformBinary(valid.slice(0, valid.byteLength - 1), "current"),
    /长度不匹配/,
  );
  const overlong = new Uint8Array(valid.byteLength + 1);
  overlong.set(new Uint8Array(valid));
  assert.throws(
    () => decodeWaveformBinary(overlong.buffer, "current"),
    /长度不匹配/,
  );
});

test("binary media type accepts parameters but not generic octet streams", () => {
  assert.equal(isWaveformBinaryContentType(WAVEFORM_BINARY_MIME), true);
  assert.equal(isWaveformBinaryContentType(`${WAVEFORM_BINARY_MIME}; version=1`), true);
  assert.equal(isWaveformBinaryContentType("application/octet-stream"), false);
  assert.equal(isWaveformBinaryContentType(null), false);
});
