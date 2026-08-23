/**
 * KDJ 自己的 MIDI 映射层：一份 JSON 描述任意设备，一条消息可以同时打到多个动作。
 * 不执行 Mixxx/djay 脚本；灯光只按输出表回发 Note/CC。
 */

export type MidiKind = "note" | "cc";
export type MidiValueMap = "unipolar" | "bipolar" | "relative";
export type EqStemLayer = "eq" | "stems";
export type MidiDeck = 0 | 1;

export type MidiActionType =
  | "playToggle"
  | "cue"
  | "sync"
  | "eqHigh"
  | "eqMid"
  | "eqLow"
  | "filter"
  | "gain"
  | "volume"
  | "crossfader"
  | "toggleCrossfader"
  | "master"
  | "tempo"
  | "loopToggle"
  | "loopSize"
  | "toggleEqStem"
  | "stemGain"
  | "shiftHold"
  /** 原始缓动盘转动；运行时根据电容触摸状态决定刮擦或 pitch bend。 */
  | "jog"
  /** 电容盘面的按下/松开状态。 */
  | "jogTouch"
  /** 兼容早期用户映射；新映射请使用 jog。 */
  | "scratch"
  | "jogSeek"
  /** 兼容早期用户映射；新映射请使用 jogTouch。 */
  | "scratchTouch"
  | "browseStep"
  | "browsePress"
  | "loadSelected";

export type MidiFeedbackKey = "playing" | "pausedLoaded" | "syncing" | "looping" | "eqStem" | "crossfaderEnabled";

export interface MidiWhen {
  eqStem?: EqStemLayer;
  /** 软件 Shift 层。Buddy 的 Shift 对 jog 会换 CC，对 EQ 旋钮有时仍发原 CC。 */
  shift?: boolean;
}

export interface MidiActionSpec {
  type: MidiActionType;
  deck?: MidiDeck;
  stems?: Array<"drums" | "bass" | "other" | "vocals">;
  value?: MidiValueMap;
  when?: MidiWhen;
}

export interface MidiBinding {
  kind: MidiKind;
  channel: number;
  data: number;
  /** 14-bit 推子的 LSB CC。MIDI 规范是 MSB+32；Reloop TEMPO 实际是 MSB 9、LSB 63。 */
  lsb?: number;
  /**
   * 高分辨率推子组合成的最大值。缺省按 14-bit（16383）。
   * Reloop Buddy/Ready 的 TEMPO 只走 10-bit（MSB 0–7），Mixxx 用 max 1023。
   */
  max?: number;
  /**
   * 反转（djay 高级控制选项同名）。相对同类电位器反相。
   * TEMPO 上端是 −、下端是 +；Browser 滚动默认开启，顺时针往下。
   */
  invert?: boolean;
  /** 按钮默认只在按下（velocity/value > 0）触发；旋钮为 all。 */
  edge?: "press" | "release" | "all";
  actions: MidiActionSpec[];
}

export interface MidiOutputSpec {
  kind: MidiKind;
  channel: number;
  data: number;
  from: MidiFeedbackKey;
  deck?: MidiDeck;
  on?: number;
  off?: number;
}

export interface MidiMapping {
  name: string;
  description?: string;
  match: { portContains: string[] };
  bindings: MidiBinding[];
  outputs?: MidiOutputSpec[];
}

export interface MidiMessage {
  port: string;
  bytes: number[];
}

export interface ParsedMidi {
  kind: MidiKind;
  channel: number;
  data: number;
  value: number;
  pressed: boolean;
}

export interface MidiLayerState {
  eqStem: [EqStemLayer, EqStemLayer];
  shift?: boolean;
}

export type MidiResolvedAction =
  | { type: "playToggle" | "cue" | "sync" | "loopToggle" | "toggleEqStem"; deck: MidiDeck }
  | { type: "toggleCrossfader" }
  | { type: "shiftHold"; held: boolean }
  | { type: "jogTouch" | "scratchTouch"; deck: MidiDeck; held: boolean }
  | { type: "browsePress" }
  | { type: "loadSelected"; deck: MidiDeck }
  | { type: "loopSize" | "jog" | "scratch" | "jogSeek"; deck: MidiDeck; delta: number }
  | { type: "browseStep"; delta: number }
  | {
    type: "eqHigh" | "eqMid" | "eqLow" | "filter" | "gain" | "volume" | "crossfader" | "master" | "tempo";
    deck?: MidiDeck;
    value: number;
  }
  | { type: "stemGain"; deck: MidiDeck; stems: Array<"drums" | "bass" | "other" | "vocals">; value: number };

