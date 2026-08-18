/**
 * DJ 接歌：双 deck + Web Audio 的过渡引擎。
 *
 * 平时播放器只有一个 <audio>，换歌是硬切。开了 DJ 预设之后，换歌变成
 * 「两台唱机同时转」：下一首在暗处起播（BPM 拉到和当前一致），两边按预设的
 * 自动化曲线交接（交叉渐变 / 低频交棒 / 共振滤波扫频 / 人声消除）。接入后
 * 保持本场 master tempo，后续曲目继续向它同步，避免在满幅播放中重配保调变速器。
 *
 * 结构上引擎**拥有**两个 audio 元素（PlayerBar 不再自己渲染 <audio>）：
 * 交叉渐变要求两个元素同时出声，而「接完之后谁是正主」必须能互换——
 * 元素在 React 里渲染的话，换正主就得换 src，中间必有一声可闻的断口。
 * 引擎里只换角色不换元素，接缝是数学上连续的。
 *
 * Web Audio 的接法有两个前置条件，都已在别处成立：
 * 1. createMediaElementSource 跨域要 CORS —— 服务端 CorsLayer::allow_origin(Any)；
 * 2. 元素必须在设 src 前带 crossOrigin="anonymous"，否则输出全零（静音）。
 *    token 走 query（见 api.audioUrl），不依赖请求头，anonymous 拿得到流。
 */

import { create } from "zustand";
import {
  audioContextOptionsForPlatform,
  effectOutputRoute,
  setEffectOutputActive,
  type OptionalEffectOutputRoutes,
} from "./djAudioPolicy";
import {
  canReusePreparedBrowserDeck,
  ANDROID_EXTERNAL_OUTPUT_LATENCY_FLOOR_S,
  EXTERNAL_HANDOFF_OVERLAP_GAIN,
  externalClockAligned,
  externalHandoffGain,
  externalHandoffPhysicalDelayMs,
  externalNativeReleaseSettleMs,
  needsPreparedCueSeek,
  ownsExternalAdoption,
  projectedExternalPosition,
  shouldPreservePreparedBackDeck,
  shouldRecalibrateExternalClock,
  type PreparedBrowserDeck,
  type ExternalAdoptionKey,
} from "./browserDeckPreload";
import { mediaUrlForTrack } from "./streamTrack";
import { BEATS_PER_BAR as GRID_BEATS_PER_BAR, msUntilNextBoundary } from "./beatGridSync";
import type { FilterResonance, Track } from "../types";

/* ---------------------------------------------------------------- 配置 */

export type DjTransition = "cross" | "eq" | "filter";
export type DjEffect = "alarm" | "hydrant" | "echo";

export const DJ_TRANSITIONS: { id: DjTransition; label: string; hint: string }[] = [
  { id: "cross", label: "交叉渐变", hint: "等功率淡入淡出，最朴素也最不会出错" },
  { id: "eq", label: "低频交接", hint: "新歌先没低音，中点两边低频交棒——两首歌的鼓不打架" },
  { id: "filter", label: "共振滤波", hint: "旧歌收进低通扫频，新歌从高通里放出来，气氛型" },
];

export const DJ_EFFECTS: { id: DjEffect; label: string; hint: string }[] = [
  { id: "alarm", label: "Alarm", hint: "警报式共振扫频，越接近交棒越紧张" },
  { id: "hydrant", label: "Hydrant", hint: "循环逐拍缩短，叠加滤波与空间尾音，制造喷射式上升" },
  { id: "echo", label: "Echo", hint: "按节拍重复旧歌尾音，干声退场时回声继续收尾" },
];

/** 接歌长度的可选小节数（按 4/4 拍换算成秒）。 */
export const DJ_BARS_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const STORAGE_KEY = "kd-dj-config";
/** v1 只存预设的旧键。读到就迁移（含 "vocal" 预设 → cross + 人声剔除开）。 */
const LEGACY_KEY = "kd-dj-preset";

const isTransition = (value: unknown): value is DjTransition =>
  typeof value === "string" && DJ_TRANSITIONS.some((item) => item.id === value);
const isEffect = (value: unknown): value is DjEffect =>
  typeof value === "string" && DJ_EFFECTS.some((item) => item.id === value);
const pickIds = <T extends string>(value: unknown, valid: (item: unknown) => item is T): T[] =>
  Array.isArray(value) ? [...new Set(value.filter(valid))] : [];

interface DjConfig {
  enabled: boolean;
  /** 每场接歌从勾选项中随机取至少一个；多个处理可以叠加。 */
  transitions: DjTransition[];
  /** 接歌起手时拍一份快照，本场内不因面板继续点击而跳变。 */
  effects: DjEffect[];
  /** 接歌用几小节完成（4/4 拍）。 */
  bars: number;
  /** 接歌期间渐进剔除上一首的人声（中置声道消除），任何方案都能叠加。 */
  vocalCut: boolean;
  /**
   * 自动接播 / 自动续播时应用曲目的开始点与结束点：
   * 开 → 从 cue 起播、到 end 切下一首；关 → 首拍起播、波形尾段切歌。
   */
  applyInOutPoints: boolean;
  /**
   * 自动对拍：波形跳转保持小节相位；SYNC 锁小节（黄线对齐）；接歌等到下一小节边界。
   * 关掉后点击跳转仍是精确落点，SYNC 只锁拍子（灰线对齐）。
   */
  autoBeatSync: boolean;
  /**
   * DJ 双盘装入曲目后立即从首拍起播。关掉则只装盘、停在首拍。
   */
  playOnLoad: boolean;
}

const DEFAULT_CONFIG: DjConfig = {
  enabled: true,
  transitions: ["filter"],
  effects: ["echo"],
  bars: 1,
  vocalCut: true,
  applyInOutPoints: true,
  autoBeatSync: true,
  playOnLoad: true,
};

function loadDjConfig(): DjConfig {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const {
        enabled,
        transitions,
        effects,
        preset,
        bars,
        vocalCut,
        applyInOutPoints,
        autoBeatSync,
        playOnLoad,
      } = raw as Record<string, unknown>;
      const pickNumber = (value: unknown, allowed: readonly number[], fallback: number) =>
        allowed.includes(value as number) ? (value as number) : fallback;
      const selected = pickIds(transitions, isTransition);
      const legacyTransition = isTransition(preset) ? preset : null;
      return {
        enabled: typeof enabled === "boolean" ? enabled : preset !== "off",
        transitions: selected.length ? selected : legacyTransition ? [legacyTransition] : ["cross"],
        effects: pickIds(effects, isEffect),
        bars: pickNumber(bars, DJ_BARS_OPTIONS, DEFAULT_CONFIG.bars),
        vocalCut: vocalCut === true,
        // 缺字段按开：旧配置没有这项时保持「cue 起播」的既有行为。
        applyInOutPoints: applyInOutPoints !== false,
        autoBeatSync: autoBeatSync !== false,
        playOnLoad: playOnLoad !== false,
      };
    }
    // 旧版只存了预设名。"vocal" 已从预设降级成独立开关，语义原样迁过来
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy === "vocal") return { ...DEFAULT_CONFIG, enabled: true, vocalCut: true };
    if (legacy === "off") return { ...DEFAULT_CONFIG };
    if (isTransition(legacy)) return { ...DEFAULT_CONFIG, enabled: true, transitions: [legacy] };
  } catch {
    /* 存档坏了用默认，不值得报错 */
  }
  return { ...DEFAULT_CONFIG };
}

interface DjConfigState extends DjConfig {
  toggleEnabled(): void;
  toggleTransition(transition: DjTransition): void;
  toggleEffect(effect: DjEffect): void;
  setBars(bars: number): void;
  setVocalCut(value: boolean): void;
  setApplyInOutPoints(value: boolean): void;
  setAutoBeatSync(value: boolean): void;
  setPlayOnLoad(value: boolean): void;
}

function saveDjConfig(state: DjConfig): void {
  const { enabled, transitions, effects, bars, vocalCut, applyInOutPoints, autoBeatSync, playOnLoad } =
    state;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      enabled,
      transitions,
      effects,
      bars,
      vocalCut,
      applyInOutPoints,
      autoBeatSync,
      playOnLoad,
    }),
  );
}

export const useDjConfig = create<DjConfigState>((set, get) => ({
  ...loadDjConfig(),
  toggleEnabled() {
    const enabled = !get().enabled;
    set({ enabled });
    saveDjConfig(get());
    if (enabled && !window.__TAURI_INTERNALS__) djEngine.prime();
    else if (!enabled) djEngine.cancel();
  },
  toggleTransition(transition) {
    const current = get().transitions;
    const transitions = current.includes(transition)
      ? current.filter((item) => item !== transition)
      : [...current, transition];
    // 至少保留一种，否则“开启”却完全没有接歌方案，按钮状态会说谎。
    if (!transitions.length) return;
    set({ transitions });
    saveDjConfig(get());
  },
  toggleEffect(effect) {
    const current = get().effects;
    const effects = current.includes(effect)
      ? current.filter((item) => item !== effect)
      : [...current, effect];
    set({ effects });
    saveDjConfig(get());
  },
  setBars(bars) {
    if (!(DJ_BARS_OPTIONS as readonly number[]).includes(bars)) return;
    set({ bars });
    saveDjConfig(get());
  },
  setVocalCut(vocalCut) {
    set({ vocalCut });
    saveDjConfig(get());
  },
  setApplyInOutPoints(applyInOutPoints) {
    set({ applyInOutPoints });
    saveDjConfig(get());
  },
  setAutoBeatSync(autoBeatSync) {
    set({ autoBeatSync });
    saveDjConfig(get());
  },
  setPlayOnLoad(playOnLoad) {
    set({ playOnLoad });
    saveDjConfig(get());
  },
}));

/* ---------------------------------------------------------------- 参数 */

/** 拍号按 4/4 算：这个曲库的主体是电子/流行，几乎全是四四拍。 */
const BEATS_PER_BAR = 4;
/** 没分析出 BPM 时按 120 折算小节长度——流行/电子的中位速度。 */
const FALLBACK_BPM = 120;
/** 交接时长的硬边界（秒）：慢歌 32 小节能超过一分钟，不设顶就荒唐了。 */
const MIX_MIN_S = 2;
const MIX_MAX_S = 60;
/** 两边 BPM 差出这个倍率就放弃同步：拉伸 25% 以上人耳听着已经是变了一首歌。 */
const SYNC_MAX_RATIO = 1.25;
/**
 * 自动化结束后多留几个音频渲染量子再 pause 旧 deck。
 *
 * Gain 曲线走 AudioContext 的高精度时钟，收尾却只能靠主线程 setTimeout。两只钟
 * 存在几毫秒偏差时，timer 可能在 gain 真正到 0 之前先 pause，非零采样被硬截断
 * 就是一声很短的“哒”。80ms 不延长可闻过渡——曲线早已到 0——只让静音尾巴
 * 安全落稳。
 */
const AUDIO_TAIL_SETTLE_MS = 80;
/** 自动化曲线的采样点数。64 点对几秒到十几秒的曲线足够平滑。 */
const CURVE_N = 64;
/** 反馈总是严格低于 0.4；效果链再异常也不允许接近自激。 */
const ECHO_FEEDBACK_MAX = 0.34;
const HYDRANT_FEEDBACK_MAX = 0.3;
/** 共振 Q 的安全上限。高于 3 在满电平母带上很容易形成刺耳窄峰。 */
const RESONANCE_Q_MAX = 2.4;
/** Web Audio 的低档严格保留此前固定的 0.7；其余档位在安全上限内逐级提高。 */
const FILTER_RESONANCE_Q: Record<FilterResonance, number> = {
  low: 0.7,
  medium: 1.4,
  high: RESONANCE_Q_MAX,
};
let channelFilterResonanceQ = FILTER_RESONANCE_Q.high;

function filterResonanceQ(resonance: FilterResonance): number {
  return FILTER_RESONANCE_Q[resonance] ?? FILTER_RESONANCE_Q.high;
}

/** 接歌用的秒数 = 小节数 × 每小节时长（按出让方的 BPM）。 */
export function mixSeconds(bpm: number | null | undefined, bars: number): number {
  const beats = bars * BEATS_PER_BAR;
  const tempo = bpm && bpm > 0 ? bpm : FALLBACK_BPM;
  return Math.min(MIX_MAX_S, Math.max(MIX_MIN_S, (60 / tempo) * beats));
}

/**
 * 新歌该用什么速率起播，才能和旧歌合拍。
 *
 * 先试半倍/原倍/双倍三种解读——140 的 Drum&Bass 接 70 的 Hip-Hop 是半拍关系，
 * 不试倍率的话会被硬拉一倍速。取对数距离最近的那档，仍超出容差就放弃（返回 1）：
 * 强行同步一首差太远的歌，比不同步更破坏气氛。
 */
export function bpmSyncRate(fromBpm: number | null, toBpm: number | null): number {
  if (!fromBpm || !toBpm || fromBpm <= 0 || toBpm <= 0) return 1;
  let best = 1;
  let bestDistance = Infinity;
  for (const multiple of [0.5, 1, 2]) {
    const rate = fromBpm / (toBpm * multiple);
    const distance = Math.abs(Math.log2(rate));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = rate;
    }
  }
  return best > SYNC_MAX_RATIO || best < 1 / SYNC_MAX_RATIO ? 1 : best;
}

export { deckSyncRate } from "./beatGridSync";

/**
 * 只有 iOS 仍由插件内 AVPlayer 独占输出。Android 的本地文件虽由共享 Rust
 * coordinator 出声，但在线试听会明确切到本模块的 WebAudio 双 Deck；不能只因
 * UA 是 Android 就拒绝 warmup，否则流媒体接歌永远退化为失败/硬切。
 */
function nativeMobilePlaybackOwnsOutput(): boolean {
  return window.kdj?.platform === "ios";
}

/** preservesPitch 还没进所有 TS lib 的 HTMLMediaElement，包一层。 */
function setPreservesPitch(el: HTMLAudioElement, value: boolean): void {
  const media = el as HTMLAudioElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  media.preservesPitch = value;
  media.webkitPreservesPitch = value;
}

