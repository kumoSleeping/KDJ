/** 4/4 网格相位：自动对拍时的跳转落点、SYNC 校正和接歌等待都走这里。 */

export const BEATS_PER_BAR = 4;
/** 引擎保调变速的硬边界。SYNC 可以超出 TEMPO 推子量程，但不能超出这里。 */
export const ENGINE_TEMPO_MIN = 0.5;
export const ENGINE_TEMPO_MAX = 2;
const GRID_WAIT_FLOOR_MS = 80;

export function beatIntervalSec(bpm: number | null | undefined): number | null {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return null;
  const interval = 60 / bpm;
  return Number.isFinite(interval) && interval > 0 ? interval : null;
}

export function barIntervalSec(bpm: number | null | undefined): number | null {
  const beat = beatIntervalSec(bpm);
  return beat == null ? null : beat * BEATS_PER_BAR;
}

export function gridOriginSec(firstBeatSec: number, intervalSec: number): number {
  let origin = firstBeatSec % intervalSec;
  if (origin < 0) origin += intervalSec;
  return origin;
}

/** 当前播放头落在小节内的 0..1 相位；网格不可用时返回 null。 */
export function barPhase(
  positionSec: number,
  bpm: number | null | undefined,
  firstBeatSec: number | null | undefined,
): number | null {
  const bar = barIntervalSec(bpm);
  const beat = beatIntervalSec(bpm);
  if (bar == null || beat == null || firstBeatSec == null || !Number.isFinite(firstBeatSec)) {
    return null;
  }
  const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const origin = gridOriginSec(firstBeatSec, bar);
  const offset = position - origin;
  const wrapped = ((offset % bar) + bar) % bar;
  return wrapped / bar;
}

/**
 * Performance 台面上的手动 SYNC：把按下的那台 Deck 对齐到另一台的**有效** BPM。
 *
 * 先试半倍/原倍/双倍，取对数距离最近——140 对 70 会按半拍关系对齐而不是硬拉一倍速。
 * 手动同步是用户的明确指令，不做容差放弃。速率只按引擎 0.5–2.0 钳，不得按
 * TEMPO 推子量程钳：推子拇指可以钉在边界，读数必须是真实有效 BPM。
 * otherEffective = multiple × syncedEffective。
 */
export function deckSyncRate(
  otherEffectiveBpm: number | null,
  syncedBpm: number | null,
  minRate = ENGINE_TEMPO_MIN,
  maxRate = ENGINE_TEMPO_MAX,
): { rate: number; multiple: number } | null {
  if (!otherEffectiveBpm || !syncedBpm || otherEffectiveBpm <= 0 || syncedBpm <= 0) return null;
  let bestMultiple = 1;
  let bestRate = 1;
  let bestDistance = Infinity;
  for (const multiple of [0.5, 1, 2]) {
    const rate = otherEffectiveBpm / (syncedBpm * multiple);
    const distance = Math.abs(Math.log2(rate));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRate = rate;
      bestMultiple = multiple;
    }
  }
  return {
    rate: Math.min(maxRate, Math.max(minRate, bestRate)),
    multiple: bestMultiple,
  };
}

/**
 * 点击落点 = 被点小节内、与当前播放头相同的相位。
 * 例如现在在小节 1/3 处，点到另一小节就落到那一小节的 1/3 处。
 */
export function barPhaseAlignedSeek(
  clickPositionSec: number,
  phaseSourcePositionSec: number,
  bpm: number | null | undefined,
  firstBeatSec: number | null | undefined,
): number {
  const click = Number.isFinite(clickPositionSec) ? Math.max(0, clickPositionSec) : 0;
  const phase = barPhase(phaseSourcePositionSec, bpm, firstBeatSec);
  const bar = barIntervalSec(bpm);
  const beat = beatIntervalSec(bpm);
  if (phase == null || bar == null || beat == null || firstBeatSec == null) return click;
  const origin = gridOriginSec(firstBeatSec, bar);
  const rel = click - origin;
  const wrapped = ((rel % bar) + bar) % bar;
  return Math.max(0, click - wrapped + phase * bar);
}

/** 把误差折到 (-period/2, period/2]。 */
export function wrapSigned(value: number, period: number): number {
  if (!(period > 0) || !Number.isFinite(value)) return 0;
  let wrapped = value % period;
  if (wrapped <= -period / 2) wrapped += period;
  if (wrapped > period / 2) wrapped -= period;
  return wrapped;
}

