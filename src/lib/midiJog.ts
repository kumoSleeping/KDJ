/**
 * Reloop Buddy 的缓动盘协议把转速编码进单条相对 CC。真实的触摸状态由
 * Note 6 单独给出：边缘转动是短暂 pitch bend，按住电容盘面才是局部刮擦。
 * Buddy/Mixxx 参考映射把盘面解析成每圈 360 个 tick。用户所指的是带编号的黄色
 * 小节线（而非其中的细拍线），所以局部模式的一整圈跨一个 bar-grid 单元；此前把
 * 可视波形窗口除以 72，实际一圈能跳过数十秒。
 */

export const MIDI_JOG_TICKS_PER_REVOLUTION = 360;
/** 官方手册把 Shift+Jog 定义为 quick search；八圈横跨整轨，快但仍可控。 */
export const MIDI_JOG_QUICK_SEARCH_TURNS_PER_TRACK = 8;
/** Capacitive vinyl: one platter revolution is 33⅓ RPM, like a real record. */
export const MIDI_JOG_VINYL_RPM = 100 / 3;
const MAX_JOG_TICKS_PER_MESSAGE = 8;
/** Edge-jog bursts share a cursor so 01h ticks accumulate. A held platter must ignore this. */
export const MIDI_JOG_CURSOR_STALE_MS = 240;

export interface MidiJogCursor {
  trackId: number;
  position: number;
  at: number;
}

function boundedJogTicks(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  return Math.sign(delta) * Math.min(MAX_JOG_TICKS_PER_MESSAGE, Math.abs(delta));
}

export function midiJogScratchSeconds(delta: number, gridSeconds: number): number {
  const grid = Number.isFinite(gridSeconds) && gridSeconds > 0 ? gridSeconds : 2;
  return boundedJogTicks(delta) * (grid / MIDI_JOG_TICKS_PER_REVOLUTION);
}

/** Held platter motion in track seconds, mapped like a 33⅓ RPM record. */
export function midiJogVinylSeconds(delta: number): number {
  const secondsPerRevolution = 60 / MIDI_JOG_VINYL_RPM;
  return boundedJogTicks(delta) * (secondsPerRevolution / MIDI_JOG_TICKS_PER_REVOLUTION);
}

export function midiJogSeekSeconds(delta: number, duration: number): number {
  const span = Number.isFinite(duration) && duration > 0 ? duration : 180;
  return boundedJogTicks(delta) * (
    span / (MIDI_JOG_TICKS_PER_REVOLUTION * MIDI_JOG_QUICK_SEARCH_TURNS_PER_TRACK)
  );
}

/** 边缘转动给原生引擎的归一化、瞬态 pitch-bend 幅度。 */
export function midiJogNudgeAmount(delta: number): number {
  return boundedJogTicks(delta) / MAX_JOG_TICKS_PER_MESSAGE;
}

export function clampJogPosition(position: number, duration: number): number {
  const at = Number.isFinite(position) ? position : 0;
  // A streaming Deck can accept a seek before metadata has reported its final duration. Do not
  // turn that temporary `0` into an artificial end-of-track boundary: only a known duration may
  // cap forward/local platter travel. Audio time itself still never goes below the real 0:00.
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, at);
  return Math.min(duration, Math.max(0, at));
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