/* --------------------------------------------- 暂停/播放：唱盘启转 / 刹停 */

/**
 * 当前 deck 是流式 HTMLMediaElement。WebKit 连续改 playbackRate 会反复重建
 * 媒体变速器，实际听感是卡顿和重新接通时的 click，而不是连续的唱盘变速。
 *
 * 因此这里采用流式 deck 的稳定方案：音乐只走音频时钟上的推子曲线，再叠一层
 * 很轻的合成电机启转／刹停声。所有频率和增益都由 AudioParam 自动化，不在
 * 主线程逐帧改解码器，也不改变原曲频谱。
 */
// 走带键必须接近即时响应；只留足以消除波形硬切 click 的短包络。
// 60ms 低于明显可感知的操作等待，同时仍覆盖多个音频渲染量子。
const TRANSPORT_START_SEC = 0.06;
const TRANSPORT_STOP_SEC = 0.06;
const TRANSPORT_CURVE_N = 64;
/** 曲线归零后留两个左右的音频渲染量子，再 pause，避免非零采样被硬截断。 */
const TRANSPORT_SETTLE_MS = 24;
/**
 * seek 交接只覆盖一次波形不连续所需的几个渲染量子。它不是用户可感知的淡入淡出：
 * 旧 deck 在目标位置解码完成前保持满幅，随后两台在 12ms 内等功率换手，既没有
 * 静音洞，也不会把两个任意相位的采样硬拼成 click。
 */
const SEEK_HANDOFF_SEC = 0.012;
const SEEK_HANDOFF_LEAD_SEC = 0.006;
/** 跨 Rust/WebAudio owner 只做两段各 6ms 的有界接力，避免长时间双路同源叠加。 */
const EXTERNAL_HANDOFF_STAGE_SEC = 0.006;
const EXTERNAL_HANDOFF_SETTLE_MS = 4;
/** Effect paths get a short zero-slope release before their graph edge is disconnected. */
const EFFECT_STOP_FADE_SEC = 0.008;
const EFFECT_STOP_SETTLE_MS = 12;
const SEEK_READY_TIMEOUT_MS = 1200;
const SEEK_SETTLE_MS = 32;
const SEEK_CURVE_N = 32;
/** 当前曲目最多保留约 256MiB Float32 PCM；长 DJ set 超限就回退流式 shadow seek。 */
const MAX_DECODED_PCM_BYTES = 256 * 1024 * 1024;
/** PCM 已在内存，点击后只预留一个渲染量子并做 6ms 防 click 换源。 */
const PCM_SEEK_LEAD_SEC = 0.004;
const PCM_SEEK_HANDOFF_SEC = 0.006;
const PCM_TICK_MS = 50;

let transportGen = 0;
let transportTimer: number | null = null;
let transportResolve: ((active: boolean) => void) | null = null;
let stopTransportSound: (() => void) | null = null;

function abortTransport(): void {
  transportGen += 1;
  if (transportTimer !== null) {
    window.clearTimeout(transportTimer);
    transportTimer = null;
  }
  stopTransportSound?.();
  stopTransportSound = null;
  // 清 timer 不能把等待它的 Promise 永久悬空。快速连点播放/暂停时旧操作必须
  // 立刻结束，否则会不断积累未完成的 softPause 调用。
  transportResolve?.(false);
  transportResolve = null;
}

function frontDeckOrNull(): Deck | null {
  return decks ? decks[frontIndex] : null;
}

/** 硬切/普通起播前：保证正主链路可听（上次软停可能把 fader 留在 0）。 */
function restoreFrontOutput(): void {
  if (!ctx || !decks) return;
  neutralize(ctx, decks[frontIndex], 1);
}

function waitTransport(ms: number, gen: number): Promise<boolean> {
  return new Promise((resolve) => {
    transportResolve = resolve;
    transportTimer = window.setTimeout(() => {
      transportTimer = null;
      transportResolve = null;
      resolve(gen === transportGen);
    }, ms);
  });
}

/** 五次 S 曲线：两端速度、加速度都为 0，尤其适合听感敏感的启停末端。 */
function smootherstep(progress: number): number {
  const value = Math.min(1, Math.max(0, progress));
  return value * value * value * (value * (value * 6 - 15) + 10);
}

/** 保留自动化此刻的实际值，快速反向操作时不让增益突然跳到旧端点。 */
function holdParam(param: AudioParam, now: number): number {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(now);
  } else {
    const value = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  }
  return param.value;
}

function transportFadeOutLevel(progress: number): number {
  // 前 32% 只轻微 duck；剩余 68% 用五次 S 曲线贴地。末端斜率为 0，
  // 不会像 cos 曲线那样到零点时仍带着速度，听起来仿佛突然被截断。
  if (progress <= 0.32) {
    return 1 - 0.12 * smootherstep(progress / 0.32);
  }
  const fade = (progress - 0.32) / 0.68;
  return 0.88 * (1 - smootherstep(fade));
}

function transportGainCurve(from: number, direction: "out" | "in"): Float32Array {
  const out = new Float32Array(TRANSPORT_CURVE_N);
  for (let index = 0; index < TRANSPORT_CURVE_N; index += 1) {
    const progress = index / (TRANSPORT_CURVE_N - 1);
    if (direction === "out") {
      // 保留原有淡出听感，不改变已经稳定的刹停包络。
      out[index] = from * transportFadeOutLevel(progress);
    } else {
      // 淡入必须是淡出的时间反向。旧实现使用线性增益，和淡出的 S 形节奏不匹配，
      // 听起来会像另一套动作；反向复用同一包络也能保证两端平滑落速。
      out[index] = from + (1 - from) * transportFadeOutLevel(1 - progress);
    }
  }
  return out;
}

function scheduleTransport(
  deck: Deck,
  direction: "out" | "in",
  seconds: number,
): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  const heldGain = Math.min(1, Math.max(0, holdParam(deck.fader.gain, now)));
  // 如果在 DJ 接歌中途按暂停，先取消仍在运行的 EQ/filter/effect 自动化，恢复
  // 全频中性链路；只保留当前推子电平，避免暂停后再播放仍带着半截滤波。
  neutralize(ctx, deck, heldGain);
  deck.fader.gain.setValueCurveAtTime(
    transportGainCurve(heldGain, direction),
    now,
    seconds,
  );
}

function motorEnvelopeCurve(direction: "out" | "in"): Float32Array {
  const out = new Float32Array(TRANSPORT_CURVE_N);
  const attackEnd = direction === "in" ? 0.14 : 0.09;
  const fadeStart = direction === "in" ? 0.5 : 0.42;
  const peak = 0.14;
  const sustain = direction === "in" ? 0.08 : 0.095;
  for (let index = 0; index < TRANSPORT_CURVE_N; index += 1) {
    const progress = index / (TRANSPORT_CURVE_N - 1);
    if (progress <= attackEnd) {
      out[index] = peak * smootherstep(progress / attackEnd);
    } else if (progress <= fadeStart) {
      const settle = (progress - attackEnd) / (fadeStart - attackEnd);
      out[index] = peak + (sustain - peak) * smootherstep(settle);
    } else {
      const fade = (progress - fadeStart) / (1 - fadeStart);
      out[index] = sustain * (1 - smootherstep(fade));
    }
  }
  return out;
}

/**
 * 合成一声很轻的 platter motor：锯齿基音提供机械谐波，正弦二次谐波让小扬声器
 * 也听得见；低通去掉刺耳高频。节点只活几百毫秒，曲线全交给音频线程。
 */
function playTransportSound(deck: Deck, direction: "out" | "in", seconds: number): void {
  if (!ctx) return;
  stopTransportSound?.();

  const now = ctx.currentTime;
  const fundamental = ctx.createOscillator();
  const harmonic = ctx.createOscillator();
  const fundamentalGain = ctx.createGain();
  const harmonicGain = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  const motorGain = ctx.createGain();

  fundamental.type = "sawtooth";
  harmonic.type = "sine";
  tone.type = "lowpass";
  // 共振只作用在合成 motor 层，不碰原曲。Q=2.4 是温和隆起，远低于旧算法
  // 直接扫原曲时刺耳的 Q=11；截止频率跟着启转／刹停方向缓慢移动。
  const toneFromHz = direction === "in" ? 260 : 440;
  const toneToHz = direction === "in" ? 440 : 220;
  tone.frequency.setValueAtTime(toneFromHz, now);
  tone.frequency.exponentialRampToValueAtTime(toneToHz, now + seconds);
  tone.Q.setValueAtTime(1.6, now);
  tone.Q.linearRampToValueAtTime(2.4, now + seconds * 0.62);
  tone.Q.linearRampToValueAtTime(1.2, now + seconds);
  fundamentalGain.gain.setValueAtTime(0.72, now);
  harmonicGain.gain.setValueAtTime(0.28, now);
  motorGain.gain.setValueAtTime(0, now);

  // 纯 40–80Hz 在笔记本扬声器上几乎听不见；把基音抬到仍有“电机感”但能可靠
  // 还原的 62–118Hz，二次谐波落在 124–236Hz。
  const fromHz = direction === "in" ? 62 : 118;
  const toHz = direction === "in" ? 118 : 45;
  fundamental.frequency.setValueAtTime(fromHz, now);
  fundamental.frequency.exponentialRampToValueAtTime(toHz, now + seconds);
  harmonic.frequency.setValueAtTime(fromHz * 2, now);
  harmonic.frequency.exponentialRampToValueAtTime(toHz * 2, now + seconds);

  // 包络首尾及其斜率都精确归零；oscillator 在静音后才 stop，不会留下截断感。
  motorGain.gain.setValueCurveAtTime(motorEnvelopeCurve(direction), now, seconds);

  fundamental.connect(fundamentalGain);
  harmonic.connect(harmonicGain);
  fundamentalGain.connect(tone);
  harmonicGain.connect(tone);
  tone.connect(motorGain);
  motorGain.connect(deck.fxLimiter);

  fundamental.start(now);
  harmonic.start(now);
  fundamental.stop(now + seconds + TRANSPORT_SETTLE_MS / 1000);
  harmonic.stop(now + seconds + TRANSPORT_SETTLE_MS / 1000);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fundamental.disconnect();
    harmonic.disconnect();
    fundamentalGain.disconnect();
    harmonicGain.disconnect();
    tone.disconnect();
    motorGain.disconnect();
    if (stopTransportSound === stop) stopTransportSound = null;
  };
  const stop = () => {
    if (cleaned) return;
    const stopAt = ctx!.currentTime + 0.015;
    const gain = holdParam(motorGain.gain, ctx!.currentTime);
    motorGain.gain.setValueAtTime(Math.max(0.0001, gain), ctx!.currentTime);
    motorGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    try {
      fundamental.stop(stopAt);
      harmonic.stop(stopAt);
    } catch {
      cleanup();
    }
    if (stopTransportSound === stop) stopTransportSound = null;
  };
  fundamental.onended = cleanup;
  stopTransportSound = stop;
}

/* ------------------------------------------------------- 自动化曲线工具 */

/** 等功率淡出：cos 曲线。两条 cos/sin 相加恒为 1 的功率，中点不塌音量。 */
function fadeOutCurve(): Float32Array {
  const out = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) out[i] = Math.cos(((i / (CURVE_N - 1)) * Math.PI) / 2);
  return out;
}

function fadeInCurve(): Float32Array {
  const out = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) out[i] = Math.sin(((i / (CURVE_N - 1)) * Math.PI) / 2);
  return out;
}

/**
 * 折线曲线：stops 是 [进度 0..1, 值] 的拐点表，中间线性插值。
 * EQ 交棒那种「憋到中点突然让位」的形状用 setValueCurveAtTime 一次交给引擎，
 * 比自己攒一串 setTimeout 稳——curve 由音频线程走表，主线程卡了也不跑偏。
 */
function piecewise(stops: [number, number][]): Float32Array {
  const out = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) {
    const t = i / (CURVE_N - 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        a = stops[s];
        b = stops[s + 1];
        break;
      }
    }
    out[i] = b[0] === a[0] ? b[1] : a[1] + ((t - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  }
  return out;
}

/* ---------------------------------------------------------------- deck */

/**
 * 一台 deck 的处理链：
 *
 *   source ─┬─ dry ───────────────┐
 *           └─ 立体声 Side(L−R) ─┴→ 补偿 → EQ / filter → fader → 出口
 *
 * 不再把 dry 完全拉到 0：纯 L−R 会把居中的底鼓、贝斯和整体响度一起抽空。
 * 这里只做部分中置削弱，并保留真正的左右 Side 声场，再补少量 makeup gain。
 *
 * 所有节点常驻中性值（shelf 0dB、低通 20kHz、高通 10Hz、fader 1），
 * 不接歌的时候整条链在听感上就是根直导线。
 */
interface Deck {
  el: HTMLAudioElement;
  /** HTMLMedia 与采样级 PCM 播放共用的同一条逻辑 Deck 入口。 */
  input: GainNode;
  /** 只控制流式媒体源；PCM seek 启动后把它关掉，不动整台 Deck 的 fader。 */
  mediaGain: GainNode;
  /** 在线流的渐进波形只采当前已解码输出，不触发第二次整轨下载。 */
  analyser: AnalyserNode;
  waveformTimeData: Uint8Array<ArrayBuffer>;
  waveformFrequencyData: Float32Array<ArrayBuffer>;
  dry: GainNode;
  wet: GainNode;
  vocalMakeup: GainNode;
  low: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  highpass: BiquadFilterNode;
  fader: GainNode;
  /** 协同播放音量必须包住 HTMLMedia 和 PCM 两种源。 */
  volume: GainNode;
  echoDelay: DelayNode;
  echoFeedback: GainNode;
  echoWet: GainNode;
  hydrantDelay: DelayNode;
  hydrantFeedback: GainNode;
  hydrantFilter: BiquadFilterNode;
  hydrantWet: GainNode;
  /** Last audible edges of expensive effects; disconnected while the effects are idle. */
  effectOutputs: OptionalEffectOutputRoutes<DynamicsCompressorNode>;
  /** Makes delayed effect-edge cleanup harmless when a new transition starts immediately. */
  effectStopGeneration: number;
  effectStopTimer: number | null;
  fxLimiter: DynamicsCompressorNode;
}

