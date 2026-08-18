import type { StemDebugAudioUrls } from "../types";

export type StemDebugAuditionMode = "original" | "sum" | "mix";
export type StemDebugGains = Record<string, number>;

/**
 * All model outputs share one AudioContext start time. Unlike independent HTMLMediaElements, this
 * keeps a two- or four-lane Unity sum sample-aligned for meaningful A/B and gain changes.
 */
export class StemDebugAudio {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private lanes: string[] = [];
  private originalGain: GainNode | null = null;
  private stemGains = new Map<string, GainNode>();
  private sources: AudioBufferSourceNode[] = [];
  private mode: StemDebugAuditionMode = "sum";
  private gains: StemDebugGains = {};
  private anchorPosition = 0;
  private anchorContextTime = 0;
  private playing = false;
  private generation = 0;

  constructor(private readonly onEnded: () => void) {}

  async load(urls: StemDebugAudioUrls): Promise<void> {
    await this.dispose();
    const AudioContextType = window.AudioContext;
    if (!AudioContextType) throw new Error("当前 WebView 不支持 Web Audio");
    const context = new AudioContextType();
    const entries = [["original", urls.original], ...Object.entries(urls.lanes)] as const;
    this.lanes = Object.keys(urls.lanes);
    for (const [lane, url] of entries) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${lane} 音频读取失败：HTTP ${response.status}`);
      const encoded = await response.arrayBuffer();
      this.buffers.set(lane, decodeKdjFloatWav(context, encoded));
    }
    this.context = context;
    this.originalGain = context.createGain();
    this.originalGain.connect(context.destination);
    for (const lane of this.lanes) {
      const gain = context.createGain();
      gain.connect(context.destination);
      this.stemGains.set(lane, gain);
    }
    this.applyMix(true);
  }

  get duration(): number {
    return this.buffers.get("original")?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  position(): number {
    if (!this.context || !this.playing) return this.anchorPosition;
    return Math.min(
      this.duration,
      this.anchorPosition + Math.max(0, this.context.currentTime - this.anchorContextTime),
    );
  }

  setMode(mode: StemDebugAuditionMode): void {
    this.mode = mode;
    this.applyMix(false);
  }

  setGains(gains: StemDebugGains): void {
    this.gains = gains;
    this.applyMix(false);
  }

  async play(position = this.position()): Promise<void> {
    if (!this.context || !this.buffers.size || !this.originalGain || !this.stemGains.size) {
      throw new Error("Stem 调试音频尚未载入");
    }
    await this.context.resume();
    const offset = position >= this.duration - 0.001 ? 0 : Math.max(0, position);
    this.stopSources();
    const generation = ++this.generation;
    const when = this.context.currentTime + 0.025;
    const connect = (lane: string, destination: AudioNode) => {
      const source = this.context!.createBufferSource();
      source.buffer = this.buffers.get(lane) ?? null;
      source.connect(destination);
      source.start(when, offset);
      this.sources.push(source);
      return source;
    };
    const original = connect("original", this.originalGain);
    for (const lane of this.lanes) {
      const gain = this.stemGains.get(lane);
      if (gain) connect(lane, gain);
    }
    original.onended = () => {
      if (generation !== this.generation || !this.playing) return;
      this.playing = false;
      this.anchorPosition = this.duration;
      this.onEnded();
    };
    this.anchorPosition = offset;
    this.anchorContextTime = when;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.anchorPosition = this.position();
    this.playing = false;
    this.generation += 1;
    this.stopSources();
  }

  async seek(position: number): Promise<void> {
    const next = Math.max(0, Math.min(this.duration, position));
    const resume = this.playing;
    this.pause();
    this.anchorPosition = next;
    if (resume) await this.play(next);
  }

  async dispose(): Promise<void> {
    this.playing = false;
    this.generation += 1;
    this.stopSources();
    const context = this.context;
    this.context = null;
    this.buffers.clear();
    this.lanes = [];
    this.originalGain = null;
    this.stemGains.clear();
    this.anchorPosition = 0;
    if (context && context.state !== "closed") await context.close();
  }

  private stopSources(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source can already have reached its natural end.
      }
      source.disconnect();
    }
    this.sources = [];
  }

  private applyMix(immediate: boolean): void {
    if (!this.context || !this.originalGain || !this.stemGains.size) return;
    const now = this.context.currentTime;
    const set = (node: GainNode, value: number) => {
      node.gain.cancelScheduledValues(now);
      if (immediate) node.gain.setValueAtTime(value, now);
      else node.gain.setTargetAtTime(value, now, 0.008);
    };
    set(this.originalGain, this.mode === "original" ? 1 : 0);
    for (const lane of this.lanes) {
      const node = this.stemGains.get(lane);
      if (!node) continue;
      const value = this.mode === "original" ? 0 : this.mode === "sum" ? 1 : this.gains[lane] ?? 1;
      set(node, value);
    }
  }
}

function decodeKdjFloatWav(context: AudioContext, encoded: ArrayBuffer): AudioBuffer {
  const view = new DataView(encoded);
  const tag = (offset: number) => String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
  if (encoded.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("Stem 调试 WAV 头无效");
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let format = 0;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= encoded.byteLength) {
    const chunk = tag(offset);
    const bytes = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + bytes > encoded.byteLength) break;
    if (chunk === "fmt " && bytes >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (chunk === "data") {
      dataOffset = body;
      dataBytes = bytes;
      break;
    }
    offset = body + bytes + (bytes & 1);
  }
  if (format !== 3 || channels !== 2 || bits !== 32 || !sampleRate || !dataOffset) {
    throw new Error("Stem 调试 WAV 不是 44.1 kHz stereo float32");
  }
  const frames = Math.floor(dataBytes / (channels * 4));
  const buffer = context.createBuffer(channels, frames, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let frame = 0; frame < frames; frame += 1) {
    const base = dataOffset + frame * 8;
    left[frame] = view.getFloat32(base, true);
    right[frame] = view.getFloat32(base + 4, true);
  }
  return buffer;
}
