/**
 * DJ 接歌：双 deck + Web Audio 的过渡引擎。
 *
 * 平时播放器只有一个 <audio>，换歌是硬切。开了 DJ 预设之后，换歌变成
 * 「两台唱机同时转」：下一首在暗处起播（BPM 拉到和当前一致），两边按预设的
 * 自动化曲线交接（交叉渐变 / 低频交棒 / 共振滤波扫频 / 人声消除），交接完
 * 再把新歌的速度慢慢抬回原速。这正是 DJ 台上「sync → mix → pitch back」的顺序。
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
import { api } from "./api";
import type { Track } from "../types";

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
export const DJ_BARS_OPTIONS = [2, 4, 8, 16, 32] as const;

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
}

const DEFAULT_CONFIG: DjConfig = {
  enabled: false,
  transitions: ["cross"],
  effects: [],
  bars: 8,
  vocalCut: false,
};

function loadDjConfig(): DjConfig {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { enabled, transitions, effects, preset, bars, vocalCut } = raw as Record<string, unknown>;
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
}

function saveDjConfig(state: DjConfig): void {
  const { enabled, transitions, effects, bars, vocalCut } = state;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ enabled, transitions, effects, bars, vocalCut }),
  );
}

export const useDjConfig = create<DjConfigState>((set, get) => ({
  ...loadDjConfig(),
  toggleEnabled() {
    const enabled = !get().enabled;
    set({ enabled });
    saveDjConfig(get());
    if (enabled) djEngine.prime();
    else djEngine.cancel();
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
    set({ bars });
    saveDjConfig(get());
  },
  setVocalCut(vocalCut) {
    set({ vocalCut });
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
/** 交接完成后速度抬回原速的斜率：每 1% 的偏差花 0.8 秒，听不出台阶。 */
const RAMP_S_PER_PCT = 0.8;
/** 自动化曲线的采样点数。64 点对几秒到十几秒的曲线足够平滑。 */
const CURVE_N = 64;
/** 反馈总是严格低于 0.4；效果链再异常也不允许接近自激。 */
const ECHO_FEEDBACK_MAX = 0.34;
const HYDRANT_FEEDBACK_MAX = 0.3;
/** 共振 Q 的安全上限。高于 3 在满电平母带上很容易形成刺耳窄峰。 */
const RESONANCE_Q_MAX = 2.4;

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
function syncRate(fromBpm: number | null, toBpm: number | null): number {
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

/** preservesPitch 还没进所有 TS lib 的 HTMLMediaElement，包一层。 */
function setPreservesPitch(el: HTMLAudioElement, value: boolean): void {
  (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = value;
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
  dry: GainNode;
  wet: GainNode;
  vocalMakeup: GainNode;
  low: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  highpass: BiquadFilterNode;
  fader: GainNode;
  echoDelay: DelayNode;
  echoFeedback: GainNode;
  echoWet: GainNode;
  alarmFilter: BiquadFilterNode;
  alarmWet: GainNode;
  hydrantDelay: DelayNode;
  hydrantFeedback: GainNode;
  hydrantFilter: BiquadFilterNode;
  hydrantWet: GainNode;
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

function createElement(): HTMLAudioElement {
  const el = document.createElement("audio");
  el.preload = "metadata";
  // 必须在任何 src 赋值之前定死：中途改 crossOrigin 不影响已加载的资源，
  // 而没有它 MediaElementSource 只会输出静音（见文件头）
  el.crossOrigin = "anonymous";
  setPreservesPitch(el, true); // 变速不变调：BPM 同步是拉速度，不是拉音高
  return el;
}

function buildDeck(ctx: AudioContext, el: HTMLAudioElement): Deck {
  const source = ctx.createMediaElementSource(el);

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
  source.connect(splitter);
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
  lowpass.Q.value = 0.7;

  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 10;
  highpass.Q.value = 0.7;

  const fader = ctx.createGain();
  fader.gain.value = 1;

  source.connect(dry);
  dry.connect(vocalMakeup);
  wet.connect(vocalMakeup);
  vocalMakeup.connect(low);
  low.connect(lowpass);
  lowpass.connect(highpass);
  highpass.connect(fader);
  fader.connect(ctx.destination);

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
  echoWet.connect(fxLimiter);

  const alarmFilter = ctx.createBiquadFilter();
  const alarmWet = ctx.createGain();
  alarmFilter.type = "bandpass";
  alarmFilter.frequency.value = 900;
  alarmFilter.Q.value = 8;
  alarmWet.gain.value = 0;
  highpass.connect(alarmFilter);
  alarmFilter.connect(alarmWet);
  alarmWet.connect(fxLimiter);

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
  hydrantReverb.buffer = reverbImpulse(ctx);
  hydrantWet.gain.value = 0;
  highpass.connect(hydrantDelay);
  hydrantDelay.connect(hydrantFilter);
  hydrantFilter.connect(hydrantFeedback);
  hydrantFeedback.connect(hydrantDelay);
  hydrantFilter.connect(hydrantReverb);
  hydrantReverb.connect(hydrantWet);
  hydrantWet.connect(fxLimiter);

  // 效果器是退场唱盘的一部分，必须和干声共用同一个 fader。
  // 如果直接接 destination，旧歌虽然淡出了，回声/滤波尾音却会留在原电平，
  // 听起来像效果器脱离了正在被消掉的那首歌。
  fxLimiter.connect(fader);

  return {
    el,
    dry,
    wet,
    vocalMakeup,
    low,
    lowpass,
    highpass,
    fader,
    echoDelay,
    echoFeedback,
    echoWet,
    alarmFilter,
    alarmWet,
    hydrantDelay,
    hydrantFeedback,
    hydrantFilter,
    hydrantWet,
    fxLimiter,
  };
}

/** 把一台 deck 的所有参数掰回直导线状态。 */
function neutralize(ctx: AudioContext, deck: Deck): void {
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
    deck.echoWet.gain,
    deck.alarmFilter.frequency,
    deck.alarmFilter.Q,
    deck.alarmWet.gain,
    deck.hydrantDelay.delayTime,
    deck.hydrantFeedback.gain,
    deck.hydrantFilter.frequency,
    deck.hydrantFilter.Q,
    deck.hydrantWet.gain,
  ]) {
    param.cancelScheduledValues(now);
  }
  deck.dry.gain.setValueAtTime(1, now);
  deck.wet.gain.setValueAtTime(0, now);
  deck.vocalMakeup.gain.setValueAtTime(1, now);
  deck.low.gain.setValueAtTime(0, now);
  deck.lowpass.frequency.setValueAtTime(20000, now);
  deck.lowpass.Q.setValueAtTime(0.7, now);
  deck.highpass.frequency.setValueAtTime(10, now);
  deck.highpass.Q.setValueAtTime(0.7, now);
  deck.fader.gain.setValueAtTime(1, now);
  deck.echoDelay.delayTime.setValueAtTime(0.25, now);
  deck.echoFeedback.gain.setValueAtTime(0.25, now);
  deck.echoWet.gain.setValueAtTime(0, now);
  deck.alarmFilter.frequency.setValueAtTime(900, now);
  deck.alarmFilter.Q.setValueAtTime(8, now);
  deck.alarmWet.gain.setValueAtTime(0, now);
  deck.hydrantDelay.delayTime.setValueAtTime(0.5, now);
  deck.hydrantFeedback.gain.setValueAtTime(0.2, now);
  deck.hydrantFilter.frequency.setValueAtTime(120, now);
  deck.hydrantFilter.Q.setValueAtTime(1, now);
  deck.hydrantWet.gain.setValueAtTime(0, now);
}

/* ---------------------------------------------------------------- 引擎 */

interface Pending {
  /** 交接期的收尾定时器 / 未起播时的 canplay 监听，取消时都要摘掉。 */
  finishTimer: number | null;
  startListener: (() => void) | null;
  startTimeout: number | null;
  rampTimer: number | null;
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

function clearPending(): void {
  if (!pending) return;
  if (pending.finishTimer !== null) clearTimeout(pending.finishTimer);
  if (pending.startTimeout !== null) clearTimeout(pending.startTimeout);
  if (pending.rampTimer !== null) clearInterval(pending.rampTimer);
  for (const stop of pending.effectStops) stop();
  if (pending.startListener) {
    elements[frontIndex].removeEventListener("canplay", pending.startListener);
  }
  pending = null;
}

/**
 * 交接完成后把速度慢慢抬回原速。playbackRate 不是 AudioParam，
 * 只能主线程走表；50ms 一步、每步不到 0.1%，听感上是连续的。
 */
function rampRateBack(el: HTMLAudioElement, from: number): void {
  if (Math.abs(from - 1) < 0.001) return;
  const seconds = Math.min(10, Math.max(2, Math.abs(from - 1) * 100 * RAMP_S_PER_PCT));
  const startedAt = performance.now();
  const timer = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - startedAt) / (seconds * 1000));
    el.playbackRate = from + (1 - from) * t;
    if (t >= 1) {
      clearInterval(timer);
      if (pending?.rampTimer === timer) pending = null;
    }
  }, 50);
  pending = {
    finishTimer: null,
    startListener: null,
    startTimeout: null,
    rampTimer: timer,
    effectStops: [],
  };
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
    // 共振扫频：旧歌被低通「收走」，共振峰越拉越高做出扫频的啸声；
    // 新歌从高通后面「放出来」。频率走 exp，人耳的音高感是对数的。
    out.lowpass.frequency.setValueAtTime(18000, now);
    out.lowpass.frequency.exponentialRampToValueAtTime(160, now + seconds);
    out.lowpass.Q.setValueAtTime(0.7, now);
    out.lowpass.Q.linearRampToValueAtTime(RESONANCE_Q_MAX, now + seconds * 0.8);
    input.highpass.frequency.setValueAtTime(700, now);
    input.highpass.frequency.exponentialRampToValueAtTime(10, now + seconds * 0.7);
    input.highpass.Q.setValueAtTime(RESONANCE_Q_MAX, now);
    input.highpass.Q.linearRampToValueAtTime(0.7, now + seconds * 0.7);
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
    oscillator.stop(now + seconds);
    let stopped = false;
    const stopAlarm = () => {
      if (stopped) return;
      stopped = true;
      try {
        oscillator.stop();
      } catch {
        /* 已按计划停止 */
      }
      oscillator.disconnect();
      alarmGain.disconnect();
    };
    oscillator.onended = stopAlarm;
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
}