function reverbImpulse(ctx: AudioContext, seconds = 1.8): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const decay = Math.pow(1 - index / length, 2.5);
      data[index] = (Math.random() * 2 - 1) * decay;
    }
  }
  return buffer;
}

let sharedReverbImpulse: AudioBuffer | null = null;

function createElement(): HTMLAudioElement {
  const el = document.createElement("audio");
  // 后台 deck 要在淡入前真正备好解码数据。metadata 只保证能读时长，canplay
  // 随后再 seek 到 cue 时仍可能重新断粮，听起来就是进场第一拍前卡几十毫秒。
  el.preload = "auto";
  // 必须在任何 src 赋值之前定死：中途改 crossOrigin 不影响已加载的资源，
  // 而没有它 MediaElementSource 只会输出静音（见文件头）
  el.crossOrigin = "anonymous";
  setPreservesPitch(el, true); // 变速不变调：BPM 同步是拉速度，不是拉音高
  return el;
}

function buildDeck(ctx: AudioContext, el: HTMLAudioElement): Deck {
  const source = ctx.createMediaElementSource(el);
  const mediaGain = ctx.createGain();
  mediaGain.gain.value = 1;
  const input = ctx.createGain();
  input.gain.value = 1;
  source.connect(mediaGain);
  mediaGain.connect(input);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.72;
  input.connect(analyser);

  const dry = ctx.createGain();
  dry.gain.value = 1;

  // Side 支路保留为真正的立体声：左输出=(L-R)/2，右输出=(R-L)/2。
  // 旧实现把 L-R 合成单声道再铺回两边，既塌声场又让切换听起来像突然盖住音箱。
  const splitter = ctx.createChannelSplitter(2);
  const sideLeftL = ctx.createGain();
  const sideLeftR = ctx.createGain();
  const sideRightR = ctx.createGain();
  const sideRightL = ctx.createGain();
  sideLeftL.gain.value = 0.5;
  sideLeftR.gain.value = -0.5;
  sideRightR.gain.value = 0.5;
  sideRightL.gain.value = -0.5;
  const sideMerger = ctx.createChannelMerger(2);
  const wet = ctx.createGain();
  wet.gain.value = 0;
  input.connect(splitter);
  splitter.connect(sideLeftL, 0);
  splitter.connect(sideLeftR, 1);
  splitter.connect(sideRightR, 1);
  splitter.connect(sideRightL, 0);
  sideLeftL.connect(sideMerger, 0, 0);
  sideLeftR.connect(sideMerger, 0, 0);
  sideRightR.connect(sideMerger, 0, 1);
  sideRightL.connect(sideMerger, 0, 1);
  sideMerger.connect(wet);

  const vocalMakeup = ctx.createGain();
  vocalMakeup.gain.value = 1;

  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 220; // DJ 调音台低频旋钮的经典分频点附近
  low.gain.value = 0;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 20000;
  lowpass.Q.value = channelFilterResonanceQ;

  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 10;
  highpass.Q.value = channelFilterResonanceQ;

  const fader = ctx.createGain();
  fader.gain.value = 1;
  const volume = ctx.createGain();
  volume.gain.value = 1;

  input.connect(dry);
  dry.connect(vocalMakeup);
  wet.connect(vocalMakeup);
  vocalMakeup.connect(low);
  low.connect(lowpass);
  lowpass.connect(highpass);
  highpass.connect(fader);
  fader.connect(volume);
  volume.connect(ctx.destination);

  const fxLimiter = ctx.createDynamicsCompressor();
  fxLimiter.threshold.value = -12;
  fxLimiter.knee.value = 4;
  fxLimiter.ratio.value = 16;
  fxLimiter.attack.value = 0.002;
  fxLimiter.release.value = 0.16;

  const echoDelay = ctx.createDelay(2);
  const echoFeedback = ctx.createGain();
  const echoWet = ctx.createGain();
  echoDelay.delayTime.value = 0.25;
  echoFeedback.gain.value = 0.25;
  echoWet.gain.value = 0;
  highpass.connect(echoDelay);
  echoDelay.connect(echoFeedback);
  echoFeedback.connect(echoDelay);
  echoDelay.connect(echoWet);
  // Deliberately do not connect echoWet to the limiter here. Gain=0 is not a CPU boundary in
  // Chromium; leaving the feedback delay reachable from destination made ordinary Android
  // streaming render an unused effect on every audio quantum. schedule() opens this edge only
  // for an echo transition, and neutralize() closes it again.
  const echoOutput = effectOutputRoute<DynamicsCompressorNode>(echoWet, fxLimiter);

  // The former alarm path fed the full song through a permanent Q=8 band-pass even though the
  // current Alarm effect is a separately limited oscillator below. It was both unused and an
  // easy source of resonant bursts if a stale gain automation escaped, so that dry-signal branch
  // intentionally stays removed rather than being kept muted.

  const hydrantDelay = ctx.createDelay(2);
  const hydrantFeedback = ctx.createGain();
  const hydrantFilter = ctx.createBiquadFilter();
  const hydrantReverb = ctx.createConvolver();
  const hydrantWet = ctx.createGain();
  hydrantDelay.delayTime.value = 0.5;
  hydrantFeedback.gain.value = 0.2;
  hydrantFilter.type = "highpass";
  hydrantFilter.frequency.value = 120;
  hydrantFilter.Q.value = 1;
  // 两台 deck 的卷积核可以安全共用。避免启动时在 WebView 主线程重复生成约三十万
  // 个随机采样，减轻第一次打开播放器时偶发的短卡顿。
  sharedReverbImpulse ??= reverbImpulse(ctx);
  hydrantReverb.buffer = sharedReverbImpulse;
  hydrantWet.gain.value = 0;
  highpass.connect(hydrantDelay);
  hydrantDelay.connect(hydrantFilter);
  hydrantFilter.connect(hydrantFeedback);
  hydrantFeedback.connect(hydrantDelay);
  hydrantFilter.connect(hydrantReverb);
  hydrantReverb.connect(hydrantWet);
  // The convolver is the most expensive branch in this graph. Keep its output detached during
  // normal playback so Android's realtime renderer can cull the complete delay/reverb chain.
  const hydrantOutput = effectOutputRoute<DynamicsCompressorNode>(hydrantWet, fxLimiter);

  // 效果器是退场唱盘的一部分，必须和干声共用同一个 fader。
  // 如果直接接 destination，旧歌虽然淡出了，回声/滤波尾音却会留在原电平，
  // 听起来像效果器脱离了正在被消掉的那首歌。
  fxLimiter.connect(fader);

  return {
    el,
    input,
    mediaGain,
    analyser,
    waveformTimeData: new Uint8Array(analyser.fftSize),
    waveformFrequencyData: new Float32Array(analyser.frequencyBinCount),
    dry,
    wet,
    vocalMakeup,
    low,
    lowpass,
    highpass,
    fader,
    volume,
    echoDelay,
    echoFeedback,
    echoWet,
    hydrantDelay,
    hydrantFeedback,
    hydrantFilter,
    hydrantWet,
    effectOutputs: { echo: echoOutput, hydrant: hydrantOutput },
    effectStopGeneration: 0,
    effectStopTimer: null,
    fxLimiter,
  };
}

type OptionalEffect = keyof OptionalEffectOutputRoutes<DynamicsCompressorNode>;

function effectWetGain(deck: Deck, effect: OptionalEffect): AudioParam {
  return effect === "echo" ? deck.echoWet.gain : deck.hydrantWet.gain;
}

/**
 * Release wet delay/reverb paths at zero crossing-friendly gain instead of disconnecting a live
 * sample. The generation fence prevents an old cancel timer from detaching a newly scheduled FX.
 */
function fadeOptionalEffects(
  ctx: AudioContext,
  deck: Deck,
  stopping: readonly OptionalEffect[] = ["echo", "hydrant"],
): void {
  const now = ctx.currentTime;
  const generation = ++deck.effectStopGeneration;
  if (deck.effectStopTimer !== null) window.clearTimeout(deck.effectStopTimer);
  for (const effect of stopping) {
    const wet = effectWetGain(deck, effect);
    const held = Math.max(0.0001, holdParam(wet, now));
    wet.setValueAtTime(held, now);
    wet.exponentialRampToValueAtTime(0.0001, now + EFFECT_STOP_FADE_SEC);
    wet.setValueAtTime(0, now + EFFECT_STOP_FADE_SEC);
  }
  deck.effectStopTimer = window.setTimeout(() => {
    if (deck.effectStopGeneration !== generation) return;
    deck.effectStopTimer = null;
    for (const effect of stopping) {
      setEffectOutputActive(deck.effectOutputs[effect], false);
    }
  }, EFFECT_STOP_SETTLE_MS);
}

/** A fresh transition owns its selected graph edges without hard-cutting an old wet sample. */
function activateOptionalEffects(deck: Deck, effects: DjEffect[]): void {
  deck.effectStopGeneration += 1;
  if (deck.effectStopTimer !== null) {
    window.clearTimeout(deck.effectStopTimer);
    deck.effectStopTimer = null;
  }
  const selected = new Set<OptionalEffect>(
    effects.filter((effect): effect is OptionalEffect => effect === "echo" || effect === "hydrant"),
  );
  for (const effect of selected) {
    // Cancel the old release's future zero before this transition writes its own wet curve.
    // Clearing only the JS timer is insufficient: AudioParam automation already lives on the
    // audio timeline and would otherwise mute the newly selected effect a few milliseconds in.
    if (ctx) holdParam(effectWetGain(deck, effect), ctx.currentTime);
    setEffectOutputActive(deck.effectOutputs[effect], true);
  }
  const stale = (Object.keys(deck.effectOutputs) as OptionalEffect[]).filter(
    (effect) => !selected.has(effect) && deck.effectOutputs[effect].connected,
  );
  if (stale.length && ctx) fadeOptionalEffects(ctx, deck, stale);
}

/** 把一台 deck 的所有参数掰回直导线状态。 */
function neutralize(ctx: AudioContext, deck: Deck, faderGain = 1): void {
  const now = ctx.currentTime;
  for (const param of [
    deck.dry.gain,
    deck.wet.gain,
    deck.vocalMakeup.gain,
    deck.low.gain,
    deck.lowpass.frequency,
    deck.lowpass.Q,
    deck.highpass.frequency,
    deck.highpass.Q,
    deck.fader.gain,
    deck.echoDelay.delayTime,
    deck.echoFeedback.gain,
    deck.hydrantDelay.delayTime,
    deck.hydrantFeedback.gain,
    deck.hydrantFilter.frequency,
    deck.hydrantFilter.Q,
  ]) {
    param.cancelScheduledValues(now);
  }
  deck.dry.gain.setValueAtTime(1, now);
  deck.wet.gain.setValueAtTime(0, now);
  deck.vocalMakeup.gain.setValueAtTime(1, now);
  deck.low.gain.setValueAtTime(0, now);
  deck.lowpass.frequency.setValueAtTime(20000, now);
  deck.lowpass.Q.setValueAtTime(channelFilterResonanceQ, now);
  deck.highpass.frequency.setValueAtTime(10, now);
  deck.highpass.Q.setValueAtTime(channelFilterResonanceQ, now);
  deck.fader.gain.setValueAtTime(faderGain, now);
  deck.echoDelay.delayTime.setValueAtTime(0.25, now);
  deck.echoFeedback.gain.setValueAtTime(0.25, now);
  deck.hydrantDelay.delayTime.setValueAtTime(0.5, now);
  deck.hydrantFeedback.gain.setValueAtTime(0.2, now);
  deck.hydrantFilter.frequency.setValueAtTime(120, now);
  deck.hydrantFilter.Q.setValueAtTime(1, now);
  fadeOptionalEffects(ctx, deck);
}

/* ---------------------------------------------------------------- 引擎 */

interface Pending {
  /** 交接期的收尾定时器 / 未起播时的 canplay 监听，取消时都要摘掉。 */
  finishTimer: number | null;
  startListener: (() => void) | null;
  startTimeout: number | null;
  /** Alarm 等临时节点在取消时必须立刻断开，不能留在 AudioContext 里继续响。 */
  effectStops: (() => void)[];
}

// 元素在模块加载时就建好：PlayerBar 首帧就要拿 frontElement() 去挂监听。
// AudioContext 则拖到第一次用 DJ 功能（warmup）才建——从没开过 DJ 的用户，
// 播放路径和以前一字不差，连音频图都不存在。
const elements: [HTMLAudioElement, HTMLAudioElement] = [createElement(), createElement()];
let ctx: AudioContext | null = null;
let decks: [Deck, Deck] | null = null;
/** AudioContext 建失败过（webview 不支持等）。别反复试，直接走硬切。 */
let broken = false;
let frontIndex: 0 | 1 = 0;
let pending: Pending | null = null;
/** seek 准备/交接与 DJ 过渡共用两台 deck；外部控制可要求恢复旧声或落到目标。 */
type SeekAbortMode = "restore" | "target";
let seekAbort: ((mode: SeekAbortMode) => void) | null = null;
let seekBusy = false;
/** seek/过渡操作代数；新操作或 pause/cancel 会让旧异步回调自动失效。 */
let seekOperationGeneration = 0;
interface PreparedNextDeck extends PreparedBrowserDeck {
  cue: number;
  rate: number;
  detachCueListener: (() => void) | null;
}
/**
 * 空闲 Web Audio Deck 上已经装好的下一首。仅解析在线 URL 不等于预热：真正决定
 * 首拍能否立即出来的是这个媒体元素在 cue 位置已有 HAVE_FUTURE_DATA。
 */
let preparedNextDeck: PreparedNextDeck | null = null;
export interface ExternalPlaybackAdoption extends ExternalAdoptionKey {
  element: HTMLAudioElement;
}
/** Ownership fence for async native→WebAudio adoption cleanup. */
let externalAdoptionGeneration = 0;

function clearPreparedNextDeck(): void {
  preparedNextDeck?.detachCueListener?.();
  preparedNextDeck = null;
}

