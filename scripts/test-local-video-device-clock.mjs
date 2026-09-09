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
  const globals = { window: win, performance: { now: () => now }, AbortController, DOMException, HTMLMediaElement: { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 } };
  const media = load('src/lib/mediaSync.ts', {
    './waveformMotion': waveform,
    './unifiedPlayer': { runtimePlayer: () => runtime, getLiveForegroundDeck: () => 0, getLiveDeckClock: () => live,
      subscribeLivePlaybackClock(fn) { liveListeners.add(fn); return () => liveListeners.delete(fn); } },
  }, globals);
  const frames = load('src/lib/videoFrames.ts', {}, globals);
  const sync = load('src/lib/videoPlaybackEngine.ts', { './videoFrames': frames, './videoSeekQueue': load('src/lib/videoSeekQueue.ts', {}, { AbortController }) }, globals);
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
  const sync = new e.sync.VideoPlaybackEngine();
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
  const sync = new e.sync.VideoPlaybackEngine();
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
  e.sync.applyLocalVideoClock(video, e.media.getLocalVideoClock(10), new e.sync.VideoPlaybackEngine(),
    new e.sync.VideoSeekEchoGuard(), new e.sync.VideoTransportEchoGuard());
  assert.equal(video.pauses, 0, 'let the media decoder resume when its buffer refills');
});

