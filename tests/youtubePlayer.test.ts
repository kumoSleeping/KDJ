import assert from "node:assert/strict";
import test from "node:test";

import { LightweightYoutubePlayer } from "../src/lib/youtubePlayer/player";
import { appendClientPlaybackNonce } from "../src/lib/youtubePoToken";

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