function abortSeamlessSeek(mode: SeekAbortMode): void {
  const abort = seekAbort;
  if (!abort) return;
  seekAbort = null;
  abort(mode);
}

function absoluteMediaUrl(source: string): string {
  try {
    return new URL(source, document.baseURI).href;
  } catch {
    return source;
  }
}

function hasMediaSource(el: HTMLAudioElement, source: string): boolean {
  const expected = absoluteMediaUrl(source);
  return el.currentSrc === expected || el.src === expected;
}

function seekHandoffCurve(direction: "out" | "in"): Float32Array {
  const curve = new Float32Array(SEEK_CURVE_N);
  for (let index = 0; index < SEEK_CURVE_N; index += 1) {
    const progress = index / (SEEK_CURVE_N - 1);
    curve[index] =
      direction === "out"
        ? Math.cos((progress * Math.PI) / 2)
        : Math.sin((progress * Math.PI) / 2);
  }
  return curve;
}

const seekOutCurve = seekHandoffCurve("out");
const seekInCurve = seekHandoffCurve("in");
const externalOverlapCurve = Float32Array.from(
  { length: SEEK_CURVE_N },
  (_, index) => externalHandoffGain("overlap", index / (SEEK_CURVE_N - 1)),
);
const externalTakeoverCurve = Float32Array.from(
  { length: SEEK_CURVE_N },
  (_, index) => externalHandoffGain("takeover", index / (SEEK_CURVE_N - 1)),
);

interface DecodedTrack {
  source: string;
  buffer: AudioBuffer;
}

interface PcmRun {
  deckIndex: 0 | 1;
  sourceUrl: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  offset: number;
  startedAt: number;
  stopped: boolean;
}

let decodeGeneration = 0;
let decodeAbort: AbortController | null = null;
let decodedTrack: DecodedTrack | null = null;
let pcmRun: PcmRun | null = null;
let pcmPaused: { deckIndex: 0 | 1; sourceUrl: string; position: number } | null = null;
let pcmTickTimer: number | null = null;
let pcmSeekGeneration = 0;

function pcmPosition(run: PcmRun): number {
  if (!ctx || !decodedTrack || decodedTrack.source !== run.sourceUrl) return run.offset;
  const elapsed = Math.max(0, ctx.currentTime - run.startedAt);
  return Math.min(decodedTrack.buffer.duration, run.offset + elapsed);
}

function stopPcmTicker(): void {
  if (pcmTickTimer !== null) window.clearInterval(pcmTickTimer);
  pcmTickTimer = null;
}

function ensurePcmTicker(): void {
  if (pcmTickTimer !== null) return;
  pcmTickTimer = window.setInterval(() => {
    const run = pcmRun;
    if (!run || !decks) {
      stopPcmTicker();
      return;
    }
    // PlayerBar 仍监听当前逻辑 Deck 的 element；事件只是让它来读取引擎 PCM 时钟。
    decks[run.deckIndex].el.dispatchEvent(new Event("timeupdate"));
  }, PCM_TICK_MS);
}

function stopPcm(run: PcmRun, syncElement: boolean): number {
  const position = pcmPosition(run);
  run.stopped = true;
  try {
    run.source.stop();
  } catch {
    /* 已自然结束 */
  }
  try {
    run.source.disconnect();
    run.gain.disconnect();
  } catch {
    /* ignore */
  }
  if (syncElement && decks) {
    try {
      decks[run.deckIndex].el.currentTime = position;
    } catch {
      /* metadata 尚未到时只保留 PCM 位置 */
    }
  }
  if (pcmRun === run) pcmRun = null;
  if (!pcmRun) stopPcmTicker();
  return position;
}

function createPcmRun(deckIndex: 0 | 1, sourceUrl: string, offset: number, when: number): PcmRun | null {
  if (!ctx || !decks || !decodedTrack || decodedTrack.source !== sourceUrl) return null;
  const bounded = Math.min(Math.max(0, offset), Math.max(0, decodedTrack.buffer.duration - 0.001));
  const source = ctx.createBufferSource();
  source.buffer = decodedTrack.buffer;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(decks[deckIndex].input);
  const run: PcmRun = {
    deckIndex,
    sourceUrl,
    source,
    gain,
    offset: bounded,
    startedAt: when,
    stopped: false,
  };
  source.onended = () => {
    if (run.stopped || pcmRun !== run || !decks) return;
    pcmRun = null;
    pcmPaused = null;
    stopPcmTicker();
    decks[deckIndex].el.dispatchEvent(new Event("ended"));
  };
  source.start(when, bounded);
  return run;
}

function seekHotMediaElement(
  deckIndex: 0 | 1,
  at: number,
  shouldPlay: boolean,
  generation: number,
): Promise<HTMLAudioElement> {
  const el = elements[deckIndex];
  seekBusy = true;
  return new Promise((resolve) => {
    let done = false;
    let timeout: number | null = null;
    const cleanup = () => {
      el.removeEventListener("seeked", finish);
      el.removeEventListener("canplay", finish);
      if (timeout !== null) window.clearTimeout(timeout);
    };
    const complete = () => {
      if (done) return;
      done = true;
      cleanup();
      if (generation === seekOperationGeneration) seekBusy = false;
      resolve(el);
    };
    const finish = () => {
      if (done) return;
      if (generation !== seekOperationGeneration) {
        complete();
        return;
      }
      if (el.seeking || el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      if (shouldPlay && el.paused) void el.play().then(complete).catch(complete);
      else {
        if (!shouldPlay) el.pause();
        complete();
      }
    };
    el.addEventListener("seeked", finish);
    el.addEventListener("canplay", finish);
    timeout = window.setTimeout(() => {
      if (generation === seekOperationGeneration && shouldPlay && el.paused) {
        void el.play().catch(() => undefined);
      }
      complete();
    }, SEEK_READY_TIMEOUT_MS);
    try {
      el.currentTime = at;
    } catch {
      complete();
      return;
    }
    finish();
  });
}

function releaseDecodedPlayback(): void {
  decodeGeneration += 1;
  pcmSeekGeneration += 1;
  decodeAbort?.abort();
  decodeAbort = null;
  if (pcmRun) stopPcm(pcmRun, false);
  if (ctx && decks) {
    for (const deck of decks) {
      deck.mediaGain.gain.cancelScheduledValues(ctx.currentTime);
      deck.mediaGain.gain.setValueAtTime(1, ctx.currentTime);
    }
  }
  decodedTrack = null;
  pcmPaused = null;
  seekBusy = false;
}

export type DjTransitionPhase = "idle" | "preparing" | "mixing";
export interface DjTransitionState {
  phase: DjTransitionPhase;
  /** 当前正主 deck；0 映射左唱盘，1 映射右唱盘。 */
  frontIndex: 0 | 1;
}

let transitionPhase: DjTransitionPhase = "idle";
const transitionListeners = new Set<(state: DjTransitionState) => void>();

function transitionState(): DjTransitionState {
  return { phase: transitionPhase, frontIndex };
}

function setTransitionPhase(phase: DjTransitionPhase): void {
  transitionPhase = phase;
  const state = transitionState();
  for (const listener of transitionListeners) listener(state);
}

function clearPending(notifyIdle = true): void {
  if (!pending) return;
  if (pending.finishTimer !== null) clearTimeout(pending.finishTimer);
  if (pending.startTimeout !== null) clearTimeout(pending.startTimeout);
  for (const stop of pending.effectStops) stop();
  if (pending.startListener) {
    pending.startListener();
  }
  pending = null;
  if (notifyIdle) setTransitionPhase("idle");
}

/** 多选时每场随机取一个非空子集，因此全勾既可能单用，也可能叠加。 */
function chooseTransitions(selected: DjTransition[]): DjTransition[] {
  const chosen = selected.filter(() => Math.random() >= 0.5);
  return chosen.length ? chosen : [selected[Math.floor(Math.random() * selected.length)]];
}

/** 按本场快照铺自动化曲线。out 出让，input 进场，时长 seconds。 */
function schedule(
  transitions: DjTransition[],
  effects: DjEffect[],
  vocalCut: boolean,
  out: Deck,
  input: Deck,
  seconds: number,
  beatSeconds: number,
): void {
  if (!ctx) return;
  const now = ctx.currentTime;

  // Optional feedback/convolution branches are physically outside the audible graph during
  // ordinary streaming. Connect only the effects selected for this transition. Merely keeping a
  // wet GainNode at zero still made Android WebView render the upstream graph and could underrun
  // its low-latency output queue.
  activateOptionalEffects(out, effects);

  // 等功率交叉是所有预设共用的底：曲线之上再叠各自的手法
  out.fader.gain.cancelScheduledValues(now);
  input.fader.gain.cancelScheduledValues(now);
  out.fader.gain.setValueCurveAtTime(fadeOutCurve(), now, seconds);
  input.fader.gain.setValueCurveAtTime(fadeInCurve(), now, seconds);

  if (transitions.includes("eq")) {
    // 低频交棒：新歌憋着低音进场，中点附近两边交换——低频永远只有一个主人，
    // 两首歌的鼓同时砸满是新手混音最脏的声音
    input.low.gain.setValueCurveAtTime(
      piecewise([
        [0, -20],
        [0.45, -20],
        [0.62, 0],
        [1, 0],
      ]),
      now,
      seconds,
    );
    out.low.gain.setValueCurveAtTime(
      piecewise([
        [0, 0],
        [0.4, 0],
        [0.58, -20],
        [1, -20],
      ]),
      now,
      seconds,
    );
  }
  if (transitions.includes("filter")) {
    // 共振扫频：旧歌被低通「收走」，新歌从高通后面「放出来」。频率走 exp，
    // 人耳的音高感是对数的；Q 则直接采用设置里的低/中/高强度。
    out.lowpass.frequency.setValueAtTime(18000, now);
    out.lowpass.frequency.exponentialRampToValueAtTime(160, now + seconds);
    out.lowpass.Q.setValueAtTime(channelFilterResonanceQ, now);
    input.highpass.frequency.setValueAtTime(700, now);
    input.highpass.frequency.exponentialRampToValueAtTime(10, now + seconds * 0.7);
    input.highpass.Q.setValueAtTime(channelFilterResonanceQ, now);
  }
  // cross：只有底下那对等功率曲线；和别项一起抽到时不额外处理。

  if (vocalCut) {
    // 只做“削弱”而不是全消：最深时仍保留 56% 原声，叠加立体声 Side，
    // 再用温和补偿维持响度。这样人声会退后，但底鼓/贝斯不会像拔插头一样塌掉。
    out.dry.gain.setValueCurveAtTime(
      piecewise([
        [0, 1],
        [0.55, 0.72],
        [1, 0.56],
      ]),
      now,
      seconds,
    );
    out.wet.gain.setValueCurveAtTime(
      piecewise([
        [0, 0],
        [0.55, 0.55],
        [1, 0.82],
      ]),
      now,
      seconds,
    );
    out.vocalMakeup.gain.setValueCurveAtTime(
      piecewise([
        [0, 1],
        [0.55, 1.08],
        [1, 1.16],
      ]),
      now,
      seconds,
    );
  }

  if (effects.includes("echo")) {
    out.echoDelay.delayTime.setValueAtTime(Math.min(1.5, Math.max(0.06, beatSeconds / 2)), now);
    out.echoFeedback.gain.setValueAtTime(0.2, now);
    out.echoFeedback.gain.linearRampToValueAtTime(ECHO_FEEDBACK_MAX, now + seconds * 0.78);
    out.echoWet.gain.setValueCurveAtTime(
      piecewise([
        [0, 0],
        [0.15, 0.12],
        [0.78, 0.68],
        [1, 0],
      ]),
      now,
      seconds,
    );
  }

  if (effects.includes("alarm")) {
    // Alarm 是受控警报音，不再用 Q=14 的窄带滤波硬顶原曲；后者正是啸叫来源。
    // 电平很低并经过统一限幅器，频率只在 520–980Hz 间往返。
    const oscillator = ctx.createOscillator();
    const alarmGain = ctx.createGain();
    oscillator.type = "sawtooth";
    const curve = new Float32Array(CURVE_N);
    for (let index = 0; index < CURVE_N; index += 1) {
      const progress = index / (CURVE_N - 1);
      const cycles = 1.5 + progress * 4;
      curve[index] = 750 + Math.sin(progress * Math.PI * 2 * cycles) * 230;
    }
    oscillator.frequency.setValueCurveAtTime(curve, now, seconds);
    alarmGain.gain.setValueCurveAtTime(
      piecewise([
        [0, 0],
        [0.28, 0.018],
        [0.86, 0.065],
        [1, 0],
      ]),
      now,
      seconds,
    );
    oscillator.connect(alarmGain);
    alarmGain.connect(out.fxLimiter);
    oscillator.start(now);
    // The envelope reaches zero at `seconds`; leave one tiny tail before ending the oscillator so
    // both normal completion and cancellation retire the node only after silence.
    oscillator.stop(now + seconds + EFFECT_STOP_FADE_SEC);
    let stopped = false;
    const cleanupAlarm = () => {
      oscillator.disconnect();
      alarmGain.disconnect();
    };
    const stopAlarm = () => {
      if (stopped) return;
      stopped = true;
      const stopAt = ctx!.currentTime + EFFECT_STOP_FADE_SEC;
      const held = Math.max(0.0001, holdParam(alarmGain.gain, ctx!.currentTime));
      alarmGain.gain.setValueAtTime(held, ctx!.currentTime);
      alarmGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
      try {
        oscillator.stop(stopAt);
      } catch {
        cleanupAlarm();
      }
    };
    oscillator.onended = cleanupAlarm;
    pending?.effectStops.push(stopAlarm);
  }

  if (effects.includes("hydrant")) {
    out.hydrantDelay.delayTime.setValueAtTime(Math.min(1.5, Math.max(0.08, beatSeconds)), now);
    out.hydrantDelay.delayTime.exponentialRampToValueAtTime(
      Math.max(0.06, beatSeconds / 8),
      now + seconds * 0.82,
    );
    out.hydrantFeedback.gain.setValueAtTime(0.12, now);
    out.hydrantFeedback.gain.linearRampToValueAtTime(HYDRANT_FEEDBACK_MAX, now + seconds * 0.78);
    out.hydrantFilter.frequency.setValueAtTime(120, now);
    out.hydrantFilter.frequency.exponentialRampToValueAtTime(1800, now + seconds * 0.9);
    out.hydrantFilter.Q.setValueAtTime(1, now);
    out.hydrantFilter.Q.linearRampToValueAtTime(RESONANCE_Q_MAX, now + seconds * 0.78);
    out.hydrantWet.gain.setValueCurveAtTime(
      piecewise([
        [0, 0],
        [0.12, 0.1],
        [0.82, 0.58],
        [1, 0],
      ]),
      now,
      seconds,
    );
  }
}

export interface DjBeginOptions {
  transitions: DjTransition[];
  effects: DjEffect[];
  /** 出让方（正在放的这首）。BPM 同步和交接时长都以它为准。 */
  from: Track;
  /** 接歌用几小节（4/4）。 */
  bars: number;
  /** 接歌期间渐进剔除出让方的人声（中置声道消除）。 */
  vocalCut: boolean;
  /** 为 true 时新歌从 cue_ms 起播；否则从首拍（或曲头）起。 */
  applyInOutPoints?: boolean;
  /** 为 true 时等到出让方的下一小节边界再起播；否则仍等下一拍。 */
  autoBeatSync?: boolean;
}

/**
 * 从波形估算接歌起手时刻（秒）。
 *
 * 1. 从有效波形估算一个较低的相对尾音阈值；
 * 2. 用约 1.5 秒的连续窗口找最后一段真实声音，忽略尾部孤立尖峰和底噪；
 * 3. 起手 = 尾音结束 − mixSecs（设置里选 N 小节，就提前 N 小节接入）。
 *
 * amp 已在后端按每首歌的 P5/P99 归一化，固定数值并不是物理意义上的“绝对噪声底”。
 * 阈值取有效段平均响度的 12%（远低于旧版 50%，保住渐弱尾奏），再要求窗口内多数
 * bucket 都达标，避免一个编码残响把尾点拖到文件末端。
 */
export function findMixStartTime(
  wave: { duration: number; amp: number[] },
  mixSecs: number,
): number | null {
  const n = wave.amp.length;
  if (n < 8 || wave.duration <= 0 || mixSecs <= 0) return null;
  const secPerBucket = wave.duration / n;

  const NOISE_FLOOR = 0.02;
  const active = wave.amp.filter((value) => Number.isFinite(value) && value > NOISE_FLOOR);
  if (active.length < 8) return null;

  const average = active.reduce((sum, value) => sum + value, 0) / active.length;
  const threshold = Math.max(NOISE_FLOOR, average * 0.12);
  const windowBuckets = Math.max(2, Math.ceil(1.5 / secPerBucket));
  const requiredAudible = Math.ceil(windowBuckets * 0.6);

  let lastAudible = -1;
  for (let end = n - 1; end >= windowBuckets - 1; end -= 1) {
    let audible = 0;
    let sum = 0;
    for (let i = end - windowBuckets + 1; i <= end; i += 1) {
      const value = Number.isFinite(wave.amp[i]) ? wave.amp[i] : 0;
      sum += value;
      if (value >= threshold) audible += 1;
    }
    if (audible >= requiredAudible && sum / windowBuckets >= threshold) {
      lastAudible = end;
      break;
    }
  }
  if (lastAudible < 0) return null;

  const lastSoundEnd = Math.min(wave.duration, (lastAudible + 1) * secPerBucket);
  const mixStart = lastSoundEnd - mixSecs;
  return Math.max(0, Math.min(mixStart, wave.duration - 0.05));
}

/** @deprecated 使用 findMixStartTime */
export function findOutroStart(
  wave: { duration: number; amp: number[]; r: number[]; g: number[]; b: number[] },
  mixSecs: number,
): number | null {
  return findMixStartTime(wave, mixSecs);
}

/** 波形不可用时：按媒体时长从尾部倒推 N 小节。 */
export function mixStartFromDuration(
  durationSec: number,
  bpm: number | null | undefined,
  bars: number,
): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const mixSecs = mixSeconds(bpm, bars);
  if (mixSecs <= 0) return null;
  return Math.max(0, durationSec - mixSecs);
}