/**
 * 在曲子的尾段找「人声退场、只剩背景音」的时间点（秒）。找不到返回 null。
 *
 * 不是真正的人声识别——那需要模型。用的是现成的波形三频段数据
 * （见 Waveform 类型：红=低频/鼓，绿=中频/人声，蓝=高频/镲）：
 * 人声的能量主要落在中频，「结尾一段的中频占比明显低于全曲中段的基线」
 * 就当人声已经退了。副歌收尾长音、纯器乐的中频主旋律会骗过它，
 * 所以调用方必须把它当**建议**用，找不到/不可信就回退到按长度倒推。
 */
export function findOutroStart(
  wave: { duration: number; amp: number[]; r: number[]; g: number[]; b: number[] },
  mixSecs: number,
): number | null {
  const n = wave.amp.length;
  if (n < 32 || wave.duration <= 0) return null;
  const secPerBucket = wave.duration / n;

  // 基线：中段 25%..75% 里「有声」桶的中频占比中位数——人声通常住在这儿
  const shares: number[] = [];
  for (let i = Math.floor(n * 0.25); i < Math.floor(n * 0.75); i++) {
    const total = wave.r[i] + wave.g[i] + wave.b[i];
    if (wave.amp[i] > 0.05 && total > 0) shares.push(wave.g[i] / total);
  }
  if (shares.length < 16) return null; // 大半是静音/数据太少，基线不可信
  shares.sort((a, b) => a - b);
  const baseline = shares[Math.floor(shares.length / 2)];
  if (baseline <= 0.05) return null; // 整曲几乎没有中频（纯打击乐？），没得判

  // 从 70% 处往后找：连续「接歌那么长」的一段，中频占比都跌破基线的七成。
  // 窗口必须盖住整个过渡——只看一两个桶，副歌换气的空拍都能骗过它。
  const windowBuckets = Math.max(4, Math.round(mixSecs / secPerBucket));
  const searchFrom = Math.floor(n * 0.7);
  for (let start = searchFrom; start <= n - Math.ceil(windowBuckets / 2); start++) {
    let ok = true;
    const end = Math.min(n, start + windowBuckets);
    for (let i = start; i < end; i++) {
      const total = wave.r[i] + wave.g[i] + wave.b[i];
      // 已经淡出到近静音的桶算"没人声"，不打断窗口
      if (wave.amp[i] <= 0.05 || total <= 0) continue;
      if (wave.g[i] / total > baseline * 0.7) {
        ok = false;
        break;
      }
    }
    if (ok) return start * secPerBucket;
  }
  return null;
}