export interface BarPhaseLockInput {
  followerPositionSec: number;
  /** Optional playable bound used to select an equivalent grid cell near track edges. */
  followerDurationSec?: number;
  followerBpm: number;
  followerFirstBeatSec: number;
  followerRate: number;
  masterPositionSec: number;
  masterBpm: number;
  masterFirstBeatSec: number;
  masterRate: number;
  multiple: number;
  /**
   * 锁网格的格子：1 = 对拍（灰线对齐），4 = 对小节（黄线对齐）。
   * 默认 4。半拍/双拍时对小节按较慢的那一小节收相位，避免落在从台第 3 拍上
   * 却声称已经锁住。
   */
  beatsPerCell?: number;
}

/**
 * The deck SYNC button is stronger than the automatic-transition preference: it always means
 * "put the yellow 4/4 lines together". Keeping this constructor outside React prevents a saved
 * auto-mix preference from quietly downgrading a manual SYNC press to beat-only alignment.
 */
export function manualSyncBarInput(
  input: Omit<BarPhaseLockInput, "beatsPerCell">,
): BarPhaseLockInput {
  return { ...input, beatsPerCell: BEATS_PER_BAR };
}

/**
 * TEMPO and seek use different native command lanes. A SYNC seek must not start its decoder or
 * STEM shadow until the new rate has actually reached the Deck, otherwise the prepared source is
 * anchored against the old clock and leaves a fixed phase offset after promotion.
 */
export async function applySyncRateBeforePhase(
  applyRate: () => boolean | Promise<boolean>,
  alignPhase: () => void,
): Promise<boolean> {
  if (!await applyRate()) return false;
  alignPhase();
  return true;
}

/** One bounded post-promotion check; never the old 100ms continuous rate feedback loop. */
export function syncPhaseConfirmationDelayMs(
  stemEnabled: boolean,
  p95BlockMs: number | null | undefined,
): number {
  if (!stemEnabled) return 350;
  const measured = Number.isFinite(p95BlockMs) ? Math.max(0, p95BlockMs ?? 0) : 0;
  // Two Decks may serialize two model calls even though diagnostics report worker time only.
  return Math.min(3_500, Math.max(900, measured * 2 + 500));
}

/**
 * 从台相对主台的墙钟网格相位误差（秒）。
 * `multiple` 与 `deckSyncRate` 一致：主台有效 BPM = multiple × 从台有效 BPM。
 */
export function barPhaseLock(input: BarPhaseLockInput): { errorSec: number; barSec: number } | null {
  const followerBeat = beatIntervalSec(input.followerBpm);
  const masterBeat = beatIntervalSec(input.masterBpm);
  const beatsPerCell = input.beatsPerCell != null && input.beatsPerCell > 0
    ? input.beatsPerCell
    : BEATS_PER_BAR;
  if (
    followerBeat == null
    || masterBeat == null
    || !(input.followerRate > 0)
    || !(input.masterRate > 0)
    || !(input.multiple > 0)
  ) {
    return null;
  }
  const followerCell = followerBeat * beatsPerCell;
  const masterCell = masterBeat * beatsPerCell;
  const followerWall = (input.followerPositionSec - gridOriginSec(input.followerFirstBeatSec, followerCell))
    / input.followerRate;
  const masterWall = (input.masterPositionSec - gridOriginSec(input.masterFirstBeatSec, masterCell))
    / input.masterRate;
  const followerCellWall = followerCell / input.followerRate;
  const masterCellWall = masterCell / input.masterRate;
  // 对拍：半拍/双拍时用较短的那一拍做周期，任意拍对任意拍即可。
  // 对小节：用较长的那一小节，黄线必须对上，不能把从台第 3 拍当成下拍。
  const barSec = beatsPerCell >= BEATS_PER_BAR
    ? Math.max(followerCellWall, masterCellWall)
    : Math.max(
      followerCellWall / Math.max(input.multiple, 1e-9),
      masterCellWall,
    );
  return {
    errorSec: wrapSigned(followerWall - masterWall, barSec),
    barSec,
  };
}

export function signedBarPhaseErrorSec(input: BarPhaseLockInput): number | null {
  return barPhaseLock(input)?.errorSec ?? null;
}