export const djEngine = {
  /** 当前正主元素。PlayerBar 的监听、seek、play/pause 全打在它身上。 */
  frontElement(): HTMLAudioElement {
    return elements[frontIndex];
  },

  /** Performance 模式使用固定 Deck 身份；不会随自动接歌的 front 角色互换。 */
  deckElement(index: 0 | 1): HTMLAudioElement {
    return elements[index];
  },

  /**
   * 读取当前已被媒体元素解码出来的一小帧，用于在线渐进波形。
   * 这里只读 Web Audio 图里的 AnalyserNode，不 fetch、不 decodeAudioData，
   * 因而波形的网络开销与正常播放完全相同。
   */
  waveformSample(
    el: HTMLAudioElement = elements[frontIndex],
  ): { amp: number; low: number; middle: number; high: number } | null {
    if (!ctx || !decks || ctx.state !== "running") return null;
    const deck = decks.find((candidate) => candidate.el === el);
    if (!deck) return null;
    deck.analyser.getByteTimeDomainData(deck.waveformTimeData);
    deck.analyser.getFloatFrequencyData(deck.waveformFrequencyData);

    let square = 0;
    for (const value of deck.waveformTimeData) {
      const normalized = (value - 128) / 128;
      square += normalized * normalized;
    }
    const amp = Math.min(1, Math.sqrt(square / Math.max(1, deck.waveformTimeData.length)) * 2.8);

    const nyquist = ctx.sampleRate / 2;
    let low = 0;
    let middle = 0;
    let high = 0;
    for (let index = 0; index < deck.waveformFrequencyData.length; index += 1) {
      const hz = (index / deck.waveformFrequencyData.length) * nyquist;
      // getFloatFrequencyData 给出 dB；还原为线性幅度后累加平方，最后开根号，
      // 与本地 Rust STFT 的“分频段功率求和 → 幅度”保持同一套量纲。
      const db = deck.waveformFrequencyData[index];
      const magnitude = Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
      const power = magnitude * magnitude;
      // 与 Rust 本地波形使用相同的 200 Hz / 1.5 kHz 三段交叉点。
      if (hz < 200) {
        low += power;
      } else if (hz < 1_500) {
        middle += power;
      } else {
        high += power;
      }
    }
    low = Math.sqrt(low);
    middle = Math.sqrt(middle);
    high = Math.sqrt(high);
    // 这里只返回真实三段幅度。颜色必须在 waveformCache 里相对于当前曲目
    // 已经听到的常态重新计算；逐帧直接除最大值会让绝大多数流媒体整片发黄。
    return { amp, low, middle, high };
  },

  /** 播放条的左右唱盘与真实双 deck 共用同一个编号。 */
  transitionState(): DjTransitionState {
    return transitionState();
  },

  /**
   * 监听准备 / 同时播放 / 交接完成。除了声音状态，也让唱盘在同一时刻启停；
   * 订阅时立刻回放当前状态，避免组件重挂载后猜错哪一边是正主。
   */
  subscribeTransition(listener: (state: DjTransitionState) => void): () => void {
    transitionListeners.add(listener);
    listener(transitionState());
    return () => transitionListeners.delete(listener);
  },

  /**
   * 协同播放的推子音量（见 lib/crossfade.ts）落在元素 volume 上，
   * 和引擎里的 Web Audio 增益是相乘关系，互不打架。两台一起设：
   * 接歌进行到一半拨推子，暗处退场那台也得跟着小。
   */
  setVolume(volume: number): void {
    const value = Math.min(1, Math.max(0, volume));
    if (ctx && decks) {
      for (const deck of decks) {
        deck.el.volume = 1;
        deck.volume.gain.setValueAtTime(value, ctx.currentTime);
      }
      return;
    }
    elements[0].volume = value;
    elements[1].volume = value;
  },

  /**
   * Browser-preview fallback for the persisted Performance filter setting. Save the value even
   * before Web Audio is warm so a later deck graph starts at the selected resonance; an existing
   * graph swaps both channel filters immediately.
   */
  setFilterResonance(resonance: FilterResonance): void {
    channelFilterResonanceQ = filterResonanceQ(resonance);
    if (!ctx || !decks) return;
    const now = ctx.currentTime;
    for (const deck of decks) {
      for (const param of [deck.lowpass.Q, deck.highpass.Q]) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(channelFilterResonanceQ, now);
      }
    }
  },

  /**
   * 唤醒已经接管播放器输出的 Web Audio 图。
   *
   * 页面刷新后 warmup 会提前把 media element 接进 AudioContext，但浏览器会按
   * 自动播放策略让新 context 保持 suspended。此时 audio.play() 可以成功、进度
   * 也会走，声音却被停在音频图里——这正是“刷新后第一首必定静音”的来源。
   * 播放入口必须在用户手势仍然有效时调用这里；effect 里再调用一次用于系统休眠、
   * 音频设备切换后 context 被重新挂起的恢复场景。
   */
  resume(): void {
    if (!ctx || ctx.state === "running") return;
    void ctx.resume();
  },

  /** 交接（含准备期）是否在进行。自动触发靠它防止一首歌里连开两场。 */
  isTransitioning(): boolean {
    return pending !== null || seekBusy;
  },

  /** PlayerBar 在 shadow deck 换手前忽略旧元素迟到的 timeupdate。 */
  isSeeking(): boolean {
    return seekBusy;
  },

  /** 「按小节提前量」：与 mixSeconds 相同，不再额外 +1.5s 抢跑。 */
  leadSeconds(bpm: number | null | undefined, bars: number): number {
    return mixSeconds(bpm, bars);
  },

  /**
   * 只在用户手势里预建 / 唤醒 AudioContext，不改当前媒体元素的信号路径。
   * 真正建 deck 留到 begin：因此开关接播不会把正在放的声音短暂重接一次。
   */
  prime(): boolean {
    if (nativeMobilePlaybackOwnsOutput()) return false;
    if (broken) return false;
    try {
      if (!ctx) {
        const options = audioContextOptionsForPlatform(window.kdj?.platform);
        ctx = options ? new AudioContext(options) : new AudioContext();
      }
      void ctx.resume();
      return true;
    } catch {
      broken = true;
      ctx = null;
      return false;
    }
  },

  /**
   * 建 AudioContext 和两条处理链。幂等；失败记 broken，之后 begin 永远
   * 返回 false（调用方回退硬切）。应用启动时就建好，避免第一次自动接歌
   * 时临时重接正在出声的 MediaElement，产生爆音或短暂停顿。
   */
  warmup(): boolean {
    if (nativeMobilePlaybackOwnsOutput()) return false;
    if (broken) return false;
    if (decks) {
      void ctx?.resume();
      return true;
    }
    try {
      if (!djEngine.prime() || !ctx) return false;
      // 第一次建立 MediaElementSource 会把正在播放的原生音频重新接入
      // WebAudio 图。若此刻仍保持满音量，WebView 可能在重接瞬间打出一个
      // 爆音；先把两台 element 静音一个渲染帧，接好图后再恢复原音量。
      const volumes = elements.map((element) => element.volume) as [number, number];
      for (const element of elements) element.volume = 0;
      try {
        decks = [buildDeck(ctx, elements[0]), buildDeck(ctx, elements[1])];
        void ctx.resume();
        decks[0].volume.gain.setValueAtTime(volumes[0], ctx.currentTime);
        decks[1].volume.gain.setValueAtTime(volumes[1], ctx.currentTime);
        requestAnimationFrame(() => {
          elements[0].volume = 1;
          elements[1].volume = 1;
        });
        return true;
      } catch (error) {
        elements[0].volume = volumes[0];
        elements[1].volume = volumes[1];
        throw error;
      }
    } catch {
      broken = true;
      ctx = null;
      decks = null;
      return false;
    }
  },

  /** 当前逻辑 Deck 的播放位置；PCM 模式读 AudioContext 时钟，流式模式读 element。 */
  currentTime(el: HTMLAudioElement = elements[frontIndex]): number {
    const index = elements.indexOf(el);
    if (index >= 0 && pcmRun?.deckIndex === index) return pcmPosition(pcmRun);
    if (index >= 0 && pcmPaused?.deckIndex === index) return pcmPaused.position;
    return el.currentTime;
  },

  /**
   * 当前曲目后台解成一份 Float32 PCM。仅保留一首且先按元数据估算内存；
   * 5 分钟 44.1kHz 立体声约 101MiB，超过 256MiB 的长 set 不进入该路径。
   */
  prepareDecodedSeek(track: Track, source: string): void {
    releaseDecodedPlayback();
    if (!djEngine.warmup() || !ctx) return;
    // DJ 接歌会保留 BPM 同步后的 playbackRate，而 AudioBufferSource 不能做
    // preservesPitch。此前仍在后台整首 fetch + decode，既永远不会被 seek 采用，
    // 又恰好与接歌后的第一次跳转争用 WebKit 解码器，造成必现卡顿和控制迟钝。
    if (Math.abs((decks?.[frontIndex].el.playbackRate || 1) - 1) >= 0.0001) return;
    const duration = track.duration ?? 0;
    const channels = Math.max(1, track.channels ?? 2);
    const estimatedRate = Math.max(8000, ctx.sampleRate);
    const estimatedBytes = duration * estimatedRate * channels * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0 || estimatedBytes > MAX_DECODED_PCM_BYTES) {
      return;
    }

    const expected = absoluteMediaUrl(source);
    const generation = ++decodeGeneration;
    const controller = new AbortController();
    decodeAbort = controller;
    void fetch(source, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`PCM fetch ${response.status}`);
        return response.arrayBuffer();
      })
      .then((encoded) => {
        if (generation !== decodeGeneration || !ctx) return null;
        return ctx.decodeAudioData(encoded);
      })
      .then((buffer) => {
        if (!buffer || generation !== decodeGeneration) return;
        const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (bytes > MAX_DECODED_PCM_BYTES) return;
        decodedTrack = { source: expected, buffer };
      })
      .catch(() => {
        // Abort、坏文件或 WebKit 不支持该编码都保留流式 shadow 回退。
      })
      .finally(() => {
        if (generation === decodeGeneration) decodeAbort = null;
      });
  },

  decodedSeekReady(source: string): boolean {
    return decodedTrack?.source === absoluteMediaUrl(source);
  },

  /** 换曲前释放当前 PCM 和未完成的 fetch/decode，避免旧曲继续占内存或漏声。 */
  releaseDecodedPlayback(): void {
    releaseDecodedPlayback();
  },

  /**
   * 把预测候选真正装进静音备用 Deck，而不只是提前解析一个 URL。
   *
   * 这与 Rust coordinator 的 `prepare` 是同一策略：有限缓冲、后台解码、切换时只
   * 换角色。尤其本地曲经过一次在线混接后仍由 Web Audio 持有，若没有这一步，
   * `begin` 会在交接临界点才 `src + load`，表现为标题已换而第一拍卡住。
   */
  prepareNext(next: Track, options: DjBeginOptions, fromRate?: number): boolean {
    if (!djEngine.warmup() || !ctx || !decks || pending || seekBusy) return false;
    const out = decks[frontIndex];
    const backIndex: 0 | 1 = frontIndex === 0 ? 1 : 0;
    const input = decks[backIndex];
    const source = mediaUrlForTrack(next);
    const expectedSource = absoluteMediaUrl(source);
    const cue = Math.max(
      0,
      options.applyInOutPoints && next.cue_ms !== null
        ? next.cue_ms / 1000
        : (next.first_beat ?? 0),
    );
    const outgoingRate = Math.max(0.25, fromRate ?? (out.el.playbackRate || 1));
    const effectiveFromBpm = options.from.bpm ? options.from.bpm * outgoingRate : null;
    const rate = bpmSyncRate(effectiveFromBpm, next.bpm);
    const reusable = canReusePreparedBrowserDeck(preparedNextDeck, {
      deckIndex: backIndex,
      trackId: next.id,
      source: expectedSource,
    });

    clearPreparedNextDeck();
    neutralize(ctx, input, 0);
    input.el.pause();
    input.el.preload = "auto";
    input.el.playbackRate = rate;
    input.mediaGain.gain.cancelScheduledValues(ctx.currentTime);
    input.mediaGain.gain.setValueAtTime(1, ctx.currentTime);
    if (!reusable && !hasMediaSource(input.el, source)) {
      input.el.src = source;
      input.el.load();
    }

    const prepared: PreparedNextDeck = {
      deckIndex: backIndex,
      trackId: next.id,
      source: expectedSource,
      cue,
      rate,
      detachCueListener: null,
    };
    preparedNextDeck = prepared;
    const applyCue = () => {
      if (preparedNextDeck !== prepared) return;
      if (input.el.readyState < HTMLMediaElement.HAVE_METADATA) return;
      if (needsPreparedCueSeek(input.el.currentTime, cue)) {
        try {
          input.el.currentTime = cue;
        } catch {
          return;
        }
      }
      prepared.detachCueListener?.();
      prepared.detachCueListener = null;
    };
    const detach = () => {
      input.el.removeEventListener("loadedmetadata", applyCue);
      input.el.removeEventListener("durationchange", applyCue);
    };
    prepared.detachCueListener = detach;
    input.el.addEventListener("loadedmetadata", applyCue);
    input.el.addEventListener("durationchange", applyCue);
    applyCue();
    return true;
  },

  /**
   * 把正在由 Rust/CPAL 出声的本地曲目时钟接进 Web Audio。
   *
   * 如果备用 Deck 已经缓存了在线候选，必须在当前/front Deck 上接入本地曲；旧的
   * `seamlessSeek` 会占用备用 Deck，并在收尾时把另一台也改成当前曲，等于亲手丢掉
   * 刚下载的候选 Range。这里始终在 front 上接外部时钟；没有候选时也无需占两台。
   */
  adoptExternalPlayback(
    source: string,
    target: number,
    shouldPlay: boolean,
    rate: number,
    releaseExternal: () => Promise<void>,
  ): Promise<ExternalPlaybackAdoption> {
    const normalizedRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const expectedSource = absoluteMediaUrl(source);
    if (!djEngine.warmup() || !ctx || !decks) {
      return Promise.reject(new Error("在线混音链路不可用"));
    }
    const adoptedDeckIndex = frontIndex;
    elements[adoptedDeckIndex].playbackRate = normalizedRate;
    if (!shouldPreservePreparedBackDeck(preparedNextDeck, frontIndex, expectedSource)) {
      // 这不是当前交接要保护的预测（或根本没有预测）。明确作废，避免后续同 URL
      // 的 metadata 迟到后把普通 shadow 误认成可复用候选。
      clearPreparedNextDeck();
    }

    const adoptionGeneration = ++externalAdoptionGeneration;
    seekOperationGeneration += 1;
    abortTransport();
    abortSeamlessSeek("restore");
    releaseDecodedPlayback();
    const generation = seekOperationGeneration;
    const deck = decks[adoptedDeckIndex];
    const el = deck.el;
    const outputLatency = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    const physicalRampDelayMs = externalHandoffPhysicalDelayMs(
      ctx.baseLatency,
      outputLatency,
      EXTERNAL_HANDOFF_STAGE_SEC,
      EXTERNAL_HANDOFF_SETTLE_MS,
      window.kdj?.platform === "android" ? ANDROID_EXTERNAL_OUTPUT_LATENCY_FLOOR_S : 0,
    );
    const at = Math.max(0, target);
    const clockCapturedAt = performance.now();
    const projectedClock = () => {
      const projected = projectedExternalPosition(
        at,
        performance.now() - clockCapturedAt,
        normalizedRate,
      );
      return Number.isFinite(el.duration) && el.duration > 0
        ? Math.min(projected, Math.max(0, el.duration - 0.05))
        : projected;
    };
    neutralize(ctx, deck, 0);
    el.pause();
    el.preload = "auto";
    el.playbackRate = normalizedRate;
    if (!hasMediaSource(el, source)) {
      el.src = source;
      el.load();
    }
    seekBusy = true;

    return new Promise((resolve, reject) => {
      let cueApplied = false;
      let clockCalibrations = 0;
      let starting = false;
      let done = false;
      let timeout: number | null = null;
      let settleTimer: number | null = null;
      const cleanup = () => {
        el.removeEventListener("loadedmetadata", tryStart);
        el.removeEventListener("durationchange", tryStart);
        el.removeEventListener("seeked", tryStart);
        el.removeEventListener("canplay", tryStart);
        if (timeout !== null) window.clearTimeout(timeout);
        if (settleTimer !== null) window.clearTimeout(settleTimer);
        timeout = null;
        settleTimer = null;
      };
      const fail = (reason: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (seekAbort === abort) seekAbort = null;
        if (generation === seekOperationGeneration) seekBusy = false;
        el.pause();
        if (ctx && decks) neutralize(ctx, deck, 0);
        reject(reason);
      };
      const abort = () => fail(new Error("本地与在线播放链路交接已取消"));
      seekAbort = abort;

      function tryStart() {
        if (done || starting || generation !== seekOperationGeneration) return;
        if (!cueApplied) {
          if (el.readyState < HTMLMediaElement.HAVE_METADATA) return;
          const livePosition = projectedClock();
          if (needsPreparedCueSeek(el.currentTime, livePosition)) {
            try {
              el.currentTime = livePosition;
              clockCalibrations += 1;
            } catch {
              fail(new Error("本地曲目时钟无法接入在线混音链路"));
              return;
            }
          }
          cueApplied = true;
        }
        if (el.seeking || el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
        const livePosition = projectedClock();
        if (!externalClockAligned(el.currentTime, livePosition)) {
          if (
            shouldRecalibrateExternalClock(
              el.currentTime,
              livePosition,
              clockCalibrations,
            )
          ) {
            try {
              // Rust 在本地 media load/Range seek 期间一直继续播放。若仍用最初捕获的
              // position，接管时会倒退整个准备耗时，听起来就是重复半拍/卡壳。
              el.currentTime = livePosition;
              clockCalibrations += 1;
              return;
            } catch {
              fail(new Error("本地曲目时钟二次校准失败"));
              return;
            }
          }
          // Two seeks are a bounded preparation budget, not permission to take over stale
          // media. Let the current native owner continue instead of repeating audible audio.
          fail(new Error("本地曲目时钟追赶超时"));
          return;
        }
        starting = true;
        if (timeout !== null) window.clearTimeout(timeout);
        timeout = null;
        const started = shouldPlay ? el.play() : Promise.resolve();
        void started
          .then(() => {
            if (done || generation !== seekOperationGeneration || !ctx || !decks) return;
            if (!shouldPlay) el.pause();
            deck.fader.gain.cancelScheduledValues(ctx.currentTime);
            deck.fader.gain.setValueAtTime(0, ctx.currentTime);
            deck.fader.gain.setValueCurveAtTime(
              externalOverlapCurve,
              ctx.currentTime,
              EXTERNAL_HANDOFF_STAGE_SEC,
            );
            // Rust 仍满幅时 Web Audio 最多只开到 -21.9dB；即使两个时钟恰好同相，
            // 总峰值也被限制在 +0.67dB 内，而不是原先两路满幅相加的 +6dB。
            settleTimer = window.setTimeout(() => {
              if (done || generation !== seekOperationGeneration || !ctx || !decks) return;
              settleTimer = null;
              const handoffContext = ctx;
              // Schedule the browser's full-gain curve before touching native output. It reaches
              // the physical speaker one WebAudio queue later; release Rust only near that edge
              // so its much shorter CPAL/AAudio queue drains into the already scheduled curve.
              // Reversing this order leaves an audible 80–100ms -21.9dB hole on Android.
              deck.fader.gain.cancelScheduledValues(handoffContext.currentTime);
              deck.fader.gain.setValueAtTime(
                EXTERNAL_HANDOFF_OVERLAP_GAIN,
                handoffContext.currentTime,
              );
              deck.fader.gain.setValueCurveAtTime(
                externalTakeoverCurve,
                handoffContext.currentTime,
                EXTERNAL_HANDOFF_STAGE_SEC,
              );
              const nativeReleaseLeadMs = externalNativeReleaseSettleMs(window.kdj?.platform);
              settleTimer = window.setTimeout(() => {
                if (done || generation !== seekOperationGeneration || !ctx || !decks) return;
                void releaseExternal()
                  .then(() => {
                    if (done || generation !== seekOperationGeneration || !ctx || !decks) return;
                    settleTimer = window.setTimeout(() => {
                      if (done) return;
                      done = true;
                      cleanup();
                      if (seekAbort === abort) seekAbort = null;
                      seekBusy = false;
                      if (ctx && decks) neutralize(ctx, deck, 1);
                      resolve({
                        element: el,
                        generation: adoptionGeneration,
                        deckIndex: adoptedDeckIndex,
                        source: expectedSource,
                      });
                    }, nativeReleaseLeadMs);
                  })
                  .catch(() => fail(new Error("原生输出无法让出在线播放链路")));
              }, Math.max(0, physicalRampDelayMs - nativeReleaseLeadMs));
            // `setValueCurveAtTime` 已完成调度不代表扬声器已听见。Android 的
            // playback latencyHint 可让输出队列显著长于 6ms；等低增益曲线越过
            // baseLatency + outputLatency 后才静音 Rust，避免两边都没声的断口。
            }, physicalRampDelayMs);
          })
          .catch(() => fail(new Error("本地曲目无法在在线混音链路中起播")));
      }

      el.addEventListener("loadedmetadata", tryStart);
      el.addEventListener("durationchange", tryStart);
      el.addEventListener("seeked", tryStart);
      el.addEventListener("canplay", tryStart);
      timeout = window.setTimeout(
        () => fail(new Error("本地曲目混音预读超时")),
        SEEK_READY_TIMEOUT_MS,
      );
      tryStart();
    });
  },

  /**
   * 新意图在 adopt 完成后、begin 之前到达时，精确停掉本次新起的 WebAudio copy。
   * generation + deck + source 三重核对避免迟到 cleanup 把后来已经接管同一物理 Deck
   * 的新歌误停。
   */
  discardExternalAdoption(adoption: ExternalPlaybackAdoption): boolean {
    const el = elements[frontIndex];
    const currentSource = absoluteMediaUrl(el.currentSrc || el.src);
    if (
      !ownsExternalAdoption(
        adoption,
        externalAdoptionGeneration,
        frontIndex,
        currentSource,
      ) ||
      adoption.element !== el
    ) {
      return false;
    }
    externalAdoptionGeneration += 1;
    clearPreparedNextDeck();
    if (ctx && decks) neutralize(ctx, decks[frontIndex], 0);
    el.pause();
    return true;
  },

  /** PCM seek 后的硬播放：继续从内存采样位置走，不唤醒已静音的 HTMLMedia。 */
  async hardPlay(el: HTMLAudioElement = elements[frontIndex]): Promise<void> {
    const index = elements.indexOf(el);
    if (index < 0 || !ctx || !decks) {
      await el.play();
      return;
    }
    if (pcmRun?.deckIndex === index) return;
    const paused = pcmPaused;
    if (paused?.deckIndex === index && decodedTrack?.source === paused.sourceUrl) {
      const run = createPcmRun(index as 0 | 1, paused.sourceUrl, paused.position, ctx.currentTime);
      if (run) {
        run.gain.gain.setValueAtTime(1, ctx.currentTime);
        decks[index].mediaGain.gain.setValueAtTime(0, ctx.currentTime);
        pcmRun = run;
        pcmPaused = null;
        ensurePcmTicker();
        return;
      }
    }
    decks[index].mediaGain.gain.setValueAtTime(1, ctx.currentTime);
    await el.play();
  },

  /** PCM seek 后的硬暂停：按 AudioContext 时钟记位置，下一次从同一采样恢复。 */
  hardPause(el: HTMLAudioElement = elements[frontIndex]): void {
    const index = elements.indexOf(el);
    if (index >= 0 && pcmRun?.deckIndex === index && decks) {
      const run = pcmRun;
      const position = stopPcm(run, true);
      pcmPaused = { deckIndex: index as 0 | 1, sourceUrl: run.sourceUrl, position };
      decks[index].mediaGain.gain.setValueAtTime(0, ctx?.currentTime ?? 0);
    }
    el.pause();
  },

  /**
   * 空闲 deck 只取同一资源的 metadata，作为 PCM 尚未解好时的回退 shadow。
   * 不整首解码、不建 AudioBuffer；内存仍是两个流式媒体缓冲，自动接歌随时可覆盖。
   */
  prepareSeek(source: string): void {
    if (!djEngine.warmup() || !ctx || !decks || pending || seekBusy) return;
    clearPreparedNextDeck();
    const backIndex: 0 | 1 = frontIndex === 0 ? 1 : 0;
    const back = decks[backIndex];
    neutralize(ctx, back, 0);
    back.el.pause();
    back.el.preload = "metadata";
    back.el.playbackRate = decks[frontIndex].el.playbackRate || 1;
    if (!hasMediaSource(back.el, source)) {
      back.el.src = source;
      back.el.load();
    }
  },

  /**
   * 当前曲目 PCM 已就绪时，在同一逻辑 Deck 的 input 内按采样时钟换源，点击后
   * 一个渲染量子就从目标位置出声。只有解码未完成/超内存上限时才走流式 shadow。
   */
  seamlessSeek(source: string, target: number, shouldPlay: boolean): Promise<HTMLAudioElement> {
    externalAdoptionGeneration += 1;
    // 普通 seek 会借用备用 Deck。先使预测凭据失效，避免 begin 把随后被覆盖的
    // element 误认为仍然保有下一首的 Range 缓冲。
    clearPreparedNextDeck();
    const at = Math.max(0, target);
    seekOperationGeneration += 1;
    abortTransport();
    // 新目标只撤掉上一轮尚未落地的准备，不能把旧轮目标先硬切出来。
    abortSeamlessSeek("restore");

    const direct = () => {
      const el = elements[frontIndex];
      if (pcmRun?.deckIndex === frontIndex) {
        const run = pcmRun;
        stopPcm(run, false);
        pcmPaused = { deckIndex: frontIndex, sourceUrl: run.sourceUrl, position: at };
        if (decks && ctx) decks[frontIndex].mediaGain.gain.setValueAtTime(0, ctx.currentTime);
      } else if (pcmPaused?.deckIndex === frontIndex) {
        pcmPaused.position = at;
      }
      try {
        el.currentTime = at;
      } catch {
        /* metadata 尚未到时由媒体元素保留默认位置，error 监听负责最终报错 */
      }
      return el;
    };
    if (!shouldPlay || !djEngine.warmup() || !ctx || !decks) {
      return Promise.resolve(direct());
    }
    void ctx.resume();

    const expectedSource = absoluteMediaUrl(source);
    const deckIndex = frontIndex;
    const deck = decks[deckIndex];
    if (
      !pending &&
      decodedTrack?.source === expectedSource &&
      Math.abs((deck.el.playbackRate || 1) - 1) < 0.0001
    ) {
      const oldRun = pcmRun?.deckIndex === deckIndex ? pcmRun : null;
      const when = ctx.currentTime + PCM_SEEK_LEAD_SEC;
      const run = createPcmRun(deckIndex, expectedSource, at, when);
      if (run) {
        const generation = ++pcmSeekGeneration;
        seekBusy = true;
        pcmPaused = null;
        run.gain.gain.setValueCurveAtTime(seekInCurve, when, PCM_SEEK_HANDOFF_SEC);
        if (oldRun) {
          const held = Math.min(1, Math.max(0, holdParam(oldRun.gain.gain, ctx.currentTime)));
          const curve = Float32Array.from(seekOutCurve, (value) => value * held);
          oldRun.gain.gain.setValueCurveAtTime(curve, when, PCM_SEEK_HANDOFF_SEC);
        } else {
          const held = Math.min(1, Math.max(0, holdParam(deck.mediaGain.gain, ctx.currentTime)));
          const curve = Float32Array.from(seekOutCurve, (value) => value * held);
          deck.mediaGain.gain.setValueCurveAtTime(curve, when, PCM_SEEK_HANDOFF_SEC);
        }
        pcmRun = run;
        ensurePcmTicker();
        window.setTimeout(() => {
          if (oldRun) stopPcm(oldRun, false);
          if (generation !== pcmSeekGeneration || !ctx || !decks || pcmRun !== run) return;
          deck.mediaGain.gain.cancelScheduledValues(ctx.currentTime);
          deck.mediaGain.gain.setValueAtTime(0, ctx.currentTime);
          deck.el.pause();
          try {
            deck.el.currentTime = pcmPosition(run);
          } catch {
            /* PCM 时钟仍是权威位置 */
          }
          seekBusy = false;
          deck.el.dispatchEvent(new Event("timeupdate"));
        }, (PCM_SEEK_LEAD_SEC + PCM_SEEK_HANDOFF_SEC) * 1000 + SEEK_SETTLE_MS);
        return Promise.resolve(deck.el);
      }
    }

    const wasTransitioning = pending !== null;
    let outIndex: 0 | 1 = frontIndex;
    let inputIndex: 0 | 1 = frontIndex === 0 ? 1 : 0;
    if (wasTransitioning) {
      // UI 的正主从 begin 起就是进场曲。用户此时点波形，意图是结束混音并在
      // 第二首内部跳转，不是先把第二首掐掉、把第一首拉回满幅，再重新接一次。
      // 后一种旧流程会稳定制造一次可闻的“回抽/卡顿”。先顺向收完到第二首，
      // 然后直接 seek 这台已经在播放、时间拉伸器也已热好的 element。
      inputIndex = frontIndex;
      outIndex = frontIndex === 0 ? 1 : 0;
      const out = decks[outIndex];
      const input = decks[inputIndex];
      const generation = seekOperationGeneration;
      const now = ctx.currentTime;
      const outGain = Math.min(1, Math.max(0, holdParam(out.fader.gain, now)));
      const inputGain = Math.min(1, Math.max(0, holdParam(input.fader.gain, now)));
      clearPending(false);
      out.fader.gain.cancelScheduledValues(now);
      input.fader.gain.cancelScheduledValues(now);
      out.fader.gain.setValueAtTime(outGain, now);
      input.fader.gain.setValueAtTime(inputGain, now);
      out.fader.gain.linearRampToValueAtTime(0, now + SEEK_HANDOFF_SEC);
      input.fader.gain.linearRampToValueAtTime(1, now + SEEK_HANDOFF_SEC);
      seekBusy = true;
      return new Promise((resolve) => {
        window.setTimeout(() => {
          if (generation !== seekOperationGeneration || !ctx || !decks) {
            resolve(elements[frontIndex]);
            return;
          }
          neutralize(ctx, out, 0);
          out.el.pause();
          neutralize(ctx, input, 1);
          frontIndex = inputIndex;

          void seekHotMediaElement(inputIndex, at, shouldPlay, generation).then((el) => {
            if (
              generation === seekOperationGeneration &&
              transitionPhase !== "idle"
            ) {
              setTransitionPhase("idle");
            }
            resolve(el);
          });
        }, SEEK_HANDOFF_SEC * 1000);
      });
    }

    const out = decks[outIndex];
    const input = decks[inputIndex];
    neutralize(ctx, out, 1);
    neutralize(ctx, input, 0);
    input.el.pause();
    input.el.preload = "auto";
    if (!wasTransitioning) input.el.playbackRate = out.el.playbackRate || 1;
    if (!hasMediaSource(input.el, source)) {
      input.el.src = source;
      input.el.load();
    }

    seekBusy = true;
    return new Promise((resolve) => {
      let seekApplied = false;
      let starting = false;
      let finished = false;
      let timeout: number | null = null;
      let settleTimer: number | null = null;

      const removeListeners = () => {
        input.el.removeEventListener("loadedmetadata", tryStart);
        input.el.removeEventListener("durationchange", tryStart);
        input.el.removeEventListener("seeked", tryStart);
        input.el.removeEventListener("canplay", tryStart);
        if (timeout !== null) window.clearTimeout(timeout);
        timeout = null;
      };

      const settleOn = (index: 0 | 1, otherIndex: 0 | 1, play: boolean) => {
        if (!ctx || !decks) return elements[index];
        const chosen = decks[index];
        const other = decks[otherIndex];
        frontIndex = index;
        neutralize(ctx, chosen, 1);
        neutralize(ctx, other, 0);
        other.el.pause();
        if (play) void chosen.el.play().catch(() => undefined);
        if (transitionPhase !== "idle") setTransitionPhase("idle");
        return chosen.el;
      };

      const restore = (mode: SeekAbortMode) => {
        if (finished) {
          if (settleTimer !== null) window.clearTimeout(settleTimer);
          settleTimer = null;
          settleOn(inputIndex, outIndex, mode === "target");
          seekBusy = false;
          return;
        }
        finished = true;
        removeListeners();
        input.el.pause();
        if (mode === "target") {
          // 仍在静音链路时先落点，再把输出交给它；顺序反过来会漏出 cue 位置的一帧。
          try {
            input.el.currentTime = at;
          } catch {
            /* 同 direct 回退 */
          }
        }
        const chosen =
          mode === "target"
            ? settleOn(inputIndex, outIndex, true)
            : settleOn(outIndex, inputIndex, true);
        seekBusy = false;
        resolve(chosen);
      };
      seekAbort = restore;

      const failToDirectSeek = () => {
        if (finished) return;
        finished = true;
        removeListeners();
        seekAbort = null;
        if (wasTransitioning) {
          try {
            input.el.currentTime = at;
          } catch {
            /* 同 direct 回退 */
          }
          const chosen = settleOn(inputIndex, outIndex, true);
          seekBusy = false;
          resolve(chosen);
          return;
        }
        input.el.pause();
        neutralize(ctx!, input, 0);
        neutralize(ctx!, out, 1);
        frontIndex = outIndex;
        try {
          out.el.currentTime = at;
        } catch {
          /* 同 direct 回退 */
        }
        seekBusy = false;
        resolve(out.el);
      };

      const handoff = () => {
        if (finished || !ctx || !decks) return;
        finished = true;
        removeListeners();
        const switchAt = ctx.currentTime + SEEK_HANDOFF_LEAD_SEC;
        neutralize(ctx, out, 1);
        neutralize(ctx, input, 0);
        out.fader.gain.setValueCurveAtTime(seekOutCurve, switchAt, SEEK_HANDOFF_SEC);
        input.fader.gain.setValueCurveAtTime(seekInCurve, switchAt, SEEK_HANDOFF_SEC);
        frontIndex = inputIndex;
        // seekBusy 在 settle 结束前保持 true，PlayerBar 即使立即采用新 frontElement，
        // 也不会执行 ensureAudible 打断当前包络；因此无需延迟 Promise/控制响应。
        resolve(input.el);

        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          if (!ctx || !decks) {
            seekBusy = false;
            seekAbort = null;
            return;
          }
          neutralize(ctx, input, 1);
          neutralize(ctx, out, 0);
          out.el.pause();
          // 下一次点击通常只需一次目标 Range；不把整首歌复制进内存。
          out.el.preload = "metadata";
          out.el.playbackRate = input.el.playbackRate || 1;
          if (!hasMediaSource(out.el, source)) {
            out.el.src = source;
            out.el.load();
          }
          seekBusy = false;
          seekAbort = null;
          // 交接曲线和旧 deck pause 都真正结束后才发布 idle。订阅方此时再预热
          // 备用 deck，不会反过来截断正在执行的 seek。
          if (transitionPhase !== "idle") setTransitionPhase("idle");
        }, (SEEK_HANDOFF_LEAD_SEC + SEEK_HANDOFF_SEC) * 1000 + SEEK_SETTLE_MS);
      };

      function tryStart() {
        if (finished || starting) return;
        if (!seekApplied) {
          if (input.el.readyState < HTMLMediaElement.HAVE_METADATA) return;
          try {
            input.el.currentTime = at;
          } catch {
            failToDirectSeek();
            return;
          }
          seekApplied = true;
        }
        if (input.el.seeking || input.el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
        starting = true;
        void input.el.play().then(handoff).catch(failToDirectSeek);
      }

      input.el.addEventListener("loadedmetadata", tryStart);
      input.el.addEventListener("durationchange", tryStart);
      input.el.addEventListener("seeked", tryStart);
      input.el.addEventListener("canplay", tryStart);
      timeout = window.setTimeout(failToDirectSeek, SEEK_READY_TIMEOUT_MS);
      tryStart();
    });
  },

  /**
   * 开始接歌。同步完成角色互换——返回 true 后 frontElement() 已经是新歌的
   * 元素（调用方立刻把 UI 切过去），旧歌在暗处按曲线退场。
   * 返回 false = 引擎不可用，调用方走普通换歌。
   */
  begin(next: Track, options: DjBeginOptions): boolean {
    // begin 正式接管刚 adopt 的 front；从此旧异步分支不得再把它当临时 copy 清理。
    externalAdoptionGeneration += 1;
    seekOperationGeneration += 1;
    abortSeamlessSeek("target");
    if (!options.transitions.length || !djEngine.warmup() || !ctx || !decks) return false;
    void ctx.resume();

    const transitions = chooseTransitions(options.transitions);

    // 启停声还没收尾时就接歌：先结束旧 transport，避免两声 motor 叠在一起。
    abortTransport();

    // 上一场还没收尾就来了新的一场：把上一场立刻掐掉。此刻的 front 马上要
    // 变成出让方，速度停在哪儿就是哪儿——它反正在退场，别让它跳。
    clearPending();
    const out = decks[frontIndex];
    const backIndex: 0 | 1 = frontIndex === 0 ? 1 : 0;
    const input = decks[backIndex];
    // 备用 Deck 重新给 HTMLMedia 使用；它可能在更早的一次 PCM seek 中被静音。
    input.mediaGain.gain.cancelScheduledValues(ctx.currentTime);
    input.mediaGain.gain.setValueAtTime(1, ctx.currentTime);
    if (pcmPaused?.deckIndex === backIndex) pcmPaused = null;
    // 上一场若被提前打断，当前正主可能仍挂着进场用的高通/低频削减曲线。
    // clearPending 只负责摘 timer/listener，必须在把它当作新出让方前恢复全频；
    // 否则第二次接歌会把半截滤波继续带下去，直到用户 seek/重播才被 transport 清掉。
    neutralize(ctx, out);

    // 已经接进来的曲目可能仍维持本场 master tempo。后续必须按实际听到的 BPM
    // 继续同步，不能拿文件标签里的原始 BPM，否则每接一首都会让速度基准漂移。
    const effectiveFromBpm = options.from.bpm
      ? options.from.bpm * Math.max(0.25, out.el.playbackRate || 1)
      : null;
    const rate = bpmSyncRate(effectiveFromBpm, next.bpm);
    const seconds = mixSeconds(effectiveFromBpm ?? next.bpm, options.bars);
    const tempo = effectiveFromBpm ?? next.bpm ?? FALLBACK_BPM;
    const beatSeconds = 60 / Math.max(1, tempo);

    const requestedSource = absoluteMediaUrl(mediaUrlForTrack(next));
    const reusePrepared = canReusePreparedBrowserDeck(preparedNextDeck, {
      deckIndex: backIndex,
      trackId: next.id,
      source: requestedSource,
    });
    clearPreparedNextDeck();
    input.el.pause();
    neutralize(ctx, input);
    input.fader.gain.setValueAtTime(0, ctx.currentTime); // 静音进场，曲线负责抬
    // 在装载 / 起播之前就配置变速器，避免已经播放后突然切 playbackRate，触发
    // WebKit 的 preservesPitch 时间拉伸器重新初始化。
    input.el.playbackRate = rate;
    // 命中预测预热时保留媒体元素已有的 Range/解码缓冲。无条件重写相同 src 再
    // load 会把 readyState 清零，正是混入在线曲后每次切换都会“顿一下”的根因。
    if (!reusePrepared || !hasMediaSource(input.el, requestedSource)) {
      input.el.src = requestedSource;
      input.el.load();
    }

    frontIndex = backIndex;

    // 起播点：开关打开且用户摆了 cue → 用 cue；否则第一拍（跳过前奏静音），再不行从头
    const cue =
      options.applyInOutPoints && next.cue_ms !== null
        ? next.cue_ms / 1000
        : (next.first_beat ?? 0);

    let cueApplied = false;
    let starting = false;
    const start = () => {
      if (!ctx || !decks || !pending) return;
      // canplay 可能是对 0 秒位置发出的。必须先 seek 到真正的 cue，再等目标位置
      // 也达到 HAVE_FUTURE_DATA；否则淡入已开始，解码器却还在处理 Range 跳转。
      if (!cueApplied) {
        if (input.el.readyState < HTMLMediaElement.HAVE_METADATA) return;
        // 对已经预热在 cue 的元素重复赋 currentTime 也会重新发 Range 并丢缓冲。
        if (needsPreparedCueSeek(input.el.currentTime, cue)) {
          try {
            input.el.currentTime = cue;
          } catch {
            /* 极少数格式 metadata 到了仍不能 seek；保留从头接歌的回退 */
          }
        }
        cueApplied = true;
      }
      if (
        input.el.seeking ||
        input.el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ||
        starting
      ) {
        return;
      }
      starting = true;
      const removePreparationListeners = pending.startListener;
      pending.startListener = null;
      removePreparationListeners?.();
      if (pending.startTimeout !== null) clearTimeout(pending.startTimeout);
      pending.startTimeout = null;
      const active = pending;

      const playOnBeat = () => {
        if (pending !== active) return;
        pending.startTimeout = null;
        // play() fulfilled 才表示媒体流水线真的起动。旧歌在这几毫秒里继续满幅播放，
        // 比先开淡入曲线、再等新歌解码稳定更不容易出现可闻的凹口。
        void input.el
          .play()
          .then(() => {
            if (!ctx || !decks || pending !== active) return;
            schedule(
              transitions,
              options.effects,
              options.vocalCut,
              out,
              input,
              seconds,
              beatSeconds,
            );
            setTransitionPhase("mixing");
            pending.finishTimer = window.setTimeout(() => {
              // 曲线已经在音频时钟上归零并稳定了一小段，再停媒体元素。不能在数学
              // 终点同一毫秒 pause：主线程 timer 略早于音频线程就会硬切出 click。
              out.el.pause();
              if (pcmRun?.deckIndex === (frontIndex === 0 ? 1 : 0)) stopPcm(pcmRun, false);
              // 退场 deck 在被下一首复用前始终保持真正静音。若这里把 fader 重置
              // 到 1，WebKit pause 后偶尔吐出的残留解码帧仍可能漏成一声 click。
              // 进场 deck 也要显式归中性：正常情况下曲线终点已经是全频，但
              // AudioContext 暂停/设备切换会让音频时钟落后于主线程 timer，不能把
              // “最后一个采样点碰巧执行了”当成效果清理机制。
              if (ctx && decks) {
                neutralize(ctx, out, 0);
                neutralize(ctx, input);
              }
              pending = null;
              setTransitionPhase("idle");
            }, seconds * 1000 + AUDIO_TAIL_SETTLE_MS);
          })
          .catch(() => {
            // 起播失败（文件坏了等）：掐掉这一场。PlayerBar 的 error 监听会显示原因。
            if (pending === active) djEngine.cancel();
          });
      };

      // BPM 相同不等于拍点相位相同。异步挑歌/加载完成的时刻是随机的，直接从
      // next.first_beat 起播会让新歌第一拍落在旧歌两拍之间，两只底鼓挤成稳定的
      // “哒哒”瞬态。已知旧歌网格时，卡到下一个拍或小节边界再起播。
      const waitMs = msUntilNextBoundary(
        djEngine.currentTime(out.el),
        options.from.bpm,
        options.from.first_beat,
        Math.max(0.25, out.el.playbackRate || 1),
        options.autoBeatSync ? GRID_BEATS_PER_BAR : 1,
      );
      if (waitMs != null) {
        active.startTimeout = window.setTimeout(playOnBeat, waitMs);
      } else {
        playOnBeat();
      }
    };

    const listener = () => {
      start();
    };
    pending = {
      finishTimer: null,
      startListener: listener,
      // 本地流几百毫秒内必有 canplay；兜底 5 秒后再尝试一次。正常路径必须等
      // cue seek 后的 canplay，而不是拿 0 秒位置的缓冲状态直接起淡入。
      startTimeout: window.setTimeout(() => {
        start();
      }, 5000),
      effectStops: [],
    };
    // canplay 在 seek 前后都可能各发一次，不能 once；start() 会检查 cue 是否已经
    // 应用、目标位置是否停止 seeking，并用 starting 防止重复起播。
    input.el.addEventListener("loadedmetadata", listener);
    input.el.addEventListener("seeked", listener);
    input.el.addEventListener("canplay", listener);
    pending.startListener = () => {
      input.el.removeEventListener("loadedmetadata", listener);
      input.el.removeEventListener("seeked", listener);
      input.el.removeEventListener("canplay", listener);
    };
    setTransitionPhase("preparing");
    start();
    return true;
  },

  /**
   * 硬停：掐掉所有定时器和曲线，非正主 deck 停下，正主链归中性、速度归 1。
   * 用户硬切歌 / 按停止 / 关掉预设时调。对着一台从没动过的引擎调它是空操作。
   */
  cancel(): void {
    externalAdoptionGeneration += 1;
    seekOperationGeneration += 1;
    seekBusy = false;
    abortTransport();
    abortSeamlessSeek("target");
    // hard load / source replacement 都先经过 cancel。预测凭据必须和物理 element
    // 同生共死；否则旧 metadata 迟到后可能让 begin 跳过新曲真正需要的 load。
    clearPreparedNextDeck();
    // 先原子地停完两台，再发布 idle。以前 clearPending() 会先通知 PlayerBar，
    // idle 订阅立刻启动静音预热，与这次 pause/cancel 在同一调用栈里互相抢 play/pause。
    const wasTransitioning = transitionPhase !== "idle";
    clearPending(false);
    if (!ctx || !decks) {
      if (wasTransitioning) setTransitionPhase("idle");
      return;
    }
    const backIndex = frontIndex === 0 ? 1 : 0;
    // 先静音再 pause，避免过渡中途硬切非正主 deck 时漏出一个非零采样。
    neutralize(ctx, decks[backIndex], 0);
    decks[backIndex].el.pause();
    if (pcmRun?.deckIndex === backIndex) stopPcm(pcmRun, false);
    if (pcmPaused?.deckIndex === backIndex) pcmPaused = null;
    neutralize(ctx, decks[frontIndex]);
    decks[frontIndex].el.playbackRate = 1;
    if (wasTransitioning) setTransitionPhase("idle");
  },

  /** 普通起播前调用：避免上次软停把 fader 留在 0 导致「按了播放却没声」。 */
  ensureAudible(): void {
    abortTransport();
    abortSeamlessSeek("target");
    restoreFrontOutput();
  },

  /**
   * 主按钮软停：保持原曲全频与正常速度，叠加 motor 刹停声，末尾推子收 0。
   */
  async softPause(motorSound = true, seconds = TRANSPORT_STOP_SEC): Promise<void> {
    abortTransport();
    abortSeamlessSeek("target");
    const gen = transportGen;
    clearPending();
    const el = elements[frontIndex];
    if (decks) {
      const back = decks[frontIndex === 0 ? 1 : 0];
      if (ctx) neutralize(ctx, back, 0);
      back.el.pause();
    }
    if (el.paused && pcmRun?.deckIndex !== frontIndex) {
      restoreFrontOutput();
      return;
    }
    const deck = frontDeckOrNull();
    // 播放中途才建 MediaElementSource 会爆一下；图还没暖好就硬停，别硬接。
    if (!ctx || !deck) {
      el.pause();
      return;
    }
    scheduleTransport(deck, "out", seconds);
    if (motorSound) playTransportSound(deck, "out", seconds);
    const ok = await waitTransport(seconds * 1000 + TRANSPORT_SETTLE_MS, gen);
    if (!ok) return;
    if (pcmRun?.deckIndex === frontIndex) {
      const run = pcmRun;
      const position = stopPcm(run, true);
      pcmPaused = { deckIndex: frontIndex, sourceUrl: run.sourceUrl, position };
    }
    el.pause();
    // 停住后保持静音链路；下次 softPlay/ensureAudible 再打开。
    neutralize(ctx, deck, 0);
  },

  /**
   * 主按钮软起：全频推子平滑抬起，同时叠加一声电机启转。
   * 接歌过渡进行中不要调——那条路自己管起播。
   */
  async softPlay(
    el: HTMLAudioElement = elements[frontIndex],
    motorSound = true,
    seconds = TRANSPORT_START_SEC,
  ): Promise<void> {
    abortTransport();
    abortSeamlessSeek("target");
    const gen = transportGen;
    djEngine.resume();
    djEngine.warmup();
    const deck = frontDeckOrNull();
    if (!ctx || !deck || el !== deck.el) {
      restoreFrontOutput();
      await djEngine.hardPlay(el);
      return;
    }
    // 真正停住时从静音起播；若是在淡出途中快速反悔，则保留此刻增益并直接
    // 反向淡入，不能先砍到 0，否则快速连点仍会听见一个断口。
    const arm = ctx.currentTime;
    const startGain = el.paused
      ? 0
      : Math.min(1, Math.max(0, holdParam(deck.fader.gain, arm)));
    neutralize(ctx, deck, startGain);
    await djEngine.hardPlay(el);
    if (gen !== transportGen) return;
    scheduleTransport(deck, "in", seconds);
    if (motorSound) playTransportSound(deck, "in", seconds);
    const ok = await waitTransport(seconds * 1000 + TRANSPORT_SETTLE_MS, gen);
    if (!ok) return;
    neutralize(ctx, deck, 1);
  },

  /**
   * 关应用 / 刷新页面前瞬间静音。
   * softPause 仍要等待短淡出，窗口已经在拆了，来不及——直接把增益掐到 0
   * 再 pause，避免媒体元素被硬卸时泄出一声 click。
   */
  silenceForExit(): void {
    abortTransport();
    abortSeamlessSeek("target");
    clearPreparedNextDeck();
    clearPending();
    releaseDecodedPlayback();
    for (const el of elements) {
      try {
        el.volume = 0;
        el.muted = true;
        el.pause();
      } catch {
        /* 拆页时 DOM 可能已经半死 */
      }
    }
    if (ctx && decks) {
      const now = ctx.currentTime;
      for (const deck of decks) {
        try {
          deck.fader.gain.cancelScheduledValues(now);
          deck.fader.gain.setValueAtTime(0, now);
          deck.el.volume = 0;
          deck.el.muted = true;
          deck.el.pause();
        } catch {
          /* ignore */
        }
      }
      try {
        void ctx.suspend();
      } catch {
        /* ignore */
      }
    }
  },
};

// 在任何曲目开始播放前建好 MediaElementSource。AudioContext 会保持 suspended，
// 不会绕过浏览器的用户手势限制；真正播放仍由播放器的用户操作触发。
// 这消除了第一次自动接歌时的重接爆音和偶发停顿。
try {
  // 正式 Tauri 壳的主输出由 Rust/系统播放器持有。Web Audio 只在浏览器开发时
  // 预热；桌面在线预览需要它时由 BrowserPreview 路径显式 warmup。
  if (!window.__TAURI_INTERNALS__ && !nativeMobilePlaybackOwnsOutput()) djEngine.warmup();
} catch {
  // warmup 自己会把 broken 记住，后续自动回退到普通硬切。
}

// 开发环境把引擎挂到 window：过渡是"听"出来的东西，自动化测试和排查
// 只能靠这个口子看 isTransitioning / 两台 deck 的实时状态。打包版不带。
if (import.meta.env.DEV) {
  (window as Window & { __kdDj?: unknown }).__kdDj = {
    engine: djEngine,
    elements,
  };
}
