/** Run: node --test scripts/test-playback-recovery.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(
  readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const streamCode = compile('streamTrack');
const previewCode = compile('songPreview');
const playerSession = {};
vm.runInNewContext(compile('playerSession'), { exports: playerSession });
const source = key => ({ platform: 'wyy', key: String(key), title: `Song ${key}`, artists: ['Artist'],
  album: '', duration: 180, cover: '', max_quality: null, vip: false, payload: {} });
const item = key => ({ source: source(key), title: `Song ${key}`, artist: 'Artist' });

function session(resolve) {
  const values = new Map(), requests = [], played = [];
  const stream = {}, preview = {};
  const dependencies = {
    './api': { api: { songPreview: async (song, bypassCache) => {
      requests.push({ key: song.key, bypassCache });
      return resolve ? resolve(song) : { url: `http://localhost/${song.key}`, waveform_token: song.key };
    } } },
    './format': { thumbUrl: url => url },
    './playbackTrackSource': { usesRemotePlaybackSource: track => Boolean(track && track.id < 0) },
    './storageWrite': {
      readLocalStorage: key => values.get(key),
      writeLocalStorageNow: (key, value) => values.set(key, value),
      removeLocalStorage: key => values.delete(key),
      discardLocalStorageWrite() {},
    },
    '@tauri-apps/api/event': { emitTo: async () => {} },
    './playTrack': { playTrack: (track, autoPlay) => played.push({ track, autoPlay }) },
    './playerSession': {},
    './streamTrack': stream,
  };
  const globals = { window: { dispatchEvent() {} }, CustomEvent: class {},
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; } };
  vm.runInNewContext(streamCode, { ...globals, exports: stream });
  vm.runInNewContext(previewCode, { ...globals, exports: preview });
  return { stream, preview, values, requests, played };
}

test('failed load remains an error after toast dismissal and stale resolving snapshots', () => {
  assert.equal(playerSession.playerSessionFailed(-1, -1, 'error', '播放失败：provider unavailable'), true);
  assert.equal(playerSession.playerSessionFailed(-1, -1, 'resolving', ''), true);
  assert.equal(playerSession.playerSessionFailed(-1, null, 'resolving', ''), false, 'an explicit retry clears the load failure');
  assert.equal(playerSession.playerSessionFailed(-2, -1, 'loading', ''), false, 'failure does not belong to the next song');
  assert.equal(playerSession.playerSessionFailed(null, -1, 'error', ''), false, 'empty decks stay empty');
});

test('release profile keeps the explicitly selected abort strategy', () => {
  const manifest = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');
  const release = manifest.match(/^\[profile\.release\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  assert.ok(release, 'release profile must be explicit');
  assert.match(release, /^panic\s*=\s*"abort"\s*$/m,
    'release failures must use Result; debug panic recovery is not a release guarantee');
});

test('release size optimization never applies z to audio/DSP hot paths', () => {
  const manifest = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');
  const hotPackages = [
    'kdj-analysis', 'kdj-stems', 'kdj-player', 'kdj-playback',
    'rubato', 'rustfft', 'realfft', 'symphonia', 'symphonia-core',
    'symphonia-bundle-flac', 'symphonia-bundle-mp3',
    'symphonia-codec-aac', 'symphonia-codec-alac', 'symphonia-codec-pcm',
    'symphonia-codec-vorbis', 'symphonia-format-isomp4', 'symphonia-format-mkv',
    'symphonia-format-ogg', 'symphonia-format-riff',
  ];
  for (const name of hotPackages) {
    const section = manifest.split(`[profile.release.package.${name}]`)[1]?.split(/^\[/m)[0];
    assert.ok(section, `missing throughput override for ${name}`);
    assert.match(section, /^opt-level\s*=\s*2\s*$/m, `${name} must remain throughput-optimized`);
  }
});

test('host and mobile plugin do not re-enable unused dynamic ACL defaults', () => {
  for (const file of ['src-tauri/Cargo.toml', 'plugins/native-audio/Cargo.toml']) {
    const manifest = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const dependency = manifest.match(/^tauri\s*=\s*\{[^}]+\}/m)?.[0];
    assert.ok(dependency, `${file} must explicitly declare its Tauri feature policy`);
    assert.match(dependency, /default-features\s*=\s*false/);
    assert.doesNotMatch(dependency, /"dynamic-acl"/);
    if (file === 'src-tauri/Cargo.toml') {
      for (const feature of ['wry', 'compression', 'common-controls-v6', 'x11', 'dbus']) {
        assert.ok(dependency.includes(`"${feature}"`), `retain Tauri feature ${feature}`);
      }
    }
  }
});

function queueKeys(stream, head) {
  const keys = [], ids = new Set();
  for (let track = head; track; track = stream.streamNextTrack(track)) {
    assert.ok(!ids.has(track.id), 'queue must not cycle');
    ids.add(track.id);
    assert.ok(stream.streamMeta(track), 'every live successor retains provider metadata');
    keys.push(track.source_key);
  }
  return keys;
}

for (const [oldCount, followingCount] of [[0, 1024], [600, 600], [1100, 1500], [0, 100]]) {
  test(`preview survives atomic queue replacement: old=${oldCount}, following=${followingCount}`, async () => {
    const s = session();
    let old;
    if (oldCount) {
      old = s.stream.publishSongStreamQueue(source('old'),
        Array.from({ length: oldCount - 1 }, (_, i) => source(`old-${i}`)));
    }
    const queue = Array.from({ length: followingCount }, (_, i) => item(i));
    await s.preview.playSongPreview({ ...item('head'), queue, bypassCache: true });
    const head = s.played[0].track;
    assert.equal(s.preview.getSongPreviewState().phase, 'ready');
    assert.deepEqual(s.requests, [{ key: 'head', bypassCache: true }], 'successors remain lazy');
    assert.equal(s.stream.streamMediaUrl(head), 'http://localhost/head');
    assert.deepEqual(queueKeys(s.stream, head), ['head', ...queue.map(row => row.source.key)]);
    assert.equal(JSON.parse(s.values.get('kd-active-stream-track')).track.id, head.id);
    if (old && followingCount >= 1024) {
      assert.equal(s.stream.streamTrackById(old.id), null, 'abandoned queue is no longer pinned');
    }
  });
}

test('leaving a large stream queue releases it for normal LRU eviction', () => {
  const { stream } = session();
  const head = stream.publishSongStreamQueue(source('head'),
    Array.from({ length: 1100 }, (_, i) => source(i)));
  // Touch the head last so a different old successor is the oldest entry.
  const oldest = stream.streamNextTrack(head);
  stream.publishStreamTrack(null);
  assert.equal(stream.streamTrackById(oldest.id), null);
  const next = stream.publishSongStreamQueue(source('new'), []);
  assert.deepEqual(queueKeys(stream, next), ['new']);
});

test('provider failure preserves a retryable source and never publishes ready', async () => {
  let fail = true;
  const s = session(async song => {
    if (fail) throw Error('provider unavailable');
    return { url: `http://localhost/${song.key}` };
  });
  const request = { ...item('head'), queue: Array.from({ length: 1024 }, (_, i) => item(i)) };
  await assert.rejects(s.preview.playSongPreview(request), /provider unavailable/);
  assert.equal(s.preview.getSongPreviewState().phase, 'error');
  assert.equal(s.preview.getSongPreviewState().canRetry, true);
  assert.equal(queueKeys(s.stream, s.played[0].track).length, 1025);
  fail = false;
  await s.preview.retrySongPreview();
  assert.equal(s.preview.getSongPreviewState().phase, 'ready');
  assert.equal(s.requests.at(-1).bypassCache, true);
});

test('late provider results cannot replace a newer queue or preview state', async () => {
  const pending = new Map();
  const s = session(song => new Promise(resolve => pending.set(song.key, resolve)));
  const first = s.preview.playSongPreview({ ...item('first'), queue: Array.from({ length: 1100 }, (_, i) => item(i)) });
  const second = s.preview.playSongPreview(item('second'));
  pending.get('second')({ url: 'http://localhost/second' });
  await second;
  pending.get('first')({ url: 'http://localhost/first' });
  await first;
  assert.equal(s.preview.getSongPreviewState().sourceKey, 'wyy:second');
  assert.equal(s.preview.getSongPreviewState().phase, 'ready');
  assert.equal(JSON.parse(s.values.get('kd-active-stream-track')).track.source_key, 'second');
});