/** 把从台曲目位置挪到与主台同相位；误差是墙钟秒。 */
export function phaseAlignedFollowerPosition(
  followerPositionSec: number,
  followerRate: number,
  errorSec: number,
): number {
  if (!(followerRate > 0) || !Number.isFinite(errorSec)) {
    return Math.max(0, followerPositionSec);
  }
  return Math.max(0, followerPositionSec - errorSec * followerRate);
}

const SYNC_END_MARGIN_SEC = 0.25;

/**
 * Keep the nearest phase correction inside the seekable track range by moving an integer number
 * of common grid cells. Clamping a negative target to zero is not equivalent and was the main
 * reason a freshly loaded follower looked permanently offset after SYNC.
 */
export function boundedPhaseAlignedFollowerPosition(
  followerPositionSec: number,
  followerRate: number,
  errorSec: number,
  commonPeriodSec: number,
  durationSec?: number | null,
): number {
  let target = phaseAlignedFollowerPosition(followerPositionSec, followerRate, errorSec);
  const sourcePeriod = commonPeriodSec * followerRate;
  if (!(sourcePeriod > 0) || !Number.isFinite(sourcePeriod)) return target;
  // phaseAlignedFollowerPosition deliberately protects general callers from negatives, so recover
  // the signed raw target here before selecting an equivalent in-range cell.
  target = followerPositionSec - errorSec * followerRate;
  const maximum = durationSec != null && Number.isFinite(durationSec) && durationSec > 0
    ? Math.max(0, durationSec - SYNC_END_MARGIN_SEC)
    : Number.POSITIVE_INFINITY;
  if (target < 0) target += Math.ceil(-target / sourcePeriod) * sourcePeriod;
  if (target > maximum && Number.isFinite(maximum)) {
    target -= Math.ceil((target - maximum) / sourcePeriod) * sourcePeriod;
  }
  return clamp(target, 0, maximum);
}

/** 小于这个墙钟误差就不必再 seek：听感上已经锁住，解码器重启才是更贵的。 */
const PHASE_SEEK_MIN_ERROR_SEC = 0.012;
/** Final manual-SYNC acceptance tolerance; also used by bounded post-promotion confirmation. */
export const SYNC_PHASE_TOLERANCE_SEC = 0.003;
/**
 * Native Rubber Band R3 replacement is audible after the ~80ms startup cushion.
 * Align the follower to where the master will be when that cushion reaches the speaker.
 */
export const SYNC_SEEK_LEAD_SEC = 0.08;

/**
 * The native coordinator now owns the audible promotion clock for both decoded and STEM shadows.
 * Frontend lead would be counted a second time and become a permanent yellow-line offset.
 */
export function syncSeekLeadSeconds(_stemEnabled: boolean): number {
  return 0;
}

/** 对拍落点；相位已经够近时返回 null，避免无意义的流重建。 */
export function syncFollowerSeekPosition(
  input: BarPhaseLockInput,
  minErrorSec = PHASE_SEEK_MIN_ERROR_SEC,
): number | null {
  const lock = barPhaseLock(input);
  if (!lock || Math.abs(lock.errorSec) < minErrorSec) return null;
  return boundedPhaseAlignedFollowerPosition(
    input.followerPositionSec,
    input.followerRate,
    lock.errorSec,
    lock.barSec,
    input.followerDurationSec,
  );
}

export interface DeckSyncRelation {
  base: 0 | 1;
  multiple: number;
}

export interface CrossfaderTempoPlan {
  rates: [number, number];
  relation: DeckSyncRelation;
  /** Common beat-equivalent BPM after folding the left Deck by relation.multiple. */
  targetBpm: number;
}

/**
 * Two-Deck tempo plan driven by the crossfader position.
 *
 * The left original BPM (folded through the nearest half/double-time relation) anchors 0, the
 * right original BPM anchors 1, and the centre is their arithmetic mean. Both rates always map
 * to the same beat-equivalent target, so an already aligned bar phase stays aligned while the
 * fader moves. Return null rather than independently clamping either Deck: independent clamps
 * would silently break the BPM lock.
 */
