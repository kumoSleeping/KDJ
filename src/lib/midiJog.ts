import { clampPerformanceDeckPosition } from "./deckPosition";
import { PLATTER_RPM, PLATTER_SECONDS_PER_REVOLUTION } from "./platter";

/**
 * Reloop Buddy 的缓动盘协议把转速编码进单条相对 CC。真实的触摸状态由
 * Note 6 单独给出：边缘转动是短暂 pitch bend，按住电容盘面才是局部刮擦。
 * Buddy/Mixxx 参考映射把盘面解析成每圈 360 个 tick。盘面运动统一换算成
 * 33⅓ RPM 媒体距离，再由源时间戳换成速度；它不再拥有另一套绝对位置逻辑。
 */

export const MIDI_JOG_TICKS_PER_REVOLUTION = 360;
/** 官方手册把 Shift+Jog 定义为 quick search；八圈横跨整轨，快但仍可控。 */
export const MIDI_JOG_QUICK_SEARCH_TURNS_PER_TRACK = 8;
/** Capacitive vinyl: one platter revolution is 33⅓ RPM, like a real record. */
export const MIDI_JOG_VINYL_RPM = PLATTER_RPM;
/** 7-bit relative full range (01h/7Fh or 64-centered). Clipping to 8 dropped fast spins. */
const MAX_RELATIVE_TICKS_PER_MESSAGE = 64;
/** Edge pitch-bend stays a small nudge even when a relative packet is large. */
const MAX_NUDGE_TICKS_PER_MESSAGE = 8;
/** Edge-jog bursts share a cursor so 01h ticks accumulate. A held platter must ignore this. */
export const MIDI_JOG_CURSOR_STALE_MS = 240;
/** Must mirror the native pitch-preserving tempo window in kdj-playback's JOG_NUDGE_* constants. */
export const MIDI_JOG_NUDGE_HOLD_MS = 180;
export const MIDI_JOG_NUDGE_MAX_RATE_OFFSET = 0.18;

export interface MidiJogCursor {
  trackId: number;
  position: number;
  at: number;
}

function relativeJogTicks(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  return Math.sign(delta) * Math.min(MAX_RELATIVE_TICKS_PER_MESSAGE, Math.abs(delta));
}

function boundedNudgeTicks(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  return Math.sign(delta) * Math.min(MAX_NUDGE_TICKS_PER_MESSAGE, Math.abs(delta));
}

/** Held platter motion in track seconds, mapped like a 33⅓ RPM record. */
export function midiJogVinylSeconds(delta: number): number {
  return relativeJogTicks(delta) * (
    PLATTER_SECONDS_PER_REVOLUTION / MIDI_JOG_TICKS_PER_REVOLUTION
  );
}

export function midiJogSeekSeconds(delta: number, duration: number): number {
  const span = Number.isFinite(duration) && duration > 0 ? duration : 180;
  return relativeJogTicks(delta) * (
    span / (MIDI_JOG_TICKS_PER_REVOLUTION * MIDI_JOG_QUICK_SEARCH_TURNS_PER_TRACK)
  );
}

/** 边缘转动给原生引擎的归一化、瞬态保调变速幅度。 */
export function midiJogNudgeAmount(delta: number): number {
  return boundedNudgeTicks(delta) / MAX_NUDGE_TICKS_PER_MESSAGE;
}

/** A stopped transport has nothing to nudge; edge rotation must own the platter cursor instead. */
export function midiJogUsesPlatter(surfaceHeld: boolean, transportRunning: boolean): boolean {
  return surfaceHeld || !transportRunning;
}

/** Compositor preview of the native 90ms edge pitch bend; persistent TEMPO remains unchanged. */
export function midiJogNudgeRate(baseRate: number, amount: number): number {
  const base = Number.isFinite(baseRate) && baseRate > 0 ? baseRate : 1;
  const bend = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0;
  return Math.max(0.5, Math.min(2, base * (1 + bend * MIDI_JOG_NUDGE_MAX_RATE_OFFSET)));
}

export function clampJogPosition(position: number, duration: number): number {
  // Media decoding still begins at 0; the Performance renderer turns negative positions into a
  // bounded silent pre-roll so a real platter can pull the first downbeat behind the zero line.
  return clampPerformanceDeckPosition(position, duration);
}

/**
 * A capacitive hold owns the playhead until note-off. Falling back to the live engine clock
 * after a quiet 240ms made a held platter track wherever the song would have played, so the
 * waveform looked stuck and release jumped forward.
 */
export function midiJogCursorPosition(
  cursor: MidiJogCursor | null,
  trackId: number,
  livePosition: number,
  now: number,
  held: boolean,
): number {
  if (!cursor || cursor.trackId !== trackId) return livePosition;
  if (held) return cursor.position;
  if (now - cursor.at < MIDI_JOG_CURSOR_STALE_MS) return cursor.position;
  return livePosition;
}
