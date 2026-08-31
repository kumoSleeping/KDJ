import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LightweightYoutubePlayer } from "../src/lib/youtubePlayer/player";
import { appendClientPlaybackNonce } from "../src/lib/youtubePlaybackUrl";

test("narrow player extractor reads signature timestamp without the full InnerTube client", () => {
  const javascript =
    "(function(){var x=function(){return {signatureTimestamp:20689}};})();";
  const player = LightweightYoutubePlayer.create(javascript);
  assert.equal(player.signatureTimestamp, 20689);
});

test("timestamp extraction parses remote source without running its side effects", () => {
  const marker = "__kdjYoutubeRemoteExecuted";
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals[marker];
  const javascript =
    `globalThis.${marker}=true;(function(){var x=function(){return {signatureTimestamp:20689}};})();`;
  const player = LightweightYoutubePlayer.create(javascript);
  assert.equal(player.signatureTimestamp, 20689);
  assert.equal(globals[marker], undefined);
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

test("unprotected official media URLs remain usable without executing player code", () => {
  const player = LightweightYoutubePlayer.create(
    "(function(){var x=function(){return {signatureTimestamp:20689}};})();",
  );
  const directUrl = "https://rr1---sn.example.googlevideo.com/videoplayback?id=track";
  assert.equal(player.decipher(directUrl), directUrl);
});

test("media URL allowlist rejects attacker-controlled origins", () => {
  const player = LightweightYoutubePlayer.create(
    "(function(){var x=function(){return {signatureTimestamp:20689}};})();",
  );
  assert.throws(
    () => player.decipher("https://attacker.example/videoplayback"),
    /不受信任/,
  );
});

test("release CSP keeps dynamic execution out of the privileged document", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
    app: { security: { csp: string } };
  };
  const csp = config.app.security.csp;
  assert.match(csp, /script-src 'self'(?:;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:\*/);

  const executionSources = readFileSync("src/lib/youtubeNativePo.ts", "utf8");
  assert.doesNotMatch(executionSources, new RegExp("new\\s+" + "Function\\s*\\("));
  assert.doesNotMatch(executionSources, new RegExp("\\be" + "val\\s*\\("));

  const sandbox = readFileSync("src/lib/youtubePlayer/player.ts", "utf8");
  assert.match(sandbox, new RegExp("new\\s+" + "Function\\s*\\("));
  const nativeRunner = readFileSync("src-tauri/src/youtube_proof.rs", "utf8");
  assert.match(nativeRunner, /connect-src https:\/\/www\.youtube\.com https:\/\/jnn-pa\.googleapis\.com/);
  assert.match(nativeRunner, /removeAllUserScripts/);
  assert.match(nativeRunner, /removeScriptMessageHandlerForName/);
});