export function crossfaderTempoPlan(
  ratio: number,
  bpms: readonly [number | null | undefined, number | null | undefined],
  minRate = ENGINE_TEMPO_MIN,
  maxRate = ENGINE_TEMPO_MAX,
): CrossfaderTempoPlan | null {
  const leftBpm = bpms[0];
  const rightBpm = bpms[1];
  if (
    leftBpm == null
    || rightBpm == null
    || !(leftBpm > 0)
    || !(rightBpm > 0)
    || !Number.isFinite(ratio)
  ) return null;
  const folded = deckSyncRate(rightBpm, leftBpm, minRate, maxRate);
  if (!folded) return null;
  const relation: DeckSyncRelation = { base: 0, multiple: folded.multiple };
  const leftAnchor = leftBpm * folded.multiple;
  const rightAnchor = rightBpm;
  const position = clamp(ratio, 0, 1);
  const targetBpm = leftAnchor + (rightAnchor - leftAnchor) * position;
  const rates: [number, number] = [
    targetBpm / leftAnchor,
    targetBpm / rightAnchor,
  ];
  if (rates.some((rate) => !Number.isFinite(rate) || rate < minRate || rate > maxRate)) {
    return null;
  }
  return { rates, relation, targetBpm };
}

/**
 * Exact two-Deck rates for a linked TEMPO gesture. The requested side is constrained by the
 * partner's engine range as well as its own, so clamping can never silently break the BPM lock.
 */
export function linkedDeckRates(
  side: 0 | 1,
  requestedRate: number,
  bpms: readonly [number | null | undefined, number | null | undefined],
  relation: DeckSyncRelation,
  minRate = ENGINE_TEMPO_MIN,
  maxRate = ENGINE_TEMPO_MAX,
): [number, number] | null {
  const other = (1 - side) as 0 | 1;
  const ownBpm = bpms[side];
  const otherBpm = bpms[other];
  if (
    ownBpm == null
    || otherBpm == null
    || !(ownBpm > 0)
    || !(otherBpm > 0)
    || !(relation.multiple > 0)
    || !Number.isFinite(requestedRate)
  ) return null;
  const factor = relation.base === side
    ? (ownBpm * relation.multiple) / otherBpm
    : ownBpm / (relation.multiple * otherBpm);
  if (!(factor > 0) || !Number.isFinite(factor)) return null;
  const ownMin = Math.max(minRate, minRate / factor);
  const ownMax = Math.min(maxRate, maxRate / factor);
  if (ownMin > ownMax) return null;
  const ownRate = clamp(requestedRate, ownMin, ownMax);
  const rates: [number, number] = [0, 0];
  rates[side] = ownRate;
  rates[other] = ownRate * factor;
  return rates;
}

/**
 * A native seek begins after its short decoded-audio cushion, not at the instant the WebView
 * sampled the two clocks. First decide whether the pair actually needs a correction, then align
 * the follower to the master position expected when that cushion reaches the speaker.
 */
export function syncFollowerSeekPositionWithLead(
  input: BarPhaseLockInput,
  masterLeadWallSec: number,
  minErrorSec = PHASE_SEEK_MIN_ERROR_SEC,
): number | null {
  if (syncFollowerSeekPosition(input, minErrorSec) === null) return null;
  const lead = Number.isFinite(masterLeadWallSec) ? Math.max(0, masterLeadWallSec) : 0;
  return syncFollowerSeekPosition(
    {
      ...input,
      masterPositionSec: input.masterPositionSec + lead * input.masterRate,
    },
    0,
  );
}

/**
 * 只在「这一台刚起播、对面在起播前就已经在走带」时对拍。
 * 已经在播的那台不能被 seek 打断；两台同时从暂停起转也不抢相位。
 */
export function shouldQuantizeSyncOnPlay(
  startedPlaying: boolean,
  wasStartedPlaying: boolean,
  wasOtherPlaying: boolean,
): boolean {
  return startedPlaying && !wasStartedPlaying && wasOtherPlaying;
}

export type GridSnapKind = "bar" | "half" | "quarter";

/** 整小节窗口更紧；1/2、1/4 的吸附区更大，方便贴到乐句分数位置。 */
const SNAP_WINDOWS: { kind: GridSnapKind; fraction: number; window: number }[] = [
  { kind: "bar", fraction: 0, window: 0.06 },
  { kind: "half", fraction: 0.5, window: 0.10 },
  { kind: "quarter", fraction: 0.25, window: 0.10 },
  { kind: "quarter", fraction: 0.75, window: 0.10 },
];

function snapWindowFor(kind: GridSnapKind): number {
  return kind === "bar" ? SNAP_WINDOWS[0].window : SNAP_WINDOWS[1].window;
}