export const djEngine = {
  /** 当前正主元素。PlayerBar 的监听、seek、play/pause 全打在它身上。 */
  frontElement(): HTMLAudioElement {
    return elements[frontIndex];
  },

  /**
   * 协同播放的推子音量（见 lib/crossfade.ts）落在元素 volume 上，
   * 和引擎里的 Web Audio 增益是相乘关系，互不打架。两台一起设：
   * 接歌进行到一半拨推子，暗处退场那台也得跟着小。
   */
  setVolume(volume: number): void {
    elements[0].volume = volume;
    elements[1].volume = volume;
  },

  /** 交接（含准备期）是否在进行。自动触发靠它防止一首歌里连开两场。 */
  isTransitioning(): boolean {
    return pending !== null && pending.rampTimer === null;
  },

  /** 「顺其自然」档的起手提前量：交接本身的长度 + 一点挑歌/加载的余量。 */
  leadSeconds(bpm: number | null | undefined, bars: number): number {
    return mixSeconds(bpm, bars) + 1.5;
  },

  /**
   * 只在用户手势里预建 / 唤醒 AudioContext，不改当前媒体元素的信号路径。
   * 真正建 deck 留到 begin：因此开关接播不会把正在放的声音短暂重接一次。
   */
  prime(): boolean {
    if (broken) return false;
    try {
      ctx ??= new AudioContext();
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
   * 返回 false（调用方回退硬切）。在用户手势里调它（选预设时）。
   */
  warmup(): boolean {
    if (broken) return false;
    if (decks) {
      void ctx?.resume();
      return true;
    }
    try {
      if (!djEngine.prime() || !ctx) return false;
      decks = [buildDeck(ctx, elements[0]), buildDeck(ctx, elements[1])];
      void ctx.resume();
      return true;
    } catch {
      broken = true;
      ctx = null;
      decks = null;
      return false;
    }
  },

  /**
   * 开始接歌。同步完成角色互换——返回 true 后 frontElement() 已经是新歌的
   * 元素（调用方立刻把 UI 切过去），旧歌在暗处按曲线退场。
   * 返回 false = 引擎不可用，调用方走普通换歌。
   */
  begin(next: Track, options: DjBeginOptions): boolean {
    if (!options.transitions.length || !djEngine.warmup() || !ctx || !decks) return false;
    void ctx.resume();

    const transitions = chooseTransitions(options.transitions);

    // 上一场还没收尾就来了新的一场：把上一场立刻掐掉。此刻的 front 马上要
    // 变成出让方，速度停在哪儿就是哪儿——它反正在退场，别让它跳。
    clearPending();
    const out = decks[frontIndex];
    const backIndex: 0 | 1 = frontIndex === 0 ? 1 : 0;
    const input = decks[backIndex];

    const rate = syncRate(options.from.bpm, next.bpm);
    const seconds = mixSeconds(options.from.bpm ?? next.bpm, options.bars);
    const tempo = options.from.bpm ?? next.bpm ?? FALLBACK_BPM;
    const beatSeconds = 60 / Math.max(1, tempo);

    input.el.pause();
    neutralize(ctx, input);
    input.fader.gain.setValueAtTime(0, ctx.currentTime); // 静音进场，曲线负责抬
    input.el.src = api.audioUrl(next.id);
    input.el.load();

    frontIndex = backIndex;

    // 起播点：用户摆的 cue 优先，其次第一拍（跳过前奏静音），再不行从头
    const cue = next.cue_ms !== null ? next.cue_ms / 1000 : (next.first_beat ?? 0);

    const start = () => {
      if (!ctx || !decks || !pending) return;
      pending.startListener = null;
      pending.startTimeout = null;
      try {
        input.el.currentTime = cue;
      } catch {
        /* metadata 还没就位就 seek 会抛，从头放也能接 */
      }
      input.el.playbackRate = rate;
      void input.el.play().catch(() => {
        // 起播失败（文件坏了等）：掐掉这一场，旧歌继续放，
        // PlayerBar 那边的 error 监听会把原因写到播放条上
        djEngine.cancel();
      });
      schedule(transitions, options.effects, options.vocalCut, out, input, seconds, beatSeconds);
      pending.finishTimer = window.setTimeout(() => {
        // 交接结束：出让方谢幕，新歌把速度慢慢抬回原速
        out.el.pause();
        if (ctx && decks) neutralize(ctx, out);
        pending = null;
        rampRateBack(input.el, rate);
      }, seconds * 1000);
    };

    const listener = () => {
      if (pending?.startTimeout != null) clearTimeout(pending.startTimeout);
      start();
    };
    pending = {
      finishTimer: null,
      startListener: listener,
      // 本地流几百毫秒内必有 canplay；兜底 5 秒后硬起播（边放边缓冲）
      startTimeout: window.setTimeout(() => {
        input.el.removeEventListener("canplay", listener);
        start();
      }, 5000),
      rampTimer: null,
      effectStops: [],
    };
    if (input.el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      clearTimeout(pending.startTimeout!);
      pending.startTimeout = null;
      start();
    } else {
      input.el.addEventListener("canplay", listener, { once: true });
    }
    return true;
  },

  /**
   * 硬停：掐掉所有定时器和曲线，非正主 deck 停下，正主链归中性、速度归 1。
   * 用户硬切歌 / 按停止 / 关掉预设时调。对着一台从没动过的引擎调它是空操作。
   */
  cancel(): void {
    clearPending();
    if (!ctx || !decks) return;
    const backIndex = frontIndex === 0 ? 1 : 0;
    decks[backIndex].el.pause();
    neutralize(ctx, decks[backIndex]);
    neutralize(ctx, decks[frontIndex]);
    decks[frontIndex].el.playbackRate = 1;
  },
};

// 开发环境把引擎挂到 window：过渡是"听"出来的东西，自动化测试和排查
// 只能靠这个口子看 isTransitioning / 两台 deck 的实时状态。打包版不带。
if (import.meta.env.DEV) {
  (window as Window & { __kdDj?: unknown }).__kdDj = {
    engine: djEngine,
    elements,
  };
}
