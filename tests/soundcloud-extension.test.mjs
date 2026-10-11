import test from "node:test";
import assert from "node:assert/strict";
import { connectSession, pairingTarget, soundcloudSession } from "../extensions/soundcloud/session.mjs";

const code = `KDJ-SC1:5274:${"a".repeat(64)}`;
test("pairing accepts only a fixed loopback destination, never arbitrary URLs", () => {
  assert.equal(pairingTarget(code).url, "http://127.0.0.1:5274/connect");
  for (const value of [code.replace(":5274:", ":65536:"), code.replace(":5274:", ":0:"), `https://evil.test/${code}`, `${code}/x`, code.replace("a", "A")]) {
    assert.throws(() => pairingTarget(value));
  }
});

test("only live root SoundCloud oauth cookies are forwarded", () => {
  const cookie = { name: "oauth_token", domain: ".soundcloud.com", value: "synthetic-token", session: false, expirationDate: 200 };
  for (const patch of [{ domain: "soundcloud.com.evil.test" }, { domain: "other.soundcloud.com" }, { name: "password" }, { expirationDate: 99 }, { value: " " }, { value: "a".repeat(4097) }]) {
    assert.throws(() => soundcloudSession([{ ...cookie, ...patch }], 100));
  }
  assert.deepEqual(soundcloudSession([cookie], 100), { access_token: "synthetic-token", expires_at: 200 });
  assert.equal(soundcloudSession([{ ...cookie, session: true, expirationDate: undefined }], 100).expires_at, 0);
});

test("browser read is site scoped and sends no general browser data or control bearer", async () => {
  let reads = 0;
  await connectSession(code, { getAll: async query => {
    reads++;
    assert.deepEqual(query, { url: "https://soundcloud.com/", name: "oauth_token" });
    return [{ name: "oauth_token", domain: "soundcloud.com", value: "synthetic-token", session: true }];
  } }, async (url, options) => {
    assert.equal(url, "http://127.0.0.1:5274/connect");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(JSON.parse(options.body), { access_token: "synthetic-token", expires_at: 0 });
    return { ok: true };
  });
  assert.equal(reads, 1);
  await assert.rejects(connectSession("invalid", { getAll: async () => { throw new Error("must not read cookies"); } }), /配对码无效/);
});
