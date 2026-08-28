import assert from "node:assert/strict";
import test from "node:test";

import { hasCompleteFmp4MediaSegment } from "../src/lib/fmp4Prefix";
import { LightweightYoutubePlayer } from "../src/lib/youtubePlayer/player";
import { appendClientPlaybackNonce } from "../src/lib/youtubePoToken";

function mp4Box(type: string, payloadBytes: number): Uint8Array {
  const size = 8 + payloadBytes;
  const box = new Uint8Array(size);
  new DataView(box.buffer).setUint32(0, size);
  for (let index = 0; index < 4; index += 1) box[4 + index] = type.charCodeAt(index);
  return box;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

test("narrow player extractor reads signature timestamp without the full InnerTube client", () => {
  const javascript =
    "(function(){var x=function(){return {signatureTimestamp:20689}};})();";
  const player = LightweightYoutubePlayer.create(javascript);
  assert.equal(player.signatureTimestamp, 20689);
});

test("narrow player extractor rejects scripts without a signature timestamp", () => {
  assert.throws(
    () => LightweightYoutubePlayer.create("(function(){var x=1;})();"),
    /签名时间戳/,
  );
});

test("WEB_REMIX direct media URL carries one stable client playback nonce", () => {
  const nonce = "AbCdEfGhIjKlMn-_";
  const first = appendClientPlaybackNonce(
    "https://rr1---sn.example.googlevideo.com/videoplayback?pot=proof",
    nonce,
  );
  assert.equal(new URL(first).searchParams.get("cpn"), nonce);
  assert.equal(appendClientPlaybackNonce(first, "0123456789abcdef"), first);
});

test("SABR fallback publishes at the first complete fragmented MP4 media segment", () => {
  const prefix = join(mp4Box("ftyp", 16), mp4Box("moov", 24), mp4Box("moof", 48));
  assert.equal(hasCompleteFmp4MediaSegment(prefix), false);
  const complete = join(prefix, mp4Box("mdat", 128 * 1024));
  assert.equal(hasCompleteFmp4MediaSegment(complete), true);
  assert.equal(
    hasCompleteFmp4MediaSegment(complete.subarray(0, complete.length - 1)),
    false,
    "未收齐 mdat 时不能把损坏前缀交给播放器",
  );
});
