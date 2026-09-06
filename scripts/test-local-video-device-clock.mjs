/** Deterministic native-clock/decoder-order regression. Run: node scripts/test-local-video-device-clock.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function load(file, mocks = {}, globals = {}) {
  const result = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.deepEqual(result.diagnostics, [], file);
  const exports = {};
  vm.runInNewContext(result.outputText, { exports, require(name) {
    assert.ok(name in mocks, `Unexpected import ${name} in ${file}`); return mocks[name];
  }, ...globals }, { filename: file });
  return exports;
}
const waveform = load('src/lib/waveformMotion.ts');
const timing = load('src/lib/localVideoSeekTiming.ts');
const bridge = load('src/lib/localVideoSeekBridge.ts');
const composition = load('src/lib/composition.ts');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function environment() {
  let now = 1000, sequence = 0;
  const timers = new Map(), runtimeListeners = new Set(), liveListeners = new Set();
  const win = new EventTarget();
  win.setTimeout = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; };
  win.clearTimeout = id => timers.delete(id);
  const live = { trackId: 10, sourceId: 7, currentTime: 12, targetRate: 2, audibleRate: 1.25,
    playing: true, scratchHeld: false, discontinuityRevision: 1, clientPresentationTimeMs: now,
    loopGeneration: 0, loopWrapCount: 0, loopStart: null, loopLength: null };
  const native = { trackId: 10, status: 'playing', playing: true, buffering: false, currentTime: 12,
    duration: 120, rate: 2, error: '', decks: [{ trackId: 10, discontinuityRevision: 1 }, { trackId: null }] };
  const runtime = { kind: 'desktop-native', state: () => native, subscribe(fn) {
    runtimeListeners.add(fn); fn(native, native); return () => runtimeListeners.delete(fn);
  } };
  const globals = { window: win, performance: { now: () => now }, HTMLMediaElement: { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 } };
  const media = load('src/lib/mediaSync.ts', {
    './waveformMotion': waveform,
    './unifiedPlayer': { runtimePlayer: () => runtime, getLiveForegroundDeck: () => 0, getLiveDeckClock: () => live,
      subscribeLivePlaybackClock(fn) { liveListeners.add(fn); return () => liveListeners.delete(fn); } },
  }, globals);
  const sync = load('src/lib/localVideoSync.ts', {}, globals);
  return { media, sync, globals, live, native, runtime, timers, runtimeListeners, liveListeners,
    setNow(value) { now = value; },
    publish() { for (const fn of [...liveListeners]) fn(); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
  };
}

class Video extends EventTarget {
  constructor() { super(); this.time = 0; this.seeks = []; this.pauses = 0; }
  readyState = 4; seeking = false; paused = true; playbackRate = 1; muted = true; src = ''; duration = 120;
  get currentTime() { return this.time; }
  set currentTime(value) { this.time = value; this.seeks.push(value); }
  pause() { if (this.paused) return; this.paused = true; this.pauses++; this.dispatchEvent(new Event('pause')); }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  load() {}
}

test('three minutes of normal clock jitter do not keep retuning the video decoder', () => {
  const e = environment(), video = new Video();
  video.paused = false; video.time = 12;
  e.live.audibleRate = 1;
  e.native.duration = 600;
  let rate = 1, writes = 0;
  Object.defineProperty(video, 'playbackRate', { get: () => rate, set(value) { rate = value; writes++; } });
  const sync = new e.sync.LocalVideoSynchronizer();
  sync.adoptClock(video, e.media.getLocalVideoClock(10));
  for (let step = 1; step <= 5400; step++) {
    video.time += rate / 30;
    e.setNow(1000 + step * 1000 / 30); e.live.clientPresentationTimeMs = 1000 + step * 1000 / 30;
    e.live.currentTime = 12 + step / 30 + Math.sin(step * 1.7) * 0.018;
    sync.followClock(video, e.media.getLocalVideoClock(10), () => assert.fail('steady playback must not seek'));
  }
  assert.equal(writes, 0, 'sub-frame clock noise must not restart rate correction');
  assert.ok(Math.abs(video.time - 192) < 0.04);
});

test('short IPC gaps preserve running video and clock ownership, but real transport changes stop it', () => {
  const e = environment(), video = new Video(); video.time = 12; video.paused = false;
  const sync = new e.sync.LocalVideoSynchronizer();
  const seeks = new e.sync.VideoSeekEchoGuard(), transport = new e.sync.VideoTransportEchoGuard();
  const unsubscribe = e.media.subscribeLocalVideoClock(10, clock => e.sync.applyLocalVideoClock(video, clock, sync, seeks, transport));
  for (let step = 0; step < 20; step++) {
    e.advance(350); video.time += 0.35 * video.playbackRate;
    assert.equal(video.paused, false, 'IPC jitter is not an audio pause');
    e.live.currentTime = video.time; e.live.clientPresentationTimeMs = 1350 + step * 350; e.publish();
  }
  assert.equal(video.pauses, 0); assert.deepEqual(video.seeks, []);
  e.native.buffering = true; e.publish(); assert.equal(video.paused, true);
  unsubscribe();
});

test('temporary video decoder starvation does not issue pause commands', () => {
  const e = environment(), video = new Video(); video.time = 12; video.paused = false;
  video.readyState = 1;
  e.sync.applyLocalVideoClock(video, e.media.getLocalVideoClock(10), new e.sync.LocalVideoSynchronizer(),
    new e.sync.VideoSeekEchoGuard(), new e.sync.VideoTransportEchoGuard());
  assert.equal(video.pauses, 0, 'let the media decoder resume when its buffer refills');
});

test('rate correction is bounded and isolated between main and inset decoders', () => {
  const e = environment(), main = new Video(), inset = new Video();
  main.paused = inset.paused = false;
  main.time = 11.8; inset.time = 12.2;
  const sync = new e.sync.LocalVideoSynchronizer(), clock = e.media.getLocalVideoClock(10);
  sync.adoptClock(main, clock); sync.adoptClock(inset, clock);
  sync.followClock(main, clock, () => assert.fail());
  sync.followClock(inset, clock, () => assert.fail());
  assert.ok(main.playbackRate > clock.rate); assert.ok(inset.playbackRate < clock.rate);
  assert.ok(main.playbackRate <= clock.rate * 1.12 + 0.001);
  const held = main.playbackRate;
  e.advance(200); main.time = 12.1;
  sync.followClock(main, { ...clock, position: 12 }, () => assert.fail());
  assert.equal(main.playbackRate, held, 'do not retune again during the correction interval');
  sync.followClock(main, { ...clock, rate: 2 }, () => assert.fail());
  assert.ok(main.playbackRate > 1.7, 'a real tempo change bypasses correction throttling');
});

test('WebKit learns decode landing delay then plays three minutes without recurring seeks or rate changes', () => {
  const e = environment(), video = new Video();
  e.native.duration = video.duration = 600; e.live.audibleRate = 1;
  video.paused = false; video.time = 11.5;
  const sync = new e.sync.LocalVideoSynchronizer('webkit');
  sync.adoptClock(video, e.media.getLocalVideoClock(10));
  let decodeUntil = 0, rateWrites = 0, rate = 1;
  Object.defineProperty(video, 'playbackRate', { get: () => rate, set(value) { rate = value; rateWrites++; } });
  for (let step = 1; step <= 3600; step++) {
    const now = 1000 + step * 50;
    e.setNow(now); e.live.clientPresentationTimeMs = now;
    e.live.currentTime = 12 + step * 0.05;
    if (!video.seeking) video.time += rate * 0.05;
    else if (now >= decodeUntil) video.seeking = false;
    sync.followClock(video, e.media.getLocalVideoClock(10), (element, target) => {
      element.currentTime = target; element.seeking = true; decodeUntil = now + 200;
    });
  }
  assert.equal(video.seeks.length, 2, 'one observed landing and one latency-compensated alignment, no repeating correction');
  assert.equal(rateWrites, 0, 'no WebKit pipeline retiming during steady playback');
  assert.ok(Math.abs(video.time - e.live.currentTime) < 0.04);
  e.live.discontinuityRevision++; e.live.currentTime = 50;
  sync.followClock(video, e.media.getLocalVideoClock(10), (element, target) => { element.currentTime = target; });
  assert.equal(video.seeks.length, 3, 'a real user seek still overrides the correction cooldown');
});

test('WebKit backs off an uncorrectable decoder instead of repeatedly interrupting playback', () => {
  const e = environment(), video = new Video();
  e.native.duration = video.duration = 600; e.live.audibleRate = 1;
  video.paused = false;
  const sync = new e.sync.LocalVideoSynchronizer('webkit');
  sync.adoptClock(video, e.media.getLocalVideoClock(10));
  const seekTimes = [];
  for (let elapsed = 0; elapsed <= 180_000; elapsed += 50) {
    e.setNow(1000 + elapsed); e.live.clientPresentationTimeMs = 1000 + elapsed;
    e.live.currentTime = 12 + elapsed / 1000;
    // Model a decoder whose presentation stays behind despite compensated alignment.
    video.time = e.live.currentTime - 0.5;
    sync.followClock(video, e.media.getLocalVideoClock(10), (element, target) => {
      seekTimes.push(elapsed); element.currentTime = target;
    });
    assert.equal(video.playbackRate, 1);
  }
  assert.ok(seekTimes.length <= 7, `unbounded corrections: ${seekTimes}`);
  assert.ok(seekTimes.at(-1) - seekTimes.at(-2) >= 60_000);
  const count = seekTimes.length;
  e.live.discontinuityRevision++; e.live.currentTime = 50;
  sync.followClock(video, e.media.getLocalVideoClock(10), (element, target) => {
    seekTimes.push(180_000); element.currentTime = target;
  });
  assert.equal(seekTimes.length, count + 1, 'backoff must not delay a user seek');
});

test('stale clocks cannot authorize a seek or prolong expiry through unrelated state events', () => {
  const e = environment(), fence = e.media.captureLocalVideoSeekFence(10);
  e.live.discontinuityRevision++;
  e.advance(300);
  const clock = e.media.getLocalVideoClock(10);
  assert.equal(clock.fresh, false); assert.equal(clock.position, 12.375);
  assert.equal(e.media.localVideoSeekHasLanded(fence, clock), false);
  const values = [];
  const unsubscribe = e.media.subscribeLocalVideoClock(10, clock => values.push(clock));
  e.advance(1000);
  for (const update of e.runtimeListeners) update();
  e.advance(201);
  assert.equal(values.at(-1), null, 'a state event does not renew the old device timestamp');
  unsubscribe(); assert.equal(e.timers.size, 0);
});

test('delayed decode does not publish the old seek target after activation; timeout cannot activate or publish', async () => {
  const events = [];
  let decode;
  const prepared = new Promise(resolve => { decode = resolve; });
  const run = timing.coordinateLocalVideoSeek(() => prepared, {
    commitAudio() { events.push('audio landed at 30'); }, isCurrent: () => true,
    publishVideoSeek() { events.push('rewind to 30'); },
  });
  await flush();
  decode({ activate() { events.push('video ready when audio is 30.8'); return true; }, cancel() {} });
  assert.equal(await run, 'activated');
  assert.deepEqual(events, ['audio landed at 30', 'video ready when audio is 30.8']);
  const canceled = await timing.coordinateLocalVideoSeek(() => { assert.fail('no decode on failed audio landing'); }, {
    commitAudio: () => false, isCurrent: () => true,
    publishVideoSeek() { assert.fail('no guessed-target fallback after timeout'); }, cancelVideo() { events.push('released'); },
  });
  assert.equal(canceled, 'canceled'); assert.equal(events.at(-1), 'released');
  assert.equal(await timing.coordinateLocalVideoSeek(() => Promise.resolve(null), {
    commitAudio() { throw Error('native seek failed'); }, isCurrent: () => true,
    publishVideoSeek() { assert.fail('audio errors must not publish video seek'); },
  }), 'canceled');
});

test('DAC projection advances between 10Hz snapshots; landing requires a new revision and ready device state', async () => {
  const e = environment();
  const fence = e.media.captureLocalVideoSeekFence(10);
  e.setNow(1090);
  assert.equal(e.media.getLocalVideoClock(10).position, 12.1125);
  assert.equal(e.native.currentTime, 12);
  assert.equal(e.media.localVideoSeekHasLanded(fence, e.media.getLocalVideoClock(10)), false);
  e.native.decks[0].discontinuityRevision = 2;
  assert.equal(e.media.getLocalVideoClock(10), null, 'pre-seek live packet loses to acknowledged discontinuity');
  e.live.discontinuityRevision = 2; e.live.currentTime = 30; e.live.clientPresentationTimeMs = 1090;
  e.native.buffering = true;
  assert.equal(e.media.getLocalVideoClock(10), null);
  e.native.buffering = false;
  // subscribe() calls back synchronously before it returns its unsubscriber.
  assert.equal((await e.media.waitForLocalVideoSeekLanding(fence, () => true)).position, 30);
  assert.equal(e.runtimeListeners.size, 0); assert.equal(e.liveListeners.size, 0); assert.equal(e.timers.size, 0);
  const never = e.media.waitForLocalVideoSeekLanding(e.media.captureLocalVideoSeekFence(10), () => true, 2000);
  e.advance(2001); assert.equal(await never, null);
  assert.equal(e.timers.size, 0); assert.equal(e.liveListeners.size, 0);
});

test('decoded video converges to actual audible clock without repeated seeks, pauses or rate reset', () => {
  const e = environment();
  const video = new Video(); video.paused = false; video.time = 30;
  e.live.currentTime = 30.8;
  const synchronizer = new e.sync.LocalVideoSynchronizer();
  const seekGuard = new e.sync.VideoSeekEchoGuard(), transportGuard = new e.sync.VideoTransportEchoGuard();
  synchronizer.adoptClock(video, e.media.getLocalVideoClock(10));
  assert.equal(video.playbackRate, 1.25);
  for (let step = 1; step <= 240; step++) {
    video.time += video.playbackRate * 0.05;
    e.setNow(1000 + step * 50); e.live.clientPresentationTimeMs = 1000 + step * 50;
    e.live.currentTime = 30.8 + step * 0.05 * 1.25;
    e.sync.applyLocalVideoClock(video, e.media.getLocalVideoClock(10), synchronizer, seekGuard, transportGuard);
  }
  assert.ok(Math.abs(video.time - e.live.currentTime) < 0.02, `phase debt ${e.live.currentTime - video.time}`);
  assert.deepEqual(video.seeks, []); assert.equal(video.pauses, 0);
  assert.ok(Math.abs(video.playbackRate - 1.25) < 0.01);
  e.live.currentTime = 8; e.live.discontinuityRevision++;
  e.sync.applyLocalVideoClock(video, e.media.getLocalVideoClock(10), synchronizer, seekGuard, transportGuard);
  assert.deepEqual(video.seeks, [8], 'a real new discontinuity lands once');
  assert.equal(seekGuard.consume(video, 8), true, 'programmatic landing is not echoed as user seek');
});

test('a canceled standby play promise cannot pause the element after a newer preparation activates it', async () => {
  const e = environment();
  let callbacks = [];
  const swapModule = load('src/lib/useLocalVideoSwap.ts', {
    react: { useRef: current => ({ current }), useState: value => [value, () => {}], useCallback: fn => fn, useEffect: fn => callbacks.push(fn) },
    './localVideoSeekBridge': bridge, './localVideoSync': e.sync, './mediaSync': e.media,
  }, e.globals);
  const active = new Video(), standby = new Video();
  let finishOldPlay, playCount = 0;
  standby.play = function () {
    this.paused = false; this.dispatchEvent(new Event('play')); playCount++;
    if (playCount === 1) return new Promise(resolve => { finishOldPlay = resolve; });
    return Promise.resolve();
  };
  const swap = swapModule.useLocalVideoSwap({ enabled: true, trackId: 10, desiredPlayingRef: { current: true }, getRate: () => 1.25 });
  swap.bindVideo(0)(active); swap.bindVideo(1)(standby);
  const cleanups = callbacks.map(fn => fn()); swap.load('track10', 'video:10');
  const old = swap.prepare(20); await flush(); assert.equal(typeof finishOldPlay, 'function');
  const latest = swap.prepare(30); await flush();
  const prepared = await latest; assert.ok(prepared);
  e.live.currentTime = 30.5;
  assert.equal(prepared.activate(), true); assert.equal(swap.activeVideo(), standby); assert.equal(standby.paused, false);
  const pauses = standby.pauses;
  finishOldPlay(); await flush(); assert.equal(await old, null);
  assert.equal(standby.paused, false, 'old decode must not freeze the new active slot');
  assert.equal(standby.pauses, pauses);
  cleanups.forEach(fn => fn?.());
});

test('device-feed loss pauses presentation; returning samples and seek echoes preserve ownership', () => {
  const e = environment(), video = new Video(); video.paused = false; video.time = 12;
  const synchronizer = new e.sync.LocalVideoSynchronizer();
  const seeks = new e.sync.VideoSeekEchoGuard(), transport = new e.sync.VideoTransportEchoGuard();
  const unsubscribe = e.media.subscribeLocalVideoClock(10, clock => e.sync.applyLocalVideoClock(video, clock, synchronizer, seeks, transport));
  e.advance(e.media.LOCAL_VIDEO_CLOCK_TIMEOUT_MS + 1);
  assert.equal(video.paused, true);
  assert.equal(transport.consume(video, 'pause'), true, 'clock-driven pause must not pause the audio transport');
  unsubscribe(); assert.equal(e.timers.size, 0);
});

test('a fence captured for queued B before dispatch falsely accepts A: capture after A instead', () => {
  const e = environment();
  const tooEarlyForB = e.media.captureLocalVideoSeekFence(10);
  e.live.discontinuityRevision = 2; e.live.currentTime = 30;
  assert.equal(e.media.localVideoSeekHasLanded(tooEarlyForB, e.media.getLocalVideoClock(10)), true,
    'this is why PlayerBar must capture when draining B, not while enqueuing B');
  const dispatchedB = e.media.captureLocalVideoSeekFence(10);
  assert.equal(e.media.localVideoSeekHasLanded(dispatchedB, e.media.getLocalVideoClock(10)), false);
  e.live.discontinuityRevision = 3; e.live.currentTime = 50;
  assert.equal(e.media.localVideoSeekHasLanded(dispatchedB, e.media.getLocalVideoClock(10)), true);
});

test('superseded decoder completion never cancels the newer coordinator', async () => {
  let isCurrent = true, resolveDecode, oldCanceled = 0, globalCanceled = 0;
  const result = timing.coordinateLocalVideoSeek(() => new Promise(resolve => { resolveDecode = resolve; }), {
    commitAudio() {}, isCurrent: () => isCurrent, cancelVideo() { globalCanceled++; },
    publishVideoSeek() { assert.fail('stale completion cannot publish'); },
  });
  await flush(); isCurrent = false;
  resolveDecode({ activate() { assert.fail('stale completion cannot activate'); }, cancel() { oldCanceled++; } });
  assert.equal(await result, 'stale'); assert.equal(oldCanceled, 1); assert.equal(globalCanceled, 0);
});

test('composition main picture renders for solo video and video/audio pairs without an inset decoder', () => {
  for (const audio of [null, { track_id: 11, is_video: false, duration_ms: 30000 }]) {
    const refs = [], effects = [], draws = [];
    const jsx = (type, props) => ({ type, props });
    const clock = { trackId: 10, ready: true, currentTime: 12, playing: true, rate: 1.25 };
    const preview = load('src/components/composition/OverlayPreview.tsx', {
      react: { useRef: current => { const ref = { current }; refs.push(ref); return ref; }, useState: value => [value, () => {}], useEffect: effect => effects.push(effect) },
      'react/jsx-runtime': { jsx, jsxs: jsx },
      '../../lib/api': { api: { videoUrl: id => `video:${id}`, coverUrl: id => `cover:${id}` } },
      '../../lib/composition': { ...composition, overlayAlpha: () => 0 },
      '../../lib/compositionPlayback': { getCompositionClock: () => clock, useCompositionClock: () => clock },
      '../../lib/localVideoSync': environment().sync,
      '../common': { InlineNotice: 'Notice' },
    }, { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, DOMException });
    const wrapper = preview.OverlayPreview({ task: { id: 'solo', video: { track_id: 10, duration_ms: 60000 }, audio }, offset: 0,
      options: { scale: 0.5, x: 0.5, y: 0.5, opacity: 1, fade_ms: 300 }, disabled: false, onPosition() {} });
    const tree = wrapper.type(wrapper.props);
    const nodes = tree.props.children[0].props.children.filter(Boolean);
    assert.equal(nodes.filter(node => node.type === 'video').length, 1);
    assert.equal(nodes.filter(node => node.type === 'canvas').length, 1);
    assert.equal(nodes.find(node => node.type === 'video').props.muted, true);
    refs[0].current = new Video();
    refs[3].current = { width: 640, height: 360, getContext: () => ({ fillRect() {}, drawImage(video) { draws.push(video); } }) };
    const cleanups = effects.map(effect => effect());
    assert.equal(draws.length, 1); assert.equal(draws[0], refs[0].current);
    assert.equal(refs[0].current.currentTime, 12); assert.equal(refs[0].current.playbackRate, 1.25);
    cleanups.forEach(cleanup => cleanup?.());
  }
});

test('composition holds decoded frames through seek loading and converges without repeated currentTime writes', async () => {
  const e = environment(), refs = [], effects = [];
  let frame;
  const jsx = (type, props) => ({ type, props });
  const clock = { trackId: 10, ready: true, currentTime: 12, playing: true, rate: 1.25,
    sourceId: 7, discontinuityRevision: 1, loopGeneration: 0, loopWrapCount: 0 };
  const preview = load('src/components/composition/OverlayPreview.tsx', {
    react: { useRef: current => { const ref = { current }; refs.push(ref); return ref; }, useState: value => [value, () => {}], useEffect: effect => effects.push(effect) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../lib/api': { api: { videoUrl: id => `video:${id}`, coverUrl: id => `cover:${id}` } },
    '../../lib/composition': { ...composition, overlayAlpha: () => 1 },
    '../../lib/compositionPlayback': { getCompositionClock: () => clock, useCompositionClock: () => clock },
    '../../lib/localVideoSync': e.sync,
    '../common': { InlineNotice: 'Notice' },
  }, { requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame() {}, DOMException });
  const wrapper = preview.OverlayPreview({ task: { id: 'pair', video: { track_id: 10, duration_ms: 60000 }, audio: { track_id: 11, is_video: true, duration_ms: 60000 } }, offset: 2000,
    options: { scale: 0.5, x: 0.5, y: 0.5, opacity: 1, fade_ms: 0 }, disabled: false, onPosition() {} });
  wrapper.type(wrapper.props);
  const main = new Video(), inset = new Video(); refs[0].current = main; refs[1].current = inset;
  refs[3].current = { width: 640, height: 360, getContext: () => ({ fillRect() {}, drawImage() {} }) };
  const cleanups = effects.map(effect => effect());
  await flush();
  assert.deepEqual(main.seeks, [12]); assert.deepEqual(inset.seeks, [10]);
  clock.ready = false; clock.currentTime = 0; clock.playing = false; frame();
  assert.equal(main.currentTime, 12); assert.equal(inset.currentTime, 10);
  assert.equal(main.paused, true); assert.equal(inset.paused, true);
  clock.ready = true; clock.playing = true; clock.currentTime = 30; clock.discontinuityRevision = 2; frame();
  await flush();
  assert.deepEqual(main.seeks, [12, 30]); assert.deepEqual(inset.seeks, [10, 28]);
  // Simulate half a second spent decoding the fresh landing while audio remained smooth.
  clock.currentTime = 30.5; frame();
  assert.equal(main.seeks.length, 2); assert.equal(inset.seeks.length, 2);
  assert.ok(main.playbackRate > 1.25); assert.ok(inset.playbackRate > 1.25);
  clock.trackId = 99; frame();
  assert.equal(main.currentTime, 30); assert.equal(inset.currentTime, 28);
  assert.equal(main.paused, true); assert.equal(inset.paused, true);
  cleanups.forEach(cleanup => cleanup?.());
});

test('actual PlayerBar dispatch callbacks fence queued B only after in-flight A lands', async () => {
  const path = new URL('../src/components/player/PlayerBar.tsx', import.meta.url);
  const source = ts.createSourceFile(String(path), readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['drainNativeSeek', 'requestNativeSeek']), declarations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) {
      declarations.push(`export const ${node.name.text} = ${node.initializer.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(declarations.length, 2);
  const e = environment(), commands = [], exports = {};
  const nativeSeekDrainRef = { current() {} };
  const runtime = { state: () => e.native, seek(position) {
    return new Promise((resolve, reject) => commands.push({ position, resolve, reject }));
  } };
  const code = ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, ...e.globals, useCallback: fn => fn, nativePlayer: runtime,
    nativeSeekRequestRef: { current: null }, nativeSeekInFlightRef: { current: false },
    trackRef: { current: { id: 10 } }, pendingSeekRef: { current: null }, nativeSeekDrainRef });
  nativeSeekDrainRef.current = exports.drainNativeSeek;
  let generation = 0;
  const dispatched = [];
  function request(position) {
    const token = ++generation;
    return new Promise(resolve => exports.requestNativeSeek(10, position, {
      onDispatch() {
        const fence = e.media.captureLocalVideoSeekFence(10);
        dispatched.push({ position, revision: fence.discontinuityRevision });
        void e.media.waitForLocalVideoSeekLanding(fence, () => token === generation).then(clock => resolve(clock !== null));
      }, onCancel() { resolve(false); },
    }));
  }
  const a = request(30);
  let bSettled = false;
  const b = request(50).then(value => { bSettled = true; return value; });
  assert.deepEqual(dispatched, [{ position: 30, revision: 1 }]);
  assert.equal(commands.length, 1);
  e.live.discontinuityRevision = 2; e.native.decks[0].discontinuityRevision = 2; e.live.currentTime = 30; e.publish();
  await flush(); assert.equal(await a, false); assert.equal(bSettled, false);
  commands[0].resolve(); await flush();
  assert.deepEqual(dispatched, [{ position: 30, revision: 1 }, { position: 50, revision: 2 }]);
  assert.equal(commands[1].position, 50);
  e.publish(); await flush(); assert.equal(bSettled, false, 'A replay after B dispatch does not approve B');
  e.live.discontinuityRevision = 3; e.native.decks[0].discontinuityRevision = 3; e.live.currentTime = 50; e.publish();
  assert.equal(await b, true);
  commands[1].resolve(); await flush();
  assert.equal(e.liveListeners.size, 0); assert.equal(e.runtimeListeners.size, 0); assert.equal(e.timers.size, 0);
});

test('WebKit ongoing drift uses a spare decoder without seeking the visible frame', () => {
  const e = environment(), video = new Video();
  e.live.audibleRate = 1; video.paused = false;
  const sync = new e.sync.LocalVideoSynchronizer('webkit');
  sync.adoptClock(video, e.media.getLocalVideoClock(10));
  let corrections = 0;
  for (let step = 0; step < 400; step++) {
    e.setNow(1000 + step * 50); e.live.clientPresentationTimeMs = 1000 + step * 50;
    e.live.currentTime = 12 + step * 0.05; video.time = e.live.currentTime - 0.3;
    sync.followClock(video, e.media.getLocalVideoClock(10), () => assert.fail('must not flush the visible decoder'), () => corrections++);
  }
  assert.ok(corrections > 0 && corrections <= 4);
  e.live.discontinuityRevision++;
  sync.followClock(video, e.media.getLocalVideoClock(10), (v, target) => { v.currentTime = target; }, () => assert.fail('user transport must stay immediate'));
  assert.equal(video.seeks.length, 1);
});

test('spare alignment waits through post-seek freeze and only adopts a moving aligned decoder', async () => {
  const e = environment(), active = new Video(), spare = new Video();
  e.live.audibleRate = 1; active.time = 11.7; active.paused = false;
  const sync = new e.sync.LocalVideoSynchronizer('webkit');
  sync.adoptClock(active, e.media.getLocalVideoClock(10));
  sync.followClock(active, e.media.getLocalVideoClock(10), () => assert.fail(), () => {});
  let elapsed = 0, resumesAt = 0, activated = false, finished = false;
  Object.defineProperty(spare, 'currentTime', { get: () => spare.time, set(value) {
    spare.time = value; spare.seeks.push(value); resumesAt = elapsed + 500;
  } });
  const work = sync.alignStandby(active, spare, () => !activated, () => {
    assert.ok(elapsed >= resumesAt + 150, 'a seeked event alone cannot authorize visibility');
    assert.ok(Math.abs(spare.time - e.live.currentTime) <= 0.08);
    activated = true; return true;
  }).then(result => { assert.equal(result, true); finished = true; });
  for (; elapsed < 5000 && !finished; elapsed += 50) {
    active.time += 0.05;
    if (!spare.paused && elapsed >= resumesAt) spare.time += 0.05;
    e.live.currentTime += 0.05; e.live.clientPresentationTimeMs += 50;
    e.advance(50);
    sync.followClock(active, e.media.getLocalVideoClock(10), () => assert.fail(), () => {});
    await flush();
  }
  assert.equal(finished, true); await work;
  assert.equal(active.seeks.length, 0); assert.equal(active.pauses, 0);
  assert.equal(spare.seeks.length, 2, 'learn the actual hidden decoder delay');
});

test('a superseded background alignment cannot pause a spare now owned by a user seek', async () => {
  const e = environment(), active = new Video(), spare = new Video();
  e.live.audibleRate = 1; active.time = 12; active.paused = false;
  const sync = new e.sync.LocalVideoSynchronizer('webkit');
  sync.adoptClock(active, e.media.getLocalVideoClock(10));
  sync.followClock(active, e.media.getLocalVideoClock(10), () => assert.fail(), () => {});
  let current = true;
  const work = sync.alignStandby(active, spare, () => current, () => assert.fail());
  await flush(); current = false;
  spare.currentTime = 80; await spare.play(); e.advance(50); await flush();
  assert.equal(await work, false); assert.equal(spare.pauses, 0); assert.equal(spare.currentTime, 80);
});
