import assert from "node:assert/strict";
import test from "node:test";

import { windowsMsiVersion } from "../scripts/windows-msi-version.mjs";

test("maps public prerelease versions to ordered numeric WiX versions", () => {
  assert.equal(windowsMsiVersion("1.0.0-alpha1"), "1.0.0.10001");
  assert.equal(windowsMsiVersion("1.0.0-beta2"), "1.0.0.20002");
  assert.equal(windowsMsiVersion("1.0.0-rc1"), "1.0.0.30001");
  assert.equal(windowsMsiVersion("1.0.0"), "1.0.1.0");
  assert.equal(windowsMsiVersion("1.0.1-alpha1"), "1.0.2.10001");
});

test("accepts common dotted and numeric prerelease forms", () => {
  assert.equal(windowsMsiVersion("2.3.4-alpha.7"), "2.3.8.10007");
  assert.equal(windowsMsiVersion("2.3.4-42"), "2.3.8.42");
});

test("rejects versions WiX cannot represent safely", () => {
  assert.throws(() => windowsMsiVersion("256.0.0"), /major/);
  assert.throws(() => windowsMsiVersion("1.0.32768"), /不能大于 32767/);
  assert.throws(() => windowsMsiVersion("1.0.0-preview1"), /不支持预发行标识/);
  assert.throws(() => windowsMsiVersion("1.0.0-rc10000"), /不能大于 9999/);
});