export interface MidiFeedback {
  playing: [boolean, boolean];
  pausedLoaded: [boolean, boolean];
  syncing: [boolean, boolean];
  looping: [boolean, boolean];
  eqStem: [boolean, boolean];
  crossfaderEnabled: boolean;
}

export interface MidiOutputMessage {
  kind: MidiKind;
  channel: number;
  data: number;
  value: number;
}

const ACTION_TYPES = new Set<string>([
  "playToggle",
  "cue",
  "sync",
  "eqHigh",
  "eqMid",
  "eqLow",
  "filter",
  "gain",
  "volume",
  "crossfader",
  "toggleCrossfader",
  "master",
  "tempo",
  "loopToggle",
  "loopSize",
  "toggleEqStem",
  "stemGain",
  "shiftHold",
  "jog",
  "jogTouch",
  "scratch",
  "jogSeek",
  "scratchTouch",
  "browseStep",
  "browsePress",
  "loadSelected",
]);

export function parseMidiBytes(bytes: readonly number[]): ParsedMidi | null {
  if (bytes.length < 2) return null;
  const status = bytes[0] & 0xff;
  if (status < 0x80 || status >= 0xf0) return null;
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const data = bytes[1] & 0x7f;
  const raw = bytes.length > 2 ? bytes[2] & 0x7f : 0;
  if (command === 0x90) {
    return { kind: "note", channel, data, value: raw, pressed: raw > 0 };
  }
  if (command === 0x80) {
    return { kind: "note", channel, data, value: 0, pressed: false };
  }
  if (command === 0xb0) {
    return { kind: "cc", channel, data, value: raw, pressed: raw > 0 };
  }
  return null;
}

/** Reloop 一类控制器的按键灯和按键共用 Note。软件回灯若被当成按键，STEM 层会立刻弹回 EQ。 */
export const MIDI_ECHO_WINDOW_MS = 80;

export class MidiEchoGuard {
  private sent: { key: string; at: number }[] = [];

  recordOutput(bytes: readonly number[], now = MidiEchoGuard.now()): void {
    const parsed = parseMidiBytes(bytes);
    if (!parsed || parsed.kind !== "note") return;
    this.prune(now);
    this.sent.push({ key: MidiEchoGuard.key(parsed), at: now });
  }

  isEcho(parsed: ParsedMidi, now = MidiEchoGuard.now()): boolean {
    if (parsed.kind !== "note") return false;
    this.prune(now);
    const key = MidiEchoGuard.key(parsed);
    const index = this.sent.findIndex((item) => item.key === key);
    if (index < 0) return false;
    this.sent.splice(index, 1);
    return true;
  }

  private prune(now: number): void {
    this.sent = this.sent.filter((item) => now - item.at <= MIDI_ECHO_WINDOW_MS);
  }

  private static key(parsed: ParsedMidi): string {
    return `${parsed.kind}:${parsed.channel}:${parsed.data}:${parsed.pressed ? 1 : 0}`;
  }

  static now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }
}

export function mappingMatchesPort(mapping: MidiMapping, port: string): boolean {
  const name = port.trim().toLowerCase();
  if (!name) return false;
  return mapping.match.portContains.some((token) => name.includes(token.trim().toLowerCase()));
}

export function decodeMidiValue(value: number, map: MidiValueMap | undefined): number {
  const midi = Math.min(127, Math.max(0, Math.round(value)));
  if (map === "relative") {
    // Two's complement (01h / 7Fh) and 64-centered (41h / 3Fh) both appear on Reloop platters.
    // Treat 64 as stopped; values near 64 as 64-centered; the 01h/7Fh extremes as two's complement.
    if (midi === 0 || midi === 64) return 0;
    if (Math.abs(midi - 64) <= 32) return midi - 64;
    return midi < 64 ? midi : midi - 128;
  }
  if (map === "bipolar") {
    if (midi <= 64) return (midi - 64) / 64;
    return (midi - 64) / 63;
  }
  return midi / 127;
}

/** 把 0..1 的 MIDI 行程映射到 TEMPO 量程；中位附近吸到原速。 */
export function scaleUnitToRange(unit: number, min: number, max: number): number {
  const t = Math.min(1, Math.max(0, Number.isFinite(unit) ? unit : 0.5));
  if (min < 1 && max > 1 && Math.abs(t - 0.5) <= 0.02) return 1;
  return min + t * (max - min);
}

/** 软件速率在当前量程里的推子位置；超出量程钉在 0 或 1。 */
export function scaleRangeToUnit(rate: number, min: number, max: number): number {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(rate)) return 0.5;
  return Math.min(1, Math.max(0, (rate - min) / span));
}