test('rate correction is bounded and isolated between main and inset decoders', () => {
  const e = environment(), main = new Video(), inset = new Video();
  main.paused = inset.paused = false;
  main.time = 11.8; inset.time = 12.2;
  const sync = new e.sync.VideoPlaybackEngine(), clock = e.media.getLocalVideoClock(10);
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
  const sync = new e.sync.VideoPlaybackEngine('webkit');
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

test('WebKit preroll learns its restart delay while hidden and crosses the cut already aligned', () => {
  const e = environment(), video = new Video();
  e.live.audibleRate = 1.5;
  const engine = new e.sync.VideoPlaybackEngine('webkit');
  let stalledUntil = 0;
  const seeks = [];
  for (let ms = -2500; ms <= 1000; ms += 50) {
    e.setNow(ms + 3500); e.live.clientPresentationTimeMs = ms + 3500;
    e.live.currentTime = 8 + ms / 1000 * 1.5;
    if (ms >= stalledUntil) video.time += video.playbackRate * .05;
    video.paused = false;
    engine.followClock(video, e.media.getLocalVideoClock(10), (v, target) => {
      seeks.push(ms); v.currentTime = target; stalledUntil = ms + 550;
    }, () => assert.fail('hidden preparation does not need another decoder'), ms < -1000);
    if (ms >= 0) assert.ok(Math.abs(video.time - e.live.currentTime) < .08,
      `cut at ${ms}ms exposed a late source handle: ${video.time} / ${e.live.currentTime}`);
  }
  assert.equal(seeks.length, 2, 'initial decode and one learned-latency alignment');
  assert.ok(seeks.every(ms => ms < -1000), 'no seek when the picture becomes visible');
});

test('WebKit backs off an uncorrectable decoder instead of repeatedly interrupting playback', () => {
  const e = environment(), video = new Video();
  e.native.duration = video.duration = 600; e.live.audibleRate = 1;
  video.paused = false;
  const sync = new e.sync.VideoPlaybackEngine('webkit');
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
  const synchronizer = new e.sync.VideoPlaybackEngine();
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
    './localVideoSeekBridge': bridge, './videoPlaybackEngine': e.sync, './mediaSync': e.media,
    './videoFrames': load('src/lib/videoFrames.ts', {}, e.globals),
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
  const synchronizer = new e.sync.VideoPlaybackEngine();
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
      '../../lib/videoPlaybackEngine': environment().sync,
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
    '../../lib/videoPlaybackEngine': e.sync,
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

test('actual PlayerBar waveform position stays pinned until a dispatched seek lands, not a timer', () => {
  const path = new URL('../src/components/player/PlayerBar.tsx', import.meta.url);
  const source = ts.createSourceFile(String(path), readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let statements;
  function visit(node) {
    if (ts.isVariableStatement(node)
      && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'pendingSeek')) {
      const siblings = [...node.parent.statements];
      const start = siblings.indexOf(node);
      const end = siblings.findIndex(statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'shownTime'));
      assert.ok(end > start);
      statements = siblings.slice(start, end + 1).map(statement => statement.getText(source)).join('\n');
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(statements);
  const e = environment();
  const pendingSeekRef = { current: null }, nativeSeekRequestRef = { current: null };
  const sample = vm.runInNewContext(`() => { ${statements}; return shownTime; }`, {
    ...e.globals, state: e.native, pendingSeekRef, nativeSeekRequestRef,
  });
  const pin = position => { pendingSeekRef.current = { trackId: 10, position, at: 1000 }; };

  pin(60);
  e.native.currentTime = 0;
  for (const elapsed of [100, 1499, 1600, 2500, 5000]) {
    e.setNow(1000 + elapsed);
    assert.equal(sample(), 60, `old zero snapshot after ${elapsed}ms must not move the waveform`);
    assert.ok(pendingSeekRef.current);
  }
  e.native.currentTime = 60; e.native.buffering = true;
  assert.equal(sample(), 60);
  assert.ok(pendingSeekRef.current, 'optimistic target during buffering is not a landing');
  e.native.currentTime = 0;
  assert.equal(sample(), 60, 'a subsequent loading snapshot cannot undo the pinned target');
  e.native.currentTime = 60; e.native.buffering = false; e.native.status = 'loading';
  sample(); assert.ok(pendingSeekRef.current);
  e.native.status = 'playing'; e.native.currentTime = 60.2;
  assert.equal(sample(), 60.2); assert.equal(pendingSeekRef.current, null);
  e.native.currentTime = 61;
  assert.equal(sample(), 61, 'normal position updates resume after landing');

  pin(61.5); nativeSeekRequestRef.current = { trackId: 10, position: 61.5 };
  assert.equal(sample(), 61.5);
  assert.ok(pendingSeekRef.current, 'nearby old position cannot acknowledge an undispatched gesture');
  nativeSeekRequestRef.current = null; e.native.currentTime = 61.5;
  sample(); assert.equal(pendingSeekRef.current, null);

  pin(80); e.native.status = 'error'; e.native.currentTime = 61.5;
  assert.equal(sample(), 61.5); assert.equal(pendingSeekRef.current, null);
  pin(80); e.native.status = 'playing'; e.native.trackId = 11; e.native.currentTime = 0;
  assert.equal(sample(), 0); assert.equal(pendingSeekRef.current, null, 'track replacement releases the old pin');
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
  const sync = new e.sync.VideoPlaybackEngine('webkit');
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
  const sync = new e.sync.VideoPlaybackEngine('webkit');
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
  const sync = new e.sync.VideoPlaybackEngine('webkit');
  sync.adoptClock(active, e.media.getLocalVideoClock(10));
  sync.followClock(active, e.media.getLocalVideoClock(10), () => assert.fail(), () => {});
  let current = true;
  const work = sync.alignStandby(active, spare, () => current, () => assert.fail());
  await flush(); current = false;
  spare.currentTime = 80; await spare.play(); e.advance(50); await flush();
  assert.equal(await work, false); assert.equal(spare.pauses, 0); assert.equal(spare.currentTime, 80);
});

function frameVideo(e) {
  const video = new Video(), callbacks = new Map();
  let sequence = 0;
  video.requestVideoFrameCallback = callback => { const id = ++sequence; callbacks.set(id, callback); return id; };
  video.cancelVideoFrameCallback = id => callbacks.delete(id);
  video.frame = time => {
    video.time = time;
    for (const [id, callback] of [...callbacks]) {
      callbacks.delete(id); callback(0, { mediaTime: time });
    }
  };
  video.callbacks = callbacks;
  return video;
}

test('frame readiness rejects the old image and a frozen cursor; continuous output leaves no callbacks', async () => {
  const e = environment(), video = frameVideo(e), abort = new AbortController();
  const frames = load('src/lib/videoFrames.ts', {}, e.globals);
  let ready = false;
  video.paused = false;
  const result = frames.waitForVideoFrames(video, 30, true, abort.signal).then(value => { ready = value; return value; });
  video.frame(12); video.frame(12.04); video.frame(12.08); await flush(); assert.equal(ready, false);
  video.frame(30); video.frame(30); video.frame(30); await flush(); assert.equal(ready, false);
  e.advance(40); video.frame(30.04); await flush(); assert.equal(ready, false);
  e.advance(40); video.frame(30.08);
  assert.equal(await result, true); assert.equal(video.callbacks.size, 0); assert.equal(e.timers.size, 0);
});

test('missing compositor frames time out as failure, and cancellation releases a callback immediately', async () => {
  const e = environment(), video = frameVideo(e), frames = load('src/lib/videoFrames.ts', {}, e.globals);
  const timed = frames.waitForVideoFrames(video, 30, false, new AbortController().signal);
  e.advance(900); assert.equal(await timed, false); assert.equal(video.callbacks.size, 0); assert.equal(e.timers.size, 0);
  const abort = new AbortController();
  const canceled = frames.waitForVideoFrames(video, 30, true, abort.signal);
  abort.abort(); assert.equal(await canceled, false); assert.equal(video.callbacks.size, 0); assert.equal(e.timers.size, 0);
});

function swapEnvironment(e) {
  const effects = [];
  const module = load('src/lib/useLocalVideoSwap.ts', {
    react: { useRef: current => ({ current }), useState: value => [value, () => {}], useCallback: fn => fn, useEffect: fn => effects.push(fn) },
    './localVideoSeekBridge': bridge, './videoPlaybackEngine': e.sync, './mediaSync': e.media,
    './videoFrames': load('src/lib/videoFrames.ts', {}, e.globals),
  }, e.globals);
  const old = frameVideo(e), spare = frameVideo(e);
  const swap = module.useLocalVideoSwap({ enabled: true, trackId: 10, desiredPlayingRef: { current: true }, getRate: () => 1 });
  swap.bindVideo(0)(old); swap.bindVideo(1)(spare);
  const cleanups = effects.map(fn => fn()); swap.load('track10', 'video:10');
  return { swap, old, spare, cleanup() { cleanups.forEach(fn => fn?.()); } };
}

test('a playing handoff waits for actual advancing frames and never pauses/restarts the prepared decoder', async () => {
  const e = environment(), { swap, old, spare, cleanup } = swapEnvironment(e);
  e.live.audibleRate = 1;
  bridge.holdLocalVideoSeekPosition(10);
  e.live.discontinuityRevision++; e.live.currentTime = 30;
  await old.play();
  const work = swap.prepare(30); await flush();
  assert.equal(spare.callbacks.size, 1, 'observe before any compositor callback can arrive');
  spare.frame(30); await flush();
  assert.equal(swap.activeVideo(), old, 'the first frame is insufficient for a moving swap');
  for (const position of [30.04, 30.08]) {
    e.advance(40); e.live.currentTime = position; e.live.clientPresentationTimeMs += 40;
    spare.frame(position); await flush();
  }
  const prepared = await work;
  assert.ok(prepared); assert.equal(spare.paused, false); assert.equal(spare.pauses, 0);
  assert.equal(prepared.activate(), true); assert.equal(swap.activeVideo(), spare);
  assert.equal(spare.pauses, 0); assert.equal(old.paused, true);
  assert.equal(spare.callbacks.size, 0); assert.equal(e.timers.size, 0);
  cleanup();
});

test('canceling a preparation stops its spare and releases waits without touching the active video', async () => {
  const e = environment(), { swap, old, spare, cleanup } = swapEnvironment(e);
  await old.play();
  const work = swap.prepare(30); await flush();
  assert.equal(spare.paused, false); assert.equal(spare.callbacks.size, 1);
  swap.cancelPending();
  assert.equal(await work, null); assert.equal(spare.paused, true); assert.equal(old.paused, false);
  assert.equal(spare.callbacks.size, 0); assert.equal(e.timers.size, 0); cleanup();
});

test('shared seek lane coalesces gestures for local files, proxy streams and YouTube HLS', async () => {
  for (const source of ['video:local', 'https://loopback/video/preview', 'https://loopback/youtube/session.m3u8']) {
    const e = environment(), video = new Video(), engine = new e.sync.VideoPlaybackEngine();
    video.src = source;
    Object.defineProperty(video, 'currentTime', { get: () => video.time, set(time) {
      video.time = time; video.seeks.push(time); video.seeking = true;
    } });
    const first = engine.seek(video, 10), skipped = engine.seek(video, 20), latest = engine.seek(video, 30);
    assert.deepEqual(video.seeks, [10]); assert.equal(await skipped, false);
    video.seeking = false; video.dispatchEvent(new Event('seeked')); await flush();
    assert.equal(await first, false); assert.deepEqual(video.seeks, [10, 30]);
    video.seeking = false; video.dispatchEvent(new Event('seeked'));
    assert.equal(await latest, true); assert.equal(e.timers.size, 0); engine.dispose();
  }
});

test('source teardown cancels both in-flight waits and queued targets before a new source plays', async () => {
  const e = environment(), video = new Video(), engine = new e.sync.VideoPlaybackEngine();
  Object.defineProperty(video, 'currentTime', { get: () => video.time, set(time) {
    video.time = time; video.seeks.push(time); video.seeking = true;
  } });
  const first = engine.seek(video, 10), queued = engine.seek(video, 20);
  engine.dispose(); video.src = 'new-source';
  assert.equal(await first, false); assert.equal(await queued, false);
  assert.deepEqual(video.seeks, [10]); assert.equal(e.timers.size, 0);
});

test('official-player command adapters share bounded latest-target scheduling and cancel on disposal', async () => {
  for (const platform of ['youtube', 'bilibili']) {
    const queue = load('src/lib/videoSeekQueue.ts', {}, { AbortController });
    const pending = [], commands = [];
    const bridge = {
      open: async () => {}, status: async () => ({ ready: true }), close: async () => {},
      control(...args) {
        if (args.at(-2) !== 'seek') return Promise.resolve();
        commands.push(args.at(-1));
        return new Promise(resolve => pending.push(resolve));
      },
    };
    const e = environment();
    const module = load(`src/lib/${platform}Embed.ts`, {
      './videoSeekQueue': queue,
      './bridge': { getBridge: () => ({ [`${platform}Embed`]: bridge }) },
      './activityLog': { finishApiActivity() {} },
    }, e.globals);
    const Controller = module[platform === 'youtube' ? 'YoutubeEmbedController' : 'BilibiliEmbedController'];
    const controller = new Controller({ videoId: 'id', bvid: 'id', page: 0, bounds: {}, muted: true, volume: 1,
      onStatus() {}, onError(error) { assert.fail(String(error)); } });
    await controller.done;
    const first = controller.seek(10); await flush();
    const skipped = controller.seek(20), latest = controller.seek(30);
    await skipped; assert.deepEqual(commands, [10]); pending.shift()(); await first; await flush();
    assert.deepEqual(commands, [10, 30]);
    const abandoned = controller.seek(40); controller.dispose(); await abandoned;
    pending.shift()(); await latest; assert.deepEqual(commands, [10, 30]); assert.equal(e.timers.size, 0);
  }
});

test('rapid relative nudges retain every increment while absolute decoder targets are coalesced', async () => {
  const e = environment(), video = new Video(), engine = new e.sync.VideoPlaybackEngine();
  video.time = 10;
  Object.defineProperty(video, 'currentTime', { get: () => video.time, set(time) {
    video.time = time; video.seeks.push(time); video.seeking = true;
  } });
  const pending = [];
  for (let i = 0; i < 5; i++) pending.push(engine.seek(video, engine.position(video) + 0.1));
  assert.ok(Math.abs(engine.position(video) - 10.5) < 1e-9);
  video.seeking = false; video.dispatchEvent(new Event('seeked')); await flush();
  assert.equal(video.seeks.length, 2);
  assert.ok(Math.abs(video.seeks[1] - 10.5) < 1e-9);
  video.seeking = false; video.dispatchEvent(new Event('seeked'));
  assert.deepEqual(await Promise.all(pending), [false, false, false, false, true]);
  engine.dispose(); assert.equal(e.timers.size, 0);
});

function workshopTransport(e) {
  const effects = [], cleanups = [], commands = [];
  const editor = { activeId: 'project', draft: { id: 'project', revision: 1, name: 'Preview',
    sources: [{ id: 'source', track_id: 1 }], layers: [{ source_id: 'source' }] },
    auditionAfterLayer: {}, saving: 0, gesture: null, scrubbing: false, position: 12000,
    seek(ms) { editor.position = ms; } };
  const store = selector => selector(editor);
  store.getState = () => editor;
  const notify = () => { for (const fn of [...e.runtimeListeners]) fn(); };
  e.runtime.pause = async () => { e.native.playing = false; e.native.status = 'paused'; notify(); };
  e.runtime.play = async () => { e.native.playing = true; e.native.status = 'playing'; notify(); };
  e.runtime.seek = async seconds => {
    commands.push(seconds);
    // The command response is optimistic; the audio callback has not landed yet.
    e.native.currentTime = seconds; notify();
  };
  const hook = load('src/lib/workshopPlayback.ts', {
    react: { useCallback: fn => fn, useRef: current => ({ current }),
      useState: initial => [initial, () => {}], useEffect: fn => effects.push(fn) },
    './api': { api: { previewWorkshop: async () => ({ ticket: 'ticket' }),
      releaseWorkshop: async () => {}, track: async () => ({ id: 1 }), workshopAudioUrl: () => '/preview.wav' } },
    './unifiedPlayer': { runtimePlayer: () => e.runtime },
    './mediaSync': e.media,
    './streamTrack': { makeCompositionPreviewTrack: () => ({ id: 10 }) },
    './playTrack': { PLAY_EVENT: 'play', playTrack: () => { e.native.playing = true; notify(); } },
    '../stores/workshopStore': { useWorkshopStore: store },
    './workshop': { projectDuration: () => 120000 },
  }, { ...e.globals, setTimeout: e.globals.window.setTimeout, clearTimeout: e.globals.window.clearTimeout });
  const transport = hook.useWorkshopPlayback();
  for (const effect of effects) cleanups.push(effect());
  return { transport, editor, commands, notify, dispose() { for (const cleanup of cleanups) cleanup?.(); } };
}

test('workshop seek stays pinned through optimistic snapshots until the native clock lands', async () => {
  const e = environment(), w = workshopTransport(e);
  e.advance(120); await flush(); w.transport.toggle(); await flush();
  const seek = w.transport.seek(30000);
  await flush();
  assert.equal(w.transport.time(), 30000, 'old DAC sample cannot bounce the pointer back');
  assert.equal(w.editor.position, 30000);
  assert.equal(w.transport.pendingSeek(), true, 'video cannot follow the old clock during the transaction');
  e.native.decks[0].discontinuityRevision = 2; w.notify();
  assert.equal(w.transport.time(), 30000, 'a command acknowledgement alone is not a landing');
  e.live.discontinuityRevision = 2; e.live.currentTime = 30.2; e.live.clientPresentationTimeMs = 1120;
  e.publish(); await seek;
  assert.equal(w.transport.pendingSeek(), false);
  assert.equal(w.transport.time(), 30200, 'handoff uses the actual landing, not the frozen requested time');
  assert.equal(w.editor.position, 30200);
  w.dispose(); assert.equal(e.timers.size, 0);
});

test('workshop scrub release keeps its pointer while pause and seek acknowledgements arrive late', async () => {
  const e = environment(), w = workshopTransport(e);
  e.advance(120); await flush(); w.transport.toggle(); await flush();
  let finishPause;
  e.runtime.pause = () => new Promise(resolve => { finishPause = () => {
    e.native.playing = false; e.native.status = 'paused'; w.notify(); resolve();
  }; });
  let resumes = 0;
  e.runtime.play = async () => { resumes++; e.native.playing = true; w.notify(); };
  w.editor.scrubbing = true; w.transport.beginScrub();
  w.transport.seek(20000); w.transport.seek(40000);
  w.editor.scrubbing = false; w.transport.endScrub();
  w.notify();
  assert.equal(w.editor.position, 40000);
  assert.deepEqual(w.commands, []);
  finishPause(); await flush();
  assert.deepEqual(w.commands, [40]);
  assert.equal(w.transport.time(), 40000);
  assert.equal(resumes, 0, 'resume must wait for the real audio landing');
  e.live.discontinuityRevision = 2; e.live.currentTime = 40; e.live.clientPresentationTimeMs = 1120;
  e.publish(); await flush();
  assert.equal(resumes, 1);
  assert.equal(w.transport.time(), 40000);
  w.dispose(); finishPause(); assert.equal(e.timers.size, 0);
});

test('workshop queued seek keeps the newest pointer and does not accept the previous seek landing', async () => {
  const e = environment(), w = workshopTransport(e);
  e.advance(120); await flush(); w.transport.toggle(); await flush();
  const first = w.transport.seek(30000); await flush();
  const latest = w.transport.seek(50000); w.transport.seek(60000); await flush();
  assert.deepEqual(w.commands, [30]);
  e.live.discontinuityRevision = 2; e.live.currentTime = 30; e.live.clientPresentationTimeMs = 1120;
  e.publish(); await flush();
  assert.deepEqual(w.commands, [30, 60]);
  assert.equal(w.transport.time(), 60000);
  assert.equal(w.editor.position, 60000);
  assert.equal(w.transport.pendingSeek(), true);
  e.publish(); await flush();
  assert.equal(w.transport.pendingSeek(), true, 'A cannot release B even after B command response');
  e.live.discontinuityRevision = 3; e.live.currentTime = 60; e.publish();
  await Promise.all([first, latest]);
  assert.equal(w.transport.pendingSeek(), false);
  assert.equal(w.transport.time(), 60000);
  w.dispose(); assert.equal(e.timers.size, 0);
});

test('background correction cannot reveal a decoder whose cursor moves without compositor frames', async () => {
  const e = environment(), active = new Video(), spare = frameVideo(e);
  e.live.audibleRate = 1; active.time = 11.7; active.paused = false;
  const engine = new e.sync.VideoPlaybackEngine('webkit');
  engine.adoptClock(active, e.media.getLocalVideoClock(10));
  engine.followClock(active, e.media.getLocalVideoClock(10), () => assert.fail(), () => {});
  let finished = false;
  const work = engine.alignStandby(active, spare, () => true, () => assert.fail('unpresented frames must not activate'))
    .then(result => { assert.equal(result, false); finished = true; });
  for (let elapsed = 0; elapsed < 2500 && !finished; elapsed += 50) {
    spare.time += 0.05; e.live.currentTime += 0.05; e.live.clientPresentationTimeMs += 50;
    e.advance(50); engine.followClock(active, e.media.getLocalVideoClock(10), () => assert.fail(), () => {});
    await flush();
  }
  assert.equal(finished, true); await work;
  assert.equal(active.pauses, 0); assert.equal(spare.paused, true);
  assert.equal(spare.callbacks.size, 0); assert.equal(e.timers.size, 0);
});
