import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WaveformRailMotion } from '../src/lib/waveformRailMotion';

function fixture() {
  const animations: any[] = [];
  const rail = { style: { transform: '' }, animate(frames: any, options: any) {
    const animation = { currentTime: 0, cancelled: false, cancel() { this.cancelled = true; }, frames, options };
    animations.push(animation);
    return animation;
  } } as unknown as HTMLElement;
  const motion = new WaveformRailMotion();
  const sync = (position: number, rate = 1, revision = 0, loopStart: number | null = null, loopLength: number | null = null) =>
    motion.sync(rail, position, 24, 6, 180, rate, revision, loopStart, loopLength);
  return { rail, animations, motion, sync };
}

test('ordinary transport publications leave the compositor animation running', () => {
  const { rail, animations, sync, motion } = fixture();
  sync(30);
  const transform = rail.style.transform;
  for (let i = 1; i <= 40; i++) {
    animations[0].currentTime = i * 100;
    sync(30 + i / 10 + .005);
  }
  assert.equal(animations.length, 1);
  assert.equal(rail.style.transform, transform);
  assert.equal(animations[0].options.duration, 9000);
  assert.match(animations[0].frames[1].transform, /-83\.333/);
  animations[0].currentTime = 5000;
  assert.equal(animations.length, 1);
  assert.equal(rail.style.transform, transform);
  assert.equal(motion.position(30.25), 35, 'stalled bridge samples do not freeze compositor coverage');
});

test('seek revisions, pause and reverse playback land explicitly', () => {
  const { animations, rail, sync } = fixture();
  sync(30);
  sync(32, 1, 1);
  assert.equal(animations[0].cancelled, true);
  sync(32, 0, 1);
  assert.equal(animations[1].cancelled, true);
  const parked = rail.style.transform;
  sync(32, -1, 1);
  assert.equal(rail.style.transform, parked);
  assert.equal(animations[2].options.duration, 5000);
  animations[2].currentTime = 1000;
  sync(31, -1, 1);
  assert.equal(animations.length, 3);
});

test('covered loops repeat on the compositor in either direction', () => {
  for (const rate of [1, -1]) {
    const { animations, sync, motion } = fixture();
    sync(31, rate, 0, 30, 2);
    const animation = animations[0];
    assert.equal(animation.options.iterations, Infinity);
    assert.equal(animation.options.direction, rate > 0 ? 'normal' : 'reverse');
    animation.currentTime += 1500;
    sync(rate > 0 ? 30.5 : 31.5, rate, 0, 30, 2);
    assert.equal(animations.length, 1);
    motion.stop();
    assert.equal(animation.cancelled, true);
  }
});

test('without Web Animations the same exact position is painted', () => {
  const motion = new WaveformRailMotion();
  const rail = { style: { transform: '' } } as HTMLElement;
  motion.sync(rail, 33, 24, 6, 180, 1, 0, null, null);
  assert.equal(rail.style.transform, 'translate3d(-50%,0,0)');
});
