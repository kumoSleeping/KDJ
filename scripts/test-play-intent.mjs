/** Run: node scripts/test-play-intent.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/playIntent.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function session() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let now = 1_788_600_000_000;
  return {
    values, storage, setNow(value) { now = value; },
    reload() {
      const exports = {};
      vm.runInNewContext(compiled, { exports, Date: { now: () => now },
        require(name) {
          assert.equal(name, './storageWrite');
          return { readLocalStorage: key => { try { return storage.getItem(key); } catch { return null; } },
            writeLocalStorageNow: (key, value) => { try { storage.setItem(key, value); } catch {} } };
        } });
      return exports;
    },
  };
}

test('a refreshed frontend can replace a still-running native song on the first click', () => {
  const s = session();
  const oldPage = s.reload();
  let latestManagerIntent = 0, currentTrack = 'A';
  // Mirrors the Rust manager gate: stale loads leave the audible source unchanged.
  const load = (intent, track) => {
    if (intent < latestManagerIntent) return;
    latestManagerIntent = intent; currentTrack = track;
  };
  for (let i = 0; i < 30; i++) load(oldPage.issuePlayIntentId(), 'A');
  const freshPage = s.reload();
  const next = freshPage.issuePlayIntentId();
  assert.ok(next > latestManagerIntent, 'new clicks must not restart at 1 after page reload');
  load(next, 'B'); assert.equal(currentTrack, 'B');
  load(oldPage.issuePlayIntentId(1), 'A'); assert.equal(currentTrack, 'B', 'late old requests stay stale');
});

test('shared high-water mark survives fast clicks, module reload, and wall-clock rollback', () => {
  const s = session(), a = s.reload(), b = s.reload();
  let last = 0;
  for (let i = 0; i < 1000; i++) {
    const next = (i % 2 ? a : b).issuePlayIntentId();
    assert.ok(Number.isSafeInteger(next)); assert.ok(next > last); last = next;
  }
  s.setNow(1000);
  assert.ok(s.reload().issuePlayIntentId() > last);
});

test('parsing an existing intent preserves identity and does not reissue a stale request', () => {
  const s = session(), page = s.reload();
  const first = page.issuePlayIntentId(), second = page.issuePlayIntentId();
  assert.equal(page.issuePlayIntentId(first), first);
  assert.equal(page.isLatestPlayIntent(second, 2, first, 1), false);
  assert.ok(page.issuePlayIntentId() > second);
});

test('invalid intent values and unavailable storage cannot poison new playback requests', () => {
  const s = session();
  s.storage.getItem = s.storage.setItem = () => { throw Error('unavailable'); };
  const page = s.reload();
  let last = 0;
  for (const invalid of [NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const next = page.issuePlayIntentId(invalid);
    assert.ok(Number.isSafeInteger(next)); assert.ok(next > last); last = next;
  }
});