/**
 * 组装 14-bit CC。高分辨率 pitch 推子细动时往往只发 LSB；只听 MSB 就会
 * 卡在当前 7-bit 台阶上，看起来像“推下去就回不来”。
 */
export class MidiFourteenBit {
  private readonly slots = new Map<string, { msb: number; lsb: number }>();

  combine(
    channel: number,
    msbCc: number,
    lsbCc: number,
    which: "msb" | "lsb",
    value: number,
  ): number {
    const key = `${channel}:${msbCc}:${lsbCc}`;
    const slot = this.slots.get(key) ?? { msb: 0, lsb: 0 };
    if (which === "msb") slot.msb = value & 0x7f;
    else slot.lsb = value & 0x7f;
    this.slots.set(key, slot);
    return (slot.msb << 7) | slot.lsb;
  }
}

function invertUnit(unit: number, map: MidiValueMap | undefined): number {
  if (map === "bipolar" || map === "relative") return -unit;
  return 1 - unit;
}

/** Browser 滚动默认反转；其它动作只有显式 invert: true 才反相。 */
export function midiBindingInverts(binding: MidiBinding, actionType: MidiActionType): boolean {
  if (actionType === "browseStep") return binding.invert !== false;
  return Boolean(binding.invert);
}

function applyBindingInvert(
  unit: number,
  map: MidiValueMap | undefined,
  invert: boolean,
  actionType: MidiActionType,
): number {
  // djay 的 library rotary 未反转时 01h 往上；KDJ 列表 01h 默认往下。
  // 所以 Browser 的「反转」开启时保持 01h=+1，关掉才取反。
  if (actionType === "browseStep") return invert ? unit : invertUnit(unit, map);
  return invert ? invertUnit(unit, map) : unit;
}

function bindingMatches(binding: MidiBinding, parsed: ParsedMidi): boolean {
  if (binding.kind !== parsed.kind || binding.channel !== parsed.channel) return false;
  return parsed.data === binding.data || (binding.lsb != null && parsed.data === binding.lsb);
}

function decodeBindingValue(
  binding: MidiBinding,
  parsed: ParsedMidi,
  spec: MidiActionSpec,
  fourteenBit: MidiFourteenBit | undefined,
): number {
  const map = actionValueMap(spec, binding);
  let unit: number;
  if (
    parsed.kind === "cc"
    && binding.lsb != null
    && fourteenBit
    && (parsed.data === binding.data || parsed.data === binding.lsb)
  ) {
    const raw = fourteenBit.combine(
      parsed.channel,
      binding.data,
      binding.lsb,
      parsed.data === binding.lsb ? "lsb" : "msb",
      parsed.value,
    );
    const span = binding.max != null && binding.max > 0 ? binding.max : 16383;
    unit = Math.min(1, Math.max(0, raw / span));
    if (map === "bipolar") unit = unit * 2 - 1;
  } else {
    unit = decodeMidiValue(parsed.value, map);
  }
  return applyBindingInvert(unit, map, midiBindingInverts(binding, spec.type), spec.type);
}

function actionValueMap(action: MidiActionSpec, binding: MidiBinding): MidiValueMap | undefined {
  if (action.value) return action.value;
  if (
    action.type === "loopSize"
    || action.type === "jog"
    || action.type === "scratch"
    || action.type === "jogSeek"
    || action.type === "browseStep"
  ) {
    return "relative";
  }
  if (binding.kind === "note") return undefined;
  if (
    action.type === "eqHigh"
    || action.type === "eqMid"
    || action.type === "eqLow"
    || action.type === "filter"
    || action.type === "gain"
    || action.type === "crossfader"
    || action.type === "stemGain"
  ) {
    return "bipolar";
  }
  if (action.type === "volume" || action.type === "master" || action.type === "tempo") {
    return "unipolar";
  }
  return undefined;
}

function edgeFor(binding: MidiBinding): "press" | "release" | "all" {
  if (binding.edge) return binding.edge;
  return binding.kind === "note" ? "press" : "all";
}

function layerAllows(action: MidiActionSpec, layers: MidiLayerState, deck: MidiDeck | undefined): boolean {
  if (action.when?.eqStem) {
    const side = deck ?? 0;
    if (layers.eqStem[side] !== action.when.eqStem) return false;
  }
  if (action.when?.shift != null && Boolean(layers.shift) !== action.when.shift) return false;
  return true;
}

