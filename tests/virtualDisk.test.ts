import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultVirtualDiskChangeSizeGib,
  normalizeVirtualDiskName,
  parseVirtualDiskSizeGib,
  virtualDiskChangeOptions,
  virtualDiskGrowthOptions,
  virtualDiskNameInputError,
  virtualDiskSizeInputError,
  virtualDiskSizeMib,
} from "../src/lib/virtualDisk";

test("custom capacities accept one decimal place and convert to MiB", () => {
  assert.equal(parseVirtualDiskSizeGib("8.5"), 8.5);
  assert.equal(virtualDiskSizeMib(8.5), 8704);
  assert.equal(parseVirtualDiskSizeGib("8.55"), null);
  assert.match(virtualDiskSizeInputError("8.55"), /1 位小数/);
});

test("capacity changes allow safe shrinking and keep automatic growth presets", () => {
  const currentBytes = 8.5 * 1024 ** 3;
  const minimumBytes = 2.25 * 1024 ** 3;
  assert.equal(virtualDiskSizeInputError("4", minimumBytes), "");
  assert.match(virtualDiskSizeInputError("2.2", minimumBytes), /至少需要/);
  assert.match(virtualDiskSizeInputError("64.1"), /1–64 GB/);
  assert.deepEqual(virtualDiskGrowthOptions(currentBytes), [16, 32, 64]);
  assert.deepEqual(
    virtualDiskChangeOptions(currentBytes, minimumBytes),
    [4, 8, 16, 32, 64],
  );
  assert.equal(defaultVirtualDiskChangeSizeGib(currentBytes, [4, 8, 16, 32, 64]), 16);
  assert.equal(defaultVirtualDiskChangeSizeGib(64 * 1024 ** 3, [4, 8, 16, 32]), 32);
});

test("volume names are trimmed and follow the shared ExFAT limit", () => {
  assert.equal(normalizeVirtualDiskName("  DJ SET  "), "DJ SET");
  assert.equal(virtualDiskNameInputError("DJ SET"), "");
  assert.match(virtualDiskNameInputError("DJ/SET"), /不能包含/);
  assert.match(virtualDiskNameInputError("123456789012"), /11 个字符/);
});
