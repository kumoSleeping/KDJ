import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareLocalVideoSeek,
  previewLocalVideoSeek,
  registerLocalVideoSeekPresenter,
  type PreparedLocalVideoSeek,
} from "../src/lib/localVideoSeekBridge";

test("a visible local-video presenter receives preview and prepare targets", async () => {
  const previews: number[] = [];
  const prepared: number[] = [];
  const unregister = registerLocalVideoSeekPresenter(91_001, {
    preview(target) {
      previews.push(target);
    },
    hold() {},
    async prepare(target) {
      prepared.push(target);
      return {
        target,
        activate: () => true,
        cancel() {},
      } satisfies PreparedLocalVideoSeek;
    },
    cancel() {},
  });

  assert.equal(previewLocalVideoSeek(91_001, 123.5), true);
  const operation = prepareLocalVideoSeek(91_001, 456.25);
  assert.ok(operation);
  const result = await operation;
  assert.equal(result?.target, 456.25);
  assert.deepEqual(previews, [123.5]);
  assert.deepEqual(prepared, [456.25]);
  unregister();
  assert.equal(prepareLocalVideoSeek(91_001, 1), null);
});

test("an older surface cannot unregister the newer visible presenter", async () => {
  const calls: string[] = [];
  const unregisterOld = registerLocalVideoSeekPresenter(91_002, {
    preview() {
      calls.push("old");
    },
    hold() {},
    async prepare() {
      return null;
    },
    cancel() {},
  });
  const unregisterNew = registerLocalVideoSeekPresenter(91_002, {
    preview() {
      calls.push("new");
    },
    hold() {},
    async prepare() {
      return null;
    },
    cancel() {},
  });

  unregisterOld();
  assert.equal(previewLocalVideoSeek(91_002, 10), true);
  assert.deepEqual(calls, ["new"]);
  unregisterNew();
  assert.equal(previewLocalVideoSeek(91_002, 20), false);
});