function resolveAction(
  spec: MidiActionSpec,
  mapped: number,
): MidiResolvedAction | null {
  const deck = spec.deck;
  switch (spec.type) {
    case "playToggle":
    case "cue":
    case "sync":
    case "loopToggle":
    case "toggleEqStem":
      return deck === 0 || deck === 1 ? { type: spec.type, deck } : null;
    case "toggleCrossfader":
      return { type: "toggleCrossfader" };
    case "shiftHold":
      return { type: "shiftHold", held: mapped > 0 };
    case "jogTouch":
    case "scratchTouch":
      return deck === 0 || deck === 1 ? { type: spec.type, deck, held: mapped > 0 } : null;
    case "browsePress":
      return { type: "browsePress" };
    case "loadSelected":
      return deck === 0 || deck === 1 ? { type: "loadSelected", deck } : null;
    case "loopSize":
    case "jog":
    case "scratch":
    case "jogSeek":
      return deck === 0 || deck === 1 ? { type: spec.type, deck, delta: mapped } : null;
    case "browseStep":
      return { type: "browseStep", delta: mapped };
    case "stemGain":
      return (deck === 0 || deck === 1) && spec.stems?.length
        ? { type: "stemGain", deck, stems: spec.stems, value: mapped }
        : null;
    case "crossfader":
    case "master":
      return { type: spec.type, value: mapped };
    case "eqHigh":
    case "eqMid":
    case "eqLow":
    case "filter":
    case "gain":
    case "volume":
    case "tempo":
      return deck === 0 || deck === 1 ? { type: spec.type, deck, value: mapped } : null;
    default:
      return null;
  }
}

export function resolveMidiActions(
  mapping: MidiMapping,
  parsed: ParsedMidi,
  layers: MidiLayerState,
  fourteenBit?: MidiFourteenBit,
): MidiResolvedAction[] {
  const resolved: MidiResolvedAction[] = [];
  for (const binding of mapping.bindings) {
    if (!bindingMatches(binding, parsed)) continue;
    const edge = edgeFor(binding);
    if (edge === "press" && !parsed.pressed) continue;
    if (edge === "release" && parsed.pressed) continue;
    for (const spec of binding.actions) {
      if (!ACTION_TYPES.has(spec.type)) continue;
      if (!layerAllows(spec, layers, spec.deck)) continue;
      const mapped = decodeBindingValue(binding, parsed, spec, fourteenBit);
      const action = resolveAction(spec, mapped);
      if (action) resolved.push(action);
    }
  }
  return resolved;
}

export function toggleEqStemLayer(current: EqStemLayer): EqStemLayer {
  return current === "eq" ? "stems" : "eq";
}

export function midiFeedbackValue(feedback: MidiFeedback, from: MidiFeedbackKey, deck: MidiDeck | undefined): boolean {
  if (from === "crossfaderEnabled") return feedback.crossfaderEnabled;
  const side = deck ?? 0;
  return feedback[from][side];
}

export function collectMidiOutputs(mapping: MidiMapping, feedback: MidiFeedback): MidiOutputMessage[] {
  const outputs: MidiOutputMessage[] = [];
  for (const spec of mapping.outputs ?? []) {
    const on = spec.on ?? 127;
    const off = spec.off ?? 0;
    outputs.push({
      kind: spec.kind,
      channel: spec.channel,
      data: spec.data,
      value: midiFeedbackValue(feedback, spec.from, spec.deck) ? on : off,
    });
  }
  return outputs;
}

export function encodeMidiOutput(message: MidiOutputMessage): number[] {
  const status = (message.kind === "note" ? 0x90 : 0xb0) | (message.channel & 0x0f);
  return [status, message.data & 0x7f, message.value & 0x7f];
}

export function mappingForPort(port: string, mappings: readonly MidiMapping[]): MidiMapping | null {
  return mappings.find((mapping) => mappingMatchesPort(mapping, port)) ?? null;
}

export function dispatchMidiMessage(
  mapping: MidiMapping,
  message: { port: string; bytes: number[] },
  layers: MidiLayerState,
  fourteenBit?: MidiFourteenBit,
): MidiResolvedAction[] {
  if (!mappingMatchesPort(mapping, message.port)) return [];
  const parsed = parseMidiBytes(message.bytes);
  if (!parsed) return [];
  return resolveMidiActions(mapping, parsed, layers, fourteenBit);
}

export function isMidiMapping(value: unknown): value is MidiMapping {
  if (!value || typeof value !== "object") return false;
  const mapping = value as MidiMapping;
  return typeof mapping.name === "string"
    && Array.isArray(mapping.match?.portContains)
    && Array.isArray(mapping.bindings);
}