export function nearestGridSnap(
  errorSec: number,
  barSec: number,
): { kind: GridSnapKind; snapErrorSec: number } | null {
  if (!(barSec > 0) || !Number.isFinite(errorSec)) return null;
  const phase = ((errorSec / barSec) % 1 + 1) % 1;
  const barDistance = Math.min(phase, 1 - phase);
  if (barDistance <= SNAP_WINDOWS[0].window) {
    return { kind: "bar", snapErrorSec: wrapSigned(phase, 1) * barSec };
  }
  let best: { kind: GridSnapKind; snapErrorSec: number; distance: number } | null = null;
  for (const candidate of SNAP_WINDOWS.slice(1)) {
    const distance = Math.min(
      Math.abs(phase - candidate.fraction),
      1 - Math.abs(phase - candidate.fraction),
    );
    if (distance > candidate.window) continue;
    if (best && distance >= best.distance) continue;
    best = {
      kind: candidate.kind,
      snapErrorSec: wrapSigned(phase - candidate.fraction, 1) * barSec,
      distance,
    };
  }
  return best ? { kind: best.kind, snapErrorSec: best.snapErrorSec } : null;
}

/** 正值 = 从台超前吸附点，调用方按 `position - snapErrorSec * rate` 回拉。 */
export function scratchSnapAdjustment(
  errorSec: number,
  barSec: number,
  hard: boolean,
): number {
  const snap = nearestGridSnap(errorSec, barSec);
  if (!snap) return 0;
  if (hard) return snap.snapErrorSec;
  const window = snapWindowFor(snap.kind);
  const distance = Math.abs(snap.snapErrorSec) / barSec;
  const tightness = 1 - Math.min(1, distance / window);
  return snap.snapErrorSec * (0.28 + 0.62 * tightness);
}

export function scratchSnappedPosition(
  input: BarPhaseLockInput & { hard: boolean },
): number {
  const lock = barPhaseLock(input);
  if (!lock) return Math.max(0, input.followerPositionSec);
  const pull = scratchSnapAdjustment(lock.errorSec, lock.barSec, input.hard);
  return phaseAlignedFollowerPosition(input.followerPositionSec, input.followerRate, pull);
}

/**
 * 用平滑微变速关掉相位误差。正误差 = 从台超前，需要略减速。
 * 幅度钳在 maxNudge，避免爆音或音量突变。
 */
export function phaseNudgeRate(
  errorSec: number,
  baseRate: number,
  options: { maxNudge?: number; catchUpSec?: number; deadzoneSec?: number } = {},
): number {
  const maxNudge = options.maxNudge ?? 0.06;
  const catchUpSec = options.catchUpSec ?? 0.55;
  const deadzoneSec = options.deadzoneSec ?? 0.004;
  if (!(baseRate > 0) || !Number.isFinite(errorSec)) return baseRate;
  if (Math.abs(errorSec) <= deadzoneSec) return baseRate;
  const offset = clamp(-errorSec / catchUpSec, -maxNudge, maxNudge);
  return clamp(baseRate * (1 + offset), 0.5, 2);
}

export function scratchVelocityRate(deltaTrackSec: number, deltaWallSec: number): number {
  if (!(deltaWallSec > 0.004) || !Number.isFinite(deltaTrackSec)) return 0;
  const rate = deltaTrackSec / deltaWallSec;
  if (!Number.isFinite(rate)) return 0;
  return clamp(rate, -16, 16);
}

/** 等到下一个拍/小节边界的毫秒数。离边界太近时再等一整格，避免调度落在拍后。 */
export function msUntilNextBoundary(
  positionSec: number,
  bpm: number | null | undefined,
  firstBeatSec: number | null | undefined,
  playbackRate: number,
  beatsPerBoundary: number,
): number | null {
  const beat = beatIntervalSec(bpm);
  if (
    beat == null
    || firstBeatSec == null
    || !Number.isFinite(firstBeatSec)
    || !(playbackRate > 0)
    || !(beatsPerBoundary > 0)
  ) {
    return null;
  }
  const interval = beat * beatsPerBoundary;
  const origin = gridOriginSec(firstBeatSec, interval);
  const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const phase = ((position - origin) % interval + interval) % interval;
  let until = (interval - phase) % interval;
  let waitMs = (until / playbackRate) * 1000;
  if (waitMs < GRID_WAIT_FLOOR_MS) {
    until += interval;
    waitMs = (until / playbackRate) * 1000;
  }
  return waitMs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
