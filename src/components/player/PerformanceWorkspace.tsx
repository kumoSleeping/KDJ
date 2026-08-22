import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, CircleDot, Lock, LockOpen, Mic, Minus, Pause, Play, Plus, Repeat2 } from "lucide-react";
import {
  channelFaderGain,
  crossfaderChannelGains,
  HOT_CUE_COLORS,
  HOT_CUE_PAD_COUNT,
  removeHotCue,
  scratchPosition,
  snapCueSeconds,
  updateHotCueComment,
  upsertHotCue,
} from "../../lib/performanceCues";
import { api } from "../../lib/api";
import { camelotColor, parseCamelot } from "../../lib/camelot";
import { formatDuration } from "../../lib/format";
import {
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_DECK_DROP_EVENT,
  TRACK_DECK_DROP_TARGET_ATTR,
  TRACK_DECK_SPLIT_DROP_TARGET,
  TRACK_SAMPLER_DROP_EVENT,
  TRACK_SAMPLER_DROP_TARGET_ATTR,
  type TrackDeckDropDetail,
  type TrackSamplerDropDetail,
} from "../../lib/trackDrag";
import type {
  CuePoint,
  StemRuntimeStatus,
  StemMode,
  StemName,
  Track,
  TrackStemStatus,
  Waveform as WaveformData,
} from "../../types";
import { stemModeUsesTwoLanes } from "../../lib/stemMode";
import {
  detailWaveformBuckets,
  performanceWaveformViewportSeconds,
  waveformPointerSeconds,
} from "../../lib/waveformViewport";
import {
  ORIGINAL_WAVE_BIT,
  STEM_WAVE_BITS,
  VOCAL_WAVE_BIT,
  PERFORMANCE_WAVE_DISPLAY_STORAGE_KEY,
  performanceStemLanesVisible,
  readPerformanceWaveMask,
} from "../../lib/performanceWaveDisplay";
import { useDjConfig } from "../../lib/djMix";
import { getLiveDeckSpectrum, type UnifiedDeckSyncRequest } from "../../lib/unifiedPlayer";
import {
  EQ_GRAPH_BAND_COUNT,
  EQ_GRAPH_FREQUENCIES,
  eqCurveDbAtRatio,
  eqDbToGraphRatio,
  eqGestureWeights,
  eqSpectrumLevelToRatio,
  type EqGraphValues,
} from "../../lib/eqGraph";
import {
  ENGINE_TEMPO_MAX,
  ENGINE_TEMPO_MIN,
  crossfaderTempoPlan,
  deckSyncRate,
  linkedDeckRates,
  shouldQuantizeSyncOnPlay,
  scratchSnappedPosition,
} from "../../lib/beatGridSync";
import { LatestTempoCommandLane, TEMPO_COMMAND_INTERVAL_MS } from "../../lib/tempoCommandLane";
import {
  cachedWaveform,
  loadWaveformForTrack,
  streamWaveformSnapshot,
  subscribeStreamWaveform,
} from "../../lib/waveformCache";
import { isStreamTrack, mediaUrlForTrack } from "../../lib/streamTrack";
import { Waveform, type SeekDetail } from "../library/Waveform";
import type { EqStemLayer, MidiFeedback, MidiLayerState, MidiMapping, MidiResolvedAction } from "../../lib/midi/mapping";
import { MIDI_PRESETS } from "../../lib/midi/presets";
import { mappingForPort, dispatchMidiMessage, MidiEchoGuard, MidiFourteenBit, parseMidiBytes, scaleRangeToUnit, scaleUnitToRange, toggleEqStemLayer } from "../../lib/midi/mapping";
import { SOFT_TAKEOVER_THRESHOLD, SoftTakeover } from "../../lib/midi/softTakeover";
import { selectMappedPort, sendMidiOutputs, subscribeMidi } from "../../lib/midi/runtime";
import { MIDI_BROWSE_EVENT } from "../../lib/midiLibraryNav";
import {
  clampJogPosition,
  midiJogCursorPosition,
  midiJogNudgeAmount,
  midiJogSeekSeconds,
  midiJogVinylSeconds,
} from "../../lib/midiJog";
import { localLibraryDataTrackId, usesLocalLibraryRecord } from "../../lib/playbackTrackSource";
import { stemEqToGain } from "../../lib/stemEq";
import { knobBias, snapKnobToCenter } from "../../lib/stemDeckLog";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";

type TempoRangeId = "6" | "10" | "16" | "wide";

const TEMPO_RANGES: ReadonlyArray<{ id: TempoRangeId; label: string; min: number; max: number }> = [
  { id: "6", label: "±6%", min: 0.94, max: 1.06 },
  { id: "10", label: "±10%", min: 0.9, max: 1.1 },
  { id: "16", label: "±16%", min: 0.84, max: 1.16 },
  // WIDE intentionally is not symmetric around 1.0: it exposes the entire engine-safe range.
  { id: "wide", label: "WIDE", min: 0.5, max: 2 },
];
const TEMPO_RANGE_STORAGE_KEY = "kd-performance-tempo-ranges-v1";
const TEMPO_STEP = 0.001;
// A streamed seek needs a small initial output cushion. Sending another target before that
// cushion exists simply cancels the last worker, so keep hardware jog seeks deliberately bounded.
const MIDI_JOG_SEEK_INTERVAL_MS = 80;

function deckTempoRange(side: 0 | 1): { id: TempoRangeId; label: string; min: number; max: number } {
  const id = readTempoRanges()[side];
  return TEMPO_RANGES.find((item) => item.id === id) ?? TEMPO_RANGES[1];
}

function readTempoRanges(): [TempoRangeId, TempoRangeId] {
  const fallback: [TempoRangeId, TempoRangeId] = ["10", "10"];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TEMPO_RANGE_STORAGE_KEY) ?? "null");
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && parsed.every((value) => TEMPO_RANGES.some((range) => range.id === value))
    ) {
      return [parsed[0] as TempoRangeId, parsed[1] as TempoRangeId];
    }
  } catch {
    // A corrupt local preference must not prevent the Deck from mounting.
  }
  return fallback;
}

export interface PerformanceDeckModel {
  track: Track | null;
  position: number;
  duration: number;
  active: boolean;
  playing: boolean;
  /** Post-EQ peak in linear full scale; values >= 1 indicate clipping. */
  peakLevel: number;
  rate: number;
  cover: string;
  /** 引擎级无缝循环窗口（曲目秒）；null 表示线性播放。 */
  loopStart: number | null;
  loopLength: number | null;
}

export interface PerformanceMixerValues {
  gain: number;
  high: number;
  mid: number;
  low: number;
  filter: number;
  volume: number;
}

export interface PerformanceDeckFx {
  echo: number;
  echoParameter: number;
  reverb: number;
  reverbParameter: number;
  gater: number;
  gaterParameter: number;
  pad: number;
  beatSeconds: number;
}

/** 每轨增益顺序与引擎 `StemKind::index` 一致：drums, bass, other, vocals。 */
export type PerformanceStemGains = [number, number, number, number];

export interface PerformanceStemDeckModel {
  status: TrackStemStatus | null;
  enabled: boolean;
  mask: number;
  gains: PerformanceStemGains;
}

export interface PerformanceWorkspaceProps {
  decks: [PerformanceDeckModel, PerformanceDeckModel];
  stems: [PerformanceStemDeckModel, PerformanceStemDeckModel];
  stemRuntime: StemRuntimeStatus | null;
  stemMode: StemMode;
  masterVolume: number;
  onSeek: (side: 0 | 1, detail: Omit<SeekDetail, "trackId">) => void;
  /** Hardware jog seeks must stay on an already installed physical Deck. */
  onJogSeek: (side: 0 | 1, position: number) => void;
  /** Edge rotation: transient pitch bend, never a source reload or persistent TEMPO change. */
  onJogNudge: (side: 0 | 1, amount: number) => void;
  /** Held platter motion in track seconds; must be applied immediately, not coalesced until note-off. */
  onJogScratchTick: (side: 0 | 1, delta: number) => void;
  /** Capacitive Jog touch pauses a playing physical Deck without loading/focusing it. */
  onJogScratchStart: (side: 0 | 1) => void;
  /** Release applies the final platter position, then resumes only a Deck that touch had paused. */
  onJogScratchRelease: (side: 0 | 1, position: number | null) => void;
  /** Pointer/keyboard scratch release mirrors a physical platter: seek once, then restore only
   * the transport state that this gesture held. */
  onScratchRelease: (side: 0 | 1, position: number, resume: boolean) => void;
  /** Starts a momentary callback hold; it must not mutate Play/Pause transport state. */
  onScratchHold: (side: 0 | 1) => void;
  onTrackDrop: (side: 0 | 1, ids: number[]) => void;
  onTogglePlay: (side: 0 | 1) => void;
  onMainCue: (side: 0 | 1, position: number) => void;
  onRateChange: (side: 0 | 1, rate: number) => boolean | Promise<boolean>;
  onRatePairChange: (rates: [number, number]) => boolean | Promise<boolean>;
  onSync: (request: UnifiedDeckSyncRequest) => boolean | Promise<boolean>;
  onMixerChange: (
    side: 0 | 1,
    values: PerformanceMixerValues,
    channelGain: number,
  ) => void;
  onDeckFx: (side: 0 | 1, fx: PerformanceDeckFx) => void;
  onMasterVolumeChange: (volume: number) => void;
  onEnsureStemWaveScan?: (side: 0 | 1) => void;
  onReleaseStemWaveScan?: (trackId: number) => void;
  onStemWaveMaskChange?: (mask: number) => void;
  onToggleStemAll: (side: 0 | 1) => void;
  onStemGain: (side: 0 | 1, stem: StemName, value: number) => void;
  onSetLoop: (side: 0 | 1, start: number, length: number) => void;
  onClearLoop: (side: 0 | 1) => void;
  onSaveCuePoints: (track: Track, cues: CuePoint[]) => Promise<void>;
  onSaveMainCue: (track: Track, cueMs: number) => Promise<void>;
}

const MIXER_STORAGE_KEY = "kd-performance-mixer-v2";
const LOOP_BEATS_STORAGE_KEY = "kd-performance-loop-beats-v1";
const JUMP_BEATS_STORAGE_KEY = "kd-performance-jump-beats-v1";
const CROSSFADER_ENABLED_STORAGE_KEY = "kd-performance-crossfader-enabled-v1";
const SAMPLER_STORAGE_KEY = "kd-performance-sampler-slots-v1";
type FxPanelMode = "knobs" | "pads" | "sampler";
type DeckPadPage = "cue" | "loop" | "fx";
type FxKind = "echo" | "reverb" | "gater" | "vocal";
type FxSlot = { kind: FxKind; parameter: number; wet: number; enabled: boolean };
type DeckFxSlots = [FxSlot, FxSlot, FxSlot];
const PAD_FX_LABELS = [
  "ECHO 1/8", "ECHO 1/4", "REV SHORT", "REV LONG",
  "GATE 1/8", "GATE 1/16", "LP SWEEP", "HP SWEEP",
] as const;

function defaultDeckFxSlots(): DeckFxSlots {
  return [
    { kind: "echo", parameter: 0.5, wet: 0.35, enabled: false },
    { kind: "reverb", parameter: 0.5, wet: 0.3, enabled: false },
    { kind: "vocal", parameter: 0.5, wet: 1, enabled: false },
  ];
}

function readSamplerSlotIds(): Array<number | null> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAMPLER_STORAGE_KEY) ?? "null");
    if (!Array.isArray(parsed)) return Array(8).fill(null);
    return Array.from({ length: 8 }, (_, index) => {
      const value = parsed[index];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    });
  } catch {
    return Array(8).fill(null);
  }
}

interface StemWaveCursor {
  trackId: number | null;
  epoch: number | null;
  revision: number;
}

function emptyLiveStemWaveform(
  trackId: number,
  duration: number,
  columns: number,
  analysisStart: number,
  analysisFrontier: number,
  analysisBackFrontier: number,
): WaveformData {
  return {
    track_id: trackId,
    duration,
    amp: new Array<number>(columns).fill(0),
    // Unknown columns remain empty. Their eventual RGB values come from the actual separated
    // audio block, rather than borrowing either the original mix or a fixed STEM label colour.
    r: new Array<number>(columns).fill(31),
    g: new Array<number>(columns).fill(31),
    b: new Array<number>(columns).fill(31),
    known: new Array<boolean>(columns).fill(false),
    analysis_start: analysisStart,
    analysis_frontier: analysisFrontier,
    analysis_back_frontier: analysisBackFrontier,
  };
}

const DEFAULT_MIXER: PerformanceMixerValues = {
  gain: 0,
  high: 0,
  mid: 0,
  low: 0,
  filter: 0,
  volume: 1,
};

function readMixer(): [PerformanceMixerValues, PerformanceMixerValues] {
  try {
    const value = JSON.parse(localStorage.getItem(MIXER_STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(value) && value.length === 2) {
      return value.map((item) => ({ ...DEFAULT_MIXER, ...(item as object) })) as [
        PerformanceMixerValues,
        PerformanceMixerValues,
      ];
    }
  } catch {
    // 坏存档回到中性参数。
  }
  return [{ ...DEFAULT_MIXER }, { ...DEFAULT_MIXER }];
}

function readCrossfaderEnabled(): boolean {
  try {
    const value = JSON.parse(localStorage.getItem(CROSSFADER_ENABLED_STORAGE_KEY) ?? "null") as unknown;
    if (typeof value === "boolean") return value;
  } catch {
    // 坏存档默认打开横推。
  }
  return true;
}

const LOOP_BEAT_CHOICES = [0.25, 0.5, 1, 2, 4, 8, 16, 32];

function nextLoopBeats(current: number, delta: number): number {
  if (!delta) return current;
  const index = LOOP_BEAT_CHOICES.indexOf(current);
  const start = index < 0 ? LOOP_BEAT_CHOICES.indexOf(8) : index;
  return LOOP_BEAT_CHOICES[clamp(start + Math.sign(delta), 0, LOOP_BEAT_CHOICES.length - 1)];
}

function readLoopBeats(): [number, number] {
  try {
    const value = JSON.parse(localStorage.getItem(LOOP_BEATS_STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(value) && value.length === 2) {
      const beats = value.map((item) =>
        LOOP_BEAT_CHOICES.includes(item as number) ? (item as number) : 8,
      );
      return [beats[0], beats[1]];
    }
  } catch {
    // 坏存档回到 8 拍。
  }
  return [8, 8];
}

function readJumpBeats(): [number, number] {
  try {
    const value = JSON.parse(localStorage.getItem(JUMP_BEATS_STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(value) && value.length === 2) {
      const beats = value.map((item) =>
        LOOP_BEAT_CHOICES.includes(item as number) ? (item as number) : 16,
      );
      return [beats[0], beats[1]];
    }
  } catch {
    // 坏存档回到 16 拍。
  }
  return [16, 16];
}

function formatBeatChoice(beats: number): string {
  return beats < 1 ? "1/" + Math.round(1 / beats) : String(beats);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function deckCues(track: Track | null): CuePoint[] {
  return track?.cue_points ? [...track.cue_points] : [];
}

function deckKey(track: Track | null): string {
  return track?.camelot || track?.music_key || "—";
}

function beatSeconds(track: Track | null): number | null {
  return track?.bpm ? 60 / track.bpm : null;
}

type StemOption = {
  stem: StemName;
  label: string;
  short: string;
  shortcut: string;
  bit: number;
  gainIndex: 0 | 1 | 2 | 3;
  icon: typeof Mic;
};

const TWO_STEM_OPTIONS: StemOption[] = [
  { stem: "vocals", label: "VOCALS", short: "V", shortcut: "V", bit: STEM_WAVE_BITS.vocals, gainIndex: 3, icon: Mic },
];

function stemOptions(mode: StemMode): StemOption[] {
  return stemModeUsesTwoLanes(mode) ? TWO_STEM_OPTIONS : [];
}

/** 低于这个幅度就当作底噪留空（后端 amp 已归一化到 0..1）。 */
const STEM_SILENCE_THRESHOLD = 0.06;
/** 人声静音时仍作为结构引导线可见；音频增益与波形透明度不是同一语义。 */
const VOCAL_WAVEFORM_MIN_OPACITY = 0.4;

/** 主轨道（ORG）波形；显示开关与四条 STEM 车道完全独立。 */
function useMainWaveform(track: Track | null, buckets: number): WaveformData | null {
  const trackId = track?.id ?? null;
  const [wave, setWave] = useState<WaveformData | null>(() => (
    trackId !== null
      ? cachedWaveform(trackId, buckets) ?? cachedWaveform(trackId, Math.min(640, buckets))
      : null
  ));
  useEffect(() => {
    if (trackId === null || !track) {
      setWave(null);
      return;
    }
    if (isStreamTrack(track)) {
      const sync = () => setWave(streamWaveformSnapshot(trackId)?.waveform ?? null);
      sync();
      return subscribeStreamWaveform(trackId, sync);
    }
    let alive = true;
    let detailTimer: number | null = null;
    const previewBuckets = Math.min(640, buckets);
    const detailed = cachedWaveform(trackId, buckets);
    const preview = detailed ?? cachedWaveform(trackId, previewBuckets);
    setWave(preview);
    const loadDetail = () => {
      detailTimer = null;
      void loadWaveformForTrack(track, buckets)
        .then((loaded) => { if (alive) setWave(loaded); })
        .catch(() => { /* 主波形不可得时留空，下一次换歌会重试。 */ });
    };
    if (detailed) return () => { alive = false; };
    if (!preview) {
      void loadWaveformForTrack(track, previewBuckets)
        .then((loaded) => {
          if (!alive) return;
          setWave(loaded);
          if (buckets > previewBuckets) detailTimer = window.setTimeout(loadDetail, 750);
        })
        .catch(() => { /* 下一次换歌重试。 */ });
    } else if (buckets > previewBuckets) {
      detailTimer = window.setTimeout(loadDetail, 750);
    }
    return () => {
      alive = false;
      if (detailTimer !== null) window.clearTimeout(detailTimer);
    };
  }, [buckets, track?.source_key, trackId]);
  return wave;
}

function DeckScratchSurface({
  deck,
  other,
  side,
  autoBeatSync,
  syncMultiple,
  onSeek,
  onScratchHold,
  onScratchRelease,
  onScratchPreview,
  onScratchTick,
  onTrackDrop,
}: {
  deck: PerformanceDeckModel;
  other: PerformanceDeckModel;
  side: 0 | 1;
  autoBeatSync: boolean;
  syncMultiple: number;
  onSeek: PerformanceWorkspaceProps["onSeek"];
  onScratchHold: PerformanceWorkspaceProps["onScratchHold"];
  onScratchRelease: PerformanceWorkspaceProps["onScratchRelease"];
  onScratchPreview: (side: 0 | 1, position: number | null) => void;
  onScratchTick?: (side: 0 | 1, delta: number) => void;
  onTrackDrop: PerformanceWorkspaceProps["onTrackDrop"];
}) {
  const track = deck.track;
  const viewportSeconds = performanceWaveformViewportSeconds(deck.rate);
  const scratchAtRef = useRef<number | null>(null);
  const scratchRef = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    startPosition: number;
    playhead: number;
    didScratch: boolean;
    resumeOnRelease: boolean;
  } | null>(null);

  useEffect(() => {
    scratchRef.current = null;
    scratchAtRef.current = null;
    onScratchPreview(side, null);
  }, [onScratchPreview, side, track?.id]);
  useEffect(() => {
    const preview = scratchAtRef.current;
    if (scratchRef.current || preview === null) return;
    if (Math.abs(deck.position - preview) < 0.08) {
      scratchAtRef.current = null;
      onScratchPreview(side, null);
    }
  }, [deck.position, onScratchPreview, side]);
  useEffect(
    () => () => onScratchPreview(side, null),
    [onScratchPreview, side],
  );

  const snapScratch = (raw: number, hard: boolean) => {
    const self = deck.track;
    const counterpart = other.track;
    if (
      !autoBeatSync
      || !self?.bpm
      || !counterpart?.bpm
      || self.first_beat == null
      || counterpart.first_beat == null
    ) {
      return raw;
    }
    return scratchSnappedPosition({
      followerPositionSec: raw,
      followerBpm: self.bpm,
      followerFirstBeatSec: self.first_beat,
      followerRate: deck.rate,
      masterPositionSec: other.position,
      masterBpm: counterpart.bpm,
      masterFirstBeatSec: counterpart.first_beat,
      masterRate: other.rate,
      multiple: syncMultiple,
      hard,
    });
  };

  const finishScratch = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = scratchRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const at = snapScratch(scratchAtRef.current ?? gesture.startPosition, true);
    scratchAtRef.current = at;
    scratchRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit may release capture before pointercancel reaches React.
    }
    if (gesture.didScratch) {
      onScratchRelease(side, at, gesture.resumeOnRelease);
    } else {
      onSeek(side, { position: at, forceCommit: true });
    }
  };

  if (!track) return null;
  return (
    <div
      className="kd-performance-scratch"
      data-side={side === 0 ? "a" : "b"}
      role="slider"
      tabIndex={0}
      aria-label={`${side === 0 ? "A" : "B"} Deck 波形，点击跳转，拖动刮擦`}
      aria-valuemin={0}
      aria-valuemax={deck.duration}
      aria-valuenow={scratchAtRef.current ?? deck.position}
      {...{ [TRACK_DECK_DROP_TARGET_ATTR]: String(side) }}
      onDragOver={(event) => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        event.currentTarget.dataset.kdNativeTrackOver = "true";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          delete event.currentTarget.dataset.kdNativeTrackOver;
        }
      }}
      onDrop={(event) => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        const ids = readTrackDragIds(event.dataTransfer);
        delete event.currentTarget.dataset.kdNativeTrackOver;
        finishTrackDrop();
        if (ids.length) onTrackDrop(side, ids);
      }}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const at = snapScratch(
          waveformPointerSeconds(
            event.clientX,
            rect.left,
            rect.width,
            deck.duration,
            deck.position,
            viewportSeconds,
          ),
          false,
        );
        scratchRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          width: rect.width,
          startPosition: at,
          playhead: deck.position,
          didScratch: false,
          resumeOnRelease: deck.playing,
        };
        scratchAtRef.current = at;
        onScratchPreview(side, at);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const gesture = scratchRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        if (!gesture.didScratch && Math.abs(event.clientX - gesture.startX) >= 6) {
          gesture.didScratch = true;
          onScratchHold(side);
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const raw = gesture.didScratch
          ? scratchPosition(
              gesture.startPosition,
              event.clientX - gesture.startX,
              gesture.width,
              viewportSeconds,
              deck.duration,
            )
          : waveformPointerSeconds(
              event.clientX,
              rect.left,
              rect.width,
              deck.duration,
              gesture.playhead,
              viewportSeconds,
            );
        const previous = scratchAtRef.current;
        const at = snapScratch(raw, false);
        scratchAtRef.current = at;
        onScratchPreview(side, at);
        if (gesture.didScratch && onScratchTick) {
          const delta = at - (previous ?? at);
          if (delta !== 0) onScratchTick(side, delta);
        }
      }}
      onPointerUp={finishScratch}
      onPointerCancel={finishScratch}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? -0.1 : 0.1;
        const at = clamp(deck.position + delta, 0, deck.duration);
        const resumeOnRelease = deck.playing;
        onScratchHold(side);
        onScratchRelease(side, at, resumeOnRelease);
      }}
    />
  );
}

function WaveDisplayMenu({ vocalVisible, onToggleVocal }: {
  vocalVisible: boolean;
  onToggleVocal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);
  return (
    <div
      ref={rootRef}
      className="kd-performance-wave-menu"
      data-open={open || undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="kd-performance-wave-menu-trigger"
        aria-label="波形显示"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open ? (
        <div className="kd-performance-wave-menu-popover" role="menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={vocalVisible}
            data-active={vocalVisible || undefined}
            onClick={() => { onToggleVocal(); setOpen(false); }}
          >
            人声波形
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DeckWave({
  deck,
  side,
  position,
  waveform,
  interactiveScrub,
  snapRail,
  onTrackDrop,
  cornerControl,
}: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  position: number;
  waveform: WaveformData | null;
  interactiveScrub: boolean;
  snapRail: boolean;
  onTrackDrop: PerformanceWorkspaceProps["onTrackDrop"];
  cornerControl?: ReactNode;
}) {
  const track = deck.track;
  const dropTarget = { [TRACK_DECK_DROP_TARGET_ATTR]: String(side) };
  return (
    <div
      className="kd-performance-wave-row"
      data-side={side === 0 ? "a" : "b"}
      data-playing={deck.playing || undefined}
      data-kd-performance-wave-lane="org"
      {...dropTarget}
      onDragOver={(event) => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        event.currentTarget.dataset.kdNativeTrackOver = "true";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          delete event.currentTarget.dataset.kdNativeTrackOver;
        }
      }}
      onDrop={(event) => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        const ids = readTrackDragIds(event.dataTransfer);
        delete event.currentTarget.dataset.kdNativeTrackOver;
        finishTrackDrop();
        if (ids.length) onTrackDrop(side, ids);
      }}
    >
      {!track ? <span className="kd-performance-wave-empty" /> : null}
      {track && waveform ? (
        <Waveform
          className="kd-performance-focus-wave"
          trackId={track.id}
          track={track}
          position={position}
          duration={deck.duration || track.duration || 0}
          cueMs={track.cue_ms}
          endMs={track.end_ms}
          cuePoints={track.cue_points}
          loopStart={deck.loopStart}
          loopLength={deck.loopLength}
          height={50}
          seekable={false}
          showBeatGrid
          viewportSeconds={performanceWaveformViewportSeconds(deck.rate)}
          playing={deck.playing}
          playbackRate={deck.rate}
          waveform={waveform}
          verticalInsetRatio={0}
          interactiveScrub={interactiveScrub}
          snapRail={snapRail}
        />
      ) : null}
      {cornerControl}
    </div>
  );
}

function StemWaveLanes({
  displayMask,
  stemMode,
  track,
  position,
  duration,
  rate,
  playing,
  interactiveScrub,
  snapRail,
  sources,
}: {
  displayMask: number;
  stemMode: StemMode;
  track: Track | null;
  position: number;
  duration: number;
  rate: number;
  playing: boolean;
  interactiveScrub: boolean;
  snapRail: boolean;
  sources: ReadonlyMap<StemName, { waveform: WaveformData | null; placeholder: WaveformData | null; opacity: number }>;
}) {
  // 车道数量只由用户按键决定。波形响应到达前保留同高空槽，加载/换歌不会把
  // STEM 区先清零再逐条撑开。
  const visibleLanes = stemOptions(stemMode).filter(({ bit }) => (displayMask & bit) !== 0);
  if (visibleLanes.length === 0) return null;
  return (
    <div className="kd-performance-stem-lanes">
      {visibleLanes.map(({ stem, label }) => (
          <div
            className="kd-performance-stem-lane"
            key={stem}
            data-stem={stem}
            data-kd-performance-wave-lane={stem}
            role="img"
            aria-label={`${label} 强度`}
          >
            {track && sources.get(stem)?.waveform ? (
              <Waveform
                className="kd-performance-stem-wave"
                trackId={track.id}
                track={track}
                position={position}
                duration={duration}
                height={10}
                seekable={false}
                viewportSeconds={performanceWaveformViewportSeconds(rate)}
                playing={playing}
                playbackRate={rate}
                waveform={sources.get(stem)!.waveform!}
                placeholder={sources.get(stem)!.placeholder}
                opacity={sources.get(stem)!.opacity}
                palette={stem === "vocals" ? "vocal-guide" : "rgb"}
                silenceThreshold={STEM_SILENCE_THRESHOLD}
                verticalInsetRatio={0}
                interactiveScrub={interactiveScrub}
                snapRail={snapRail}
              />
            ) : <span className="kd-performance-stem-wave-empty" aria-hidden="true" />}
          </div>
      ))}
    </div>
  );
}

function PerformanceDeckWaves({
  deck,
  other,
  stemState,
  stemMode,
  side,
  position,
  interactiveScrub,
  snapRail,
  displayMask,
  waveforms,
  autoBeatSync,
  syncMultiple,
  onSeek,
  onScratchHold,
  onScratchRelease,
  onScratchPreview,
  onScratchTick,
  onTrackDrop,
  cornerControl,
}: {
  deck: PerformanceDeckModel;
  other: PerformanceDeckModel;
  stemState: PerformanceStemDeckModel;
  stemMode: StemMode;
  side: 0 | 1;
  position: number;
  interactiveScrub: boolean;
  snapRail: boolean;
  displayMask: number;
  waveforms: Partial<Record<StemName, WaveformData>>;
  autoBeatSync: boolean;
  syncMultiple: number;
  onSeek: PerformanceWorkspaceProps["onSeek"];
  onScratchHold: PerformanceWorkspaceProps["onScratchHold"];
  onScratchRelease: PerformanceWorkspaceProps["onScratchRelease"];
  onScratchPreview: (side: 0 | 1, position: number | null) => void;
  onScratchTick: PerformanceWorkspaceProps["onJogScratchTick"];
  onTrackDrop: PerformanceWorkspaceProps["onTrackDrop"];
  cornerControl?: ReactNode;
}) {
  const track = deck.track;
  const duration = deck.duration || track?.duration || 0;
  const buckets = detailWaveformBuckets(duration);
  const mainWaveform = useMainWaveform(track, buckets);
  const pendingWave = useMemo(
    () => (track
      ? emptyLiveStemWaveform(track.id, duration, Math.min(640, buckets), 0, 0, 0)
      : null),
    [buckets, duration, track?.id],
  );
  const stemLaneSources = useMemo(() => {
    const result = new Map<StemName, { waveform: WaveformData | null; placeholder: WaveformData | null; opacity: number }>();
    for (const { stem, bit, gainIndex } of stemOptions(stemMode)) {
      if ((displayMask & bit) === 0) continue;
      const waveform = track && waveforms[stem]?.track_id === track.id ? waveforms[stem] ?? null : null;
      const gain = !stemState.enabled
        ? 1
        : (stemState.mask & bit) !== 0
          ? clamp(stemState.gains[gainIndex] ?? 1, 0, 1)
          : 0;
      result.set(stem, {
        waveform: waveform ?? (stemState.enabled ? pendingWave : null),
        // Unknown vocal columns stay empty. Reusing the full mix here would draw a convincing
        // but false vocal band while the separator is still catching up.
        placeholder: null,
        opacity: gain >= 0.999
          ? 1
          : VOCAL_WAVEFORM_MIN_OPACITY + (1 - VOCAL_WAVEFORM_MIN_OPACITY) * gain,
      });
    }
    return result;
  }, [displayMask, mainWaveform, pendingWave, stemMode, stemState, track?.id, waveforms]);

  return (
    <div className="kd-performance-deck-waves" data-side={side === 0 ? "a" : "b"}>
      <StableDeckWave
        deck={deck}
        side={side}
        position={position}
        waveform={mainWaveform}
        interactiveScrub={interactiveScrub}
        snapRail={snapRail}
        onTrackDrop={onTrackDrop}
        cornerControl={cornerControl}
      />
      <StemWaveLanes
        displayMask={displayMask}
        stemMode={stemMode}
        track={track}
        position={position}
        duration={duration}
        rate={deck.rate}
        playing={deck.playing}
        interactiveScrub={interactiveScrub}
        snapRail={snapRail}
        sources={stemLaneSources}
      />
      <DeckScratchSurface
        deck={deck}
        other={other}
        side={side}
        autoBeatSync={autoBeatSync}
        syncMultiple={syncMultiple}
        onSeek={onSeek}
        onScratchHold={onScratchHold}
        onScratchRelease={onScratchRelease}
        onScratchPreview={onScratchPreview}
        onScratchTick={onScratchTick}
        onTrackDrop={onTrackDrop}
      />
    </div>
  );
}

function DeckTransport({ deck, side, quantize, onTogglePlay, onMainCue, onSaveMainCue }: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  quantize: boolean;
  onTogglePlay: PerformanceWorkspaceProps["onTogglePlay"];
  onMainCue: PerformanceWorkspaceProps["onMainCue"];
  onSaveMainCue: PerformanceWorkspaceProps["onSaveMainCue"];
}) {
  const track = deck.track;
  const cue = track?.cue_ms != null ? track.cue_ms / 1000 : (track?.first_beat ?? 0);
  const setMainCue = () => {
    if (!track) return;
    const at = snapCueSeconds(deck.position, track.bpm, track.first_beat, quantize);
    void onSaveMainCue(track, Math.round(at * 1000));
  };
  return (
    <div className="kd-performance-dock-transport" data-side={side === 0 ? "a" : "b"}>
      <button
        type="button"
        className="kd-performance-dock-play"
        data-active={deck.playing || undefined}
        onClick={() => onTogglePlay(side)}
        disabled={!track}
        aria-label={(side === 0 ? "A" : "B") + " 盘" + (deck.playing ? "暂停" : "播放")}
        title={deck.playing ? "暂停" : "播放"}
      >
        {deck.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button
        type="button"
        className="kd-performance-dock-cue"
        onClick={() => onMainCue(side, cue)}
        onDoubleClick={setMainCue}
        disabled={!track}
        aria-label={(side === 0 ? "A" : "B") + " 盘主 CUE"}
        title="单击跳转主 CUE，双击保存当前位置"
      >
        CUE
      </button>
    </div>
  );
}

function DeckInfo({ deck, side, preserveBarPhase, quantize, onSeek, onTogglePlay, onMainCue, onSaveMainCue }: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  preserveBarPhase: boolean;
  quantize: boolean;
  onSeek: PerformanceWorkspaceProps["onSeek"];
  onTogglePlay: PerformanceWorkspaceProps["onTogglePlay"];
  onMainCue: PerformanceWorkspaceProps["onMainCue"];
  onSaveMainCue: PerformanceWorkspaceProps["onSaveMainCue"];
}) {
  const track = deck.track;
  const keyColor = parseCamelot(track?.camelot) ? camelotColor(track?.camelot) : undefined;
  const cue = track?.cue_ms != null ? track.cue_ms / 1000 : (track?.first_beat ?? 0);
  const setMainCue = () => {
    if (!track) return;
    const at = snapCueSeconds(deck.position, track.bpm, track.first_beat, quantize);
    void onSaveMainCue(track, Math.round(at * 1000));
  };
  return (
    <section
      className="kd-performance-info"
      data-side={side === 0 ? "a" : "b"}
    >
      <span className="kd-performance-vinyl" aria-hidden="true">
        <span className="kd-performance-vinyl-record" data-spinning={deck.playing || undefined} data-empty={!track || undefined}>
          {deck.cover ? <img src={deck.cover} alt="" /> : <b className="kd-performance-platter-brand">KDJ</b>}
        </span>
      </span>
      <div className="kd-performance-overview-slot">
        {track ? (
          <Waveform
            trackId={track.id}
            track={track}
            position={deck.position}
            duration={deck.duration}
            cuePoints={track.cue_points ?? []}
            loopStart={deck.loopStart}
            loopLength={deck.loopLength}
            height={18}
            buckets={640}
            preserveBarPhase={preserveBarPhase}
            playing={deck.playing}
            playbackRate={deck.rate}
            onSeek={(detail) => onSeek(side, detail)}
            className="kd-performance-overview-wave"
            verticalInsetRatio={0.12}
          />
        ) : null}
      </div>
      <div className="kd-performance-dock-transport">
        <button
          type="button"
          className="kd-performance-dock-play"
          data-active={deck.playing || undefined}
          onClick={() => onTogglePlay(side)}
          disabled={!track}
          aria-label={`${side === 0 ? "A" : "B"} 盘${deck.playing ? "暂停" : "播放"}`}
          title={deck.playing ? "暂停" : "播放"}
        >
          {deck.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          type="button"
          className="kd-performance-dock-cue"
          onClick={() => onMainCue(side, cue)}
          onDoubleClick={setMainCue}
          disabled={!track}
          aria-label={`${side === 0 ? "A" : "B"} 盘主 CUE`}
          title="单击跳转主 CUE，双击保存当前位置"
        >
          CUE
        </button>
      </div>
      <div className="kd-performance-trackline">
        <div className="kd-performance-info-copy">
          <strong>{track?.title || track?.filename || ""}</strong>
          <span>{track?.artist || ""}</span>
        </div>
        {track ? (
          <dl className="kd-performance-metadata">
            <div data-time="true"><dt>TIME</dt><dd>{formatDuration(deck.position)}</dd></div>
            <div><dt aria-label="调性" /><dd style={keyColor ? { color: keyColor } : undefined}>{deckKey(track)}</dd></div>
          </dl>
        ) : null}
      </div>
    </section>
  );
}

function HotCuePads({ deck, side, quantize, onSeek, onSaveCuePoints }: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  quantize: boolean;
  onSeek: PerformanceWorkspaceProps["onSeek"];
  onSaveCuePoints: PerformanceWorkspaceProps["onSaveCuePoints"];
}) {
  const track = deck.track;
  const cues = deckCues(track);
  const slots = useMemo(
    () => Array.from({ length: HOT_CUE_PAD_COUNT }, (_, index) => cues.find((cue) => cue.hot_cue === index + 1) ?? null),
    [track?.id, track?.cue_points],
  );
  const [menu, setMenu] = useState<{
    slot: number;
    x: number;
    y: number;
    editing: boolean;
    draft: string;
  } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const setCue = async (slot: number) => {
    if (!track) return;
    const at = snapCueSeconds(deck.position, track.bpm, track.first_beat, quantize);
    await onSaveCuePoints(track, upsertHotCue(cues, slot, at * 1000));
  };
  const jumpTo = (slot: number) => {
    const cue = slots[slot - 1];
    if (!cue) return;
    onSeek(side, { position: cue.start_ms / 1000, forceCommit: true });
  };
  const openMenu = (event: { preventDefault: () => void; clientX: number; clientY: number }, slot: number, comment: string) => {
    event.preventDefault();
    if (!track) return;
    setMenu({
      slot,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 130),
      editing: false,
      draft: comment,
    });
  };
  return (
    <div className="kd-performance-cues">
      <span className="kd-performance-cues-bank">
        <span>
          {slots.map((cue, index) => {
            const slot = index + 1;
            const color = HOT_CUE_COLORS[index].css;
            const note = cue?.comment.trim() ?? "";
            const caption = note || (cue ? formatDuration(cue.start_ms / 1000) : "");
            if (!cue) {
              return (
                <button
                  type="button"
                  key={slot}
                  className="kd-performance-cue-slot"
                  aria-label={`设定 Hot Cue ${slot}`}
                  onClick={() => void setCue(slot)}
                  disabled={!track}
                >
                  <Plus size={14} strokeWidth={1.75} />
                </button>
              );
            }
            return (
              <div
                key={slot}
                className="kd-performance-cue-slot"
                data-filled="true"
                style={{ "--kd-pad": color } as CSSProperties}
                onContextMenu={(event) => openMenu(event, slot, cue.comment)}
              >
                <span className="kd-performance-cue-note" title={caption}>{caption}</span>
                <button
                  type="button"
                  className="kd-performance-cue-jump"
                  aria-label={`跳转到 Hot Cue ${slot}${caption ? ` ${caption}` : ""}`}
                  onClick={() => jumpTo(slot)}
                >
                  <Play size={10} fill="currentColor" strokeWidth={0} />
                </button>
              </div>
            );
          })}
        </span>
      </span>
      {menu && track ? (
        <div
          className="kd-performance-cue-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menu.editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void onSaveCuePoints(track, updateHotCueComment(cues, menu.slot, menu.draft));
                setMenu(null);
              }}
            >
              <input
                autoFocus
                value={menu.draft}
                maxLength={80}
                aria-label={`Hot Cue ${menu.slot} 备注`}
                onChange={(event) => setMenu({ ...menu, draft: event.currentTarget.value })}
              />
              <button type="submit">保存</button>
            </form>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => setMenu({ ...menu, editing: true })}>备注</button>
              <button
                type="button"
                role="menuitem"
                data-danger="true"
                onClick={() => {
                  void onSaveCuePoints(track, removeHotCue(cues, menu.slot));
                  setMenu(null);
                }}
              >删除</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** LOOP 控制：开/关 + 拍数步进 + 节拍跳转。循环窗口由引擎无缝回绕。 */
function LoopControls({ deck, side, beats, jumpBeats, quantize, onBeats, onJumpBeats, onSetLoop, onClearLoop, onSeek }: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  beats: number;
  jumpBeats: number;
  quantize: boolean;
  onBeats: (beats: number) => void;
  onJumpBeats: (beats: number) => void;
  onSetLoop: PerformanceWorkspaceProps["onSetLoop"];
  onClearLoop: PerformanceWorkspaceProps["onClearLoop"];
  onSeek: PerformanceWorkspaceProps["onSeek"];
}) {
  const track = deck.track;
  const beat = beatSeconds(track);
  const looping = deck.loopStart !== null && deck.loopLength !== null;
  const stepBeats = (direction: -1 | 1) => {
    const index = LOOP_BEAT_CHOICES.indexOf(beats);
    const next = LOOP_BEAT_CHOICES[clamp(index + direction, 0, LOOP_BEAT_CHOICES.length - 1)];
    onBeats(next);
    if (looping && deck.loopStart !== null && beat) {
      onSetLoop(side, deck.loopStart, next * beat);
    }
  };
  const toggleLoop = () => {
    if (!track || !beat) return;
    if (looping) {
      onClearLoop(side);
      return;
    }
    const start = snapCueSeconds(deck.position, track.bpm, track.first_beat, quantize);
    if (start + beats * beat > deck.duration + 0.05) return;
    onSetLoop(side, start, beats * beat);
  };
  const jump = (direction: -1 | 1) => {
    if (!track || !beat) return;
    const at = clamp(deck.position + direction * jumpBeats * beat, 0, deck.duration);
    onSeek(side, { position: at, forceCommit: true });
  };
  const stepJumpBeats = (direction: -1 | 1) => {
    onJumpBeats(nextLoopBeats(jumpBeats, direction));
  };
  return (
    <div className="kd-performance-loop" data-active={looping || undefined}>
      <span className="kd-performance-loop-stepper">
        <span>
          <button type="button" disabled={!track} aria-label="循环拍数减" onClick={() => stepBeats(-1)}>‹</button>
          <button
            type="button"
            className="kd-performance-loop-toggle"
            data-active={looping || undefined}
            disabled={!track || !beat}
            aria-label={looping ? "退出循环" : "进入循环"}
            title={beat ? `${beats} 拍循环` : "无 BPM，不能循环"}
            onClick={toggleLoop}
          >
            {beats}
          </button>
          <button type="button" disabled={!track} aria-label="循环拍数加" onClick={() => stepBeats(1)}>›</button>
        </span>
        <em>LOOP</em>
      </span>
      <span className="kd-performance-loop-jump">
        <span>
          <button type="button" disabled={!track || !beat} title={`后退 ${jumpBeats} 拍`} onClick={() => jump(-1)}>‹‹</button>
          <button type="button" disabled={!track || !beat} title={`前进 ${jumpBeats} 拍`} onClick={() => jump(1)}>››</button>
        </span>
        <span className="kd-performance-loop-jump-size">
          <button type="button" disabled={!track} aria-label="减少跳转拍数" onClick={() => stepJumpBeats(-1)}>‹</button>
          <output aria-live="polite">{formatBeatChoice(jumpBeats)} BEATS</output>
          <button type="button" disabled={!track} aria-label="增加跳转拍数" onClick={() => stepJumpBeats(1)}>›</button>
        </span>
      </span>
    </div>
  );
}

/**
 * 圆弧旋钮（djay 式）：外圈细环轨道 + 从 12 点出发随转向着色的值弧
 * （提升/衰减双色，stem 旋钮用 stem 色），内部实心圆带指针线。
 * 竖直相对拖动（1.35x 阻尼行程），滚轮/方向键微调，双击回中；
 * 取值变化后名称标签切换为百分比，3 秒无操作恢复名称。
 */
function ArcKnob({
  label,
  value,
  min = -1,
  max = 1,
  step = 0.01,
  onChange,
  onReset,
  stem,
  size = "md",
  disabled = false,
  format,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onReset?: () => void;
  stem?: StemName;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  disabled?: boolean;
  format?: (value: number) => string;
}) {
  const shown = snapKnobToCenter(value, min, max);
  const ratio = clamp((shown - min) / (max - min), 0, 1);
  const bipolar = min < 0 && max > 0;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; y: number; value: number } | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const latestRef = useRef({ min, max, step, disabled, onChange });
  latestRef.current = { min, max, step, disabled, onChange };

  // 名称 ⇄ 数值：取值变化后显示 3 秒百分比，再恢复名称。
  const [showValue, setShowValue] = useState(false);
  const revertRef = useRef(0);
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;
    setShowValue(true);
    window.clearTimeout(revertRef.current);
    revertRef.current = window.setTimeout(() => setShowValue(false), 3000);
  }, [value]);
  useEffect(() => () => window.clearTimeout(revertRef.current), []);

  const DAMPING = 1.35;
  const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (latestRef.current.disabled || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, y: event.clientY, value: shownRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = rootRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !el) return;
    event.preventDefault();
    const { min: lo, max: hi, step: st, onChange: commit } = latestRef.current;
    const travel = (drag.y - event.clientY) / (el.getBoundingClientRect().height * DAMPING);
    const raw = drag.value + travel * (hi - lo);
    const stepped = Math.round((raw - lo) / st) * st + lo;
    commit(snapKnobToCenter(clamp(Number(stepped.toFixed(6)), lo, hi), lo, hi));
  };
  const onUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit 可能在 pointercancel 前先释放捕获。
    }
  };
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { min: lo, max: hi, step: st, disabled: off, onChange: commit } = latestRef.current;
    if (off) return;
    const stride = st * (event.shiftKey ? 5 : 1);
    const delta =
      event.key === "ArrowUp" || event.key === "ArrowRight" ? stride
        : event.key === "ArrowDown" || event.key === "ArrowLeft" ? -stride : 0;
    if (delta === 0) return;
    event.preventDefault();
    commit(snapKnobToCenter(clamp(shownRef.current + delta, lo, hi), lo, hi));
  };
  // React 的 onWheel 是被动监听，preventDefault 拦不住页面滚动；滚轮微调必须原生注册。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const { min: lo, max: hi, step: st, disabled: off, onChange: commit } = latestRef.current;
      if (off) return;
      event.preventDefault();
      const raw = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      const direction = (raw < 0 ? 1 : -1) * (event.shiftKey ? 5 : 1);
      commit(snapKnobToCenter(clamp(shownRef.current + direction * st, lo, hi), lo, hi));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const bias = bipolar ? knobBias(shown, min, max) : null;
  const text = format ? format(shown) : bipolar
    ? (shown === 0 ? "0" : (shown > 0 ? "+" : "") + Math.round(shown * 100).toString())
    : Math.round(ratio * 100).toString();

  // 几何：viewBox 48，圆心 (24,24)，轨道半径 19，270° 环缺口朝下。
  const R = 19;
  const CIRC = 2 * Math.PI * R;
  const TRACK = 0.75 * CIRC;
  let arcLen = 0;
  let arcRotate = 135;
  if (bipolar) {
    const halfRange = shown >= 0 ? max : Math.abs(min);
    const span = halfRange > 0 ? (Math.abs(shown) / halfRange) * 135 : 0;
    arcLen = (span / 360) * CIRC;
    arcRotate = shown >= 0 ? 270 : 270 - span;
  } else {
    arcLen = ratio * TRACK;
    arcRotate = 135;
  }
  const needle = -135 + ratio * 270;

  return (
    <div
      ref={rootRef}
      className="kd-dj-arcknob"
      data-size={size}
      data-stem={stem}
      data-boost={bias === "boost" ? "true" : undefined}
      data-cut={bias === "cut" ? "true" : undefined}
      data-disabled={disabled || undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={text}
      title={label + " " + text + "：竖拖调整，双击回中"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={disabled ? undefined : onReset}
    >
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle className="kd-dj-arcknob-track" cx="24" cy="24" r={R}
          fill="none" strokeDasharray={TRACK.toFixed(2) + " " + CIRC.toFixed(2)} transform="rotate(135 24 24)" />
        {arcLen > 0.5 ? (
          <circle className="kd-dj-arcknob-value" cx="24" cy="24" r={R}
            fill="none" strokeDasharray={arcLen.toFixed(2) + " " + CIRC.toFixed(2)} transform={"rotate(" + arcRotate.toFixed(2) + " 24 24)"} />
        ) : null}
        <circle className="kd-dj-arcknob-body" cx="24" cy="24" r="12.5" />
        <line className="kd-dj-arcknob-needle" x1="24" y1="24" x2="24" y2="14"
          transform={"rotate(" + needle.toFixed(2) + " 24 24)"} />
      </svg>
      <b>{showValue ? text : label}</b>
    </div>
  );
}

/**
 * 横向滑动条：DJ 面板横向连续量控件。整条轨道可横滑——指针按下即定位并跟随，
 * 双击复位，方向键微调（Shift 大步），滚轮微移；双极量程过中由 snapKnobToCenter 吸附。
 * 视觉是细轨 + 直角刻槽，不是胶囊；手机端命中高度由外层行高保证。
 */
function SlideStrip({
  label,
  value,
  min = -1,
  max = 1,
  step = 0.01,
  onChange,
  onReset,
  stem,
  disabled = false,
  format,
  variant = "capsule",
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onReset?: () => void;
  stem?: StemName;
  disabled?: boolean;
  format?: (value: number) => string;
  /** capsule＝常规药丸；bare＝发丝微调条（GAIN 用，非药丸）。 */
  variant?: "capsule" | "bare";
}) {
  const shown = snapKnobToCenter(value, min, max);
  const ratio = clamp((shown - min) / (max - min), 0, 1);
  const bipolar = min < 0 && max > 0;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<number | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const latestRef = useRef({ min, max, step, disabled, onChange });
  latestRef.current = { min, max, step, disabled, onChange };

  const atPointer = useCallback((clientX: number): number => {
    const el = trackRef.current;
    const { min, max, step } = latestRef.current;
    if (!el) return shownRef.current;
    const rect = el.getBoundingClientRect();
    const raw = min + clamp((clientX - rect.left) / rect.width, 0, 1) * (max - min);
    const stepped = Math.round((raw - min) / step) * step + min;
    return snapKnobToCenter(clamp(Number(stepped.toFixed(6)), min, max), min, max);
  }, []);

  // React 的 onWheel 是被动监听，preventDefault 拦不住页面滚动；滚轮微调必须原生注册。
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const { min, max, step, disabled, onChange } = latestRef.current;
      if (disabled) return;
      event.preventDefault();
      const direction = (event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 5 : 1);
      const raw = shownRef.current + direction * step;
      onChange(snapKnobToCenter(clamp(Number(raw.toFixed(6)), min, max), min, max));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (latestRef.current.disabled || event.button !== 0) return;
    event.preventDefault();
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    latestRef.current.onChange(atPointer(event.clientX));
  };
  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    event.preventDefault();
    latestRef.current.onChange(atPointer(event.clientX));
  };
  const onUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit 可能在 pointercancel 前先释放捕获。
    }
  };
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { min, max, step, disabled, onChange } = latestRef.current;
    if (disabled) return;
    const stride = step * (event.shiftKey ? 5 : 1);
    const delta = event.key === "ArrowRight" || event.key === "ArrowUp"
      ? stride
      : event.key === "ArrowLeft" || event.key === "ArrowDown"
        ? -stride
        : 0;
    if (delta === 0) return;
    event.preventDefault();
    const raw = shownRef.current + delta;
    onChange(snapKnobToCenter(clamp(Number(raw.toFixed(6)), min, max), min, max));
  };

  const bias = bipolar ? knobBias(shown, min, max) : null;
  const fillStart = bipolar ? Math.min(0.5, ratio) : 0;
  const fillWidth = bipolar ? Math.abs(ratio - 0.5) : ratio;
  const text = format
    ? format(shown)
    : bipolar
      ? (shown === 0 ? "0" : `${shown > 0 ? "+" : ""}${Math.round(shown * 100)}`)
      : `${Math.round(ratio * 100)}`;
  return (
    <div
      className="kd-dj-slide"
      data-variant={variant}
      data-control={label.toLowerCase()}
      data-stem={stem}
      data-bipolar={bipolar || undefined}
      data-boost={bias === "boost" ? "true" : undefined}
      data-cut={bias === "cut" ? "true" : undefined}
      data-disabled={disabled || undefined}
    >
      <b>{label}</b>
      <div
        ref={trackRef}
        className="kd-dj-slide-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={text}
        title={disabled ? undefined : `${label} ${text}：横滑调整，双击复位`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        onDoubleClick={disabled ? undefined : onReset}
      >
        <i className="kd-dj-slide-zero" aria-hidden="true" />
        <i
          className="kd-dj-slide-fill"
          style={{ left: `${fillStart * 100}%`, width: `${fillWidth * 100}%` }}
          aria-hidden="true"
        />
        <u className="kd-dj-slide-thumb" style={{ left: `${ratio * 100}%` }} aria-hidden="true" />
      </div>
      <output>{text}</output>
    </div>
  );
}

/**
 * 竖推：TEMPO 与通道音量共用同一组件、同一手感。指针按下即定位、拖动跟随；
 * snapRatio 附近 ±2% 吸附；双击复位；方向键微调。装饰层（零位线 / 锁点 / 硬件接管影）
 * 由 children 叠在滑柄之下，组件本身不关心语义。
 */
function VFader({
  ratio,
  label,
  disabled = false,
  ariaText,
  snapRatio,
  stepRatio = 0.02,
  onRatio,
  onGestureStart,
  onGestureEnd,
  onReset,
  center = false,
  children,
}: {
  ratio: number;
  label: string;
  disabled?: boolean;
  ariaText?: string;
  snapRatio?: number;
  stepRatio?: number;
  onRatio: (ratio: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onReset?: () => void;
  center?: boolean;
  children?: ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<number | null>(null);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const latestRef = useRef({ snapRatio, stepRatio, disabled, onRatio });
  latestRef.current = { snapRatio, stepRatio, disabled, onRatio };

  const atPointer = useCallback((clientY: number): number => {
    const el = trackRef.current;
    if (!el) return ratioRef.current;
    const { snapRatio } = latestRef.current;
    const rect = el.getBoundingClientRect();
    let next = clamp((rect.bottom - clientY) / rect.height, 0, 1);
    if (snapRatio != null && Math.abs(next - snapRatio) <= 0.02) next = snapRatio;
    return next;
  }, []);

  const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (latestRef.current.disabled || event.button !== 0) return;
    event.preventDefault();
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    onGestureStart?.();
    latestRef.current.onRatio(atPointer(event.clientY));
  };
  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    event.preventDefault();
    latestRef.current.onRatio(atPointer(event.clientY));
  };
  const onUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    onGestureEnd?.();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit 可能在 pointercancel 前先释放捕获。
    }
  };
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { stepRatio, disabled, onRatio } = latestRef.current;
    if (disabled) return;
    const stride = stepRatio * (event.shiftKey ? 5 : 1);
    const delta = event.key === "ArrowUp" ? stride : event.key === "ArrowDown" ? -stride : 0;
    if (delta === 0) return;
    event.preventDefault();
    onRatio(clamp(ratioRef.current + delta, 0, 1));
  };

  const shown = clamp(ratio, 0, 1);
  return (
    <div
      ref={trackRef}
      className="kd-dj-vfader"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={shown}
      aria-valuetext={ariaText}
      title={disabled ? undefined : "拖动调整，双击复位"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={disabled ? undefined : onReset}
    >
      <i className="kd-dj-vfader-ticks" aria-hidden="true"><u /><u /><u /><u /><u /></i>
      {children}
      <i
        className="kd-dj-vfader-thumb"
        data-center={center || undefined}
        style={{ bottom: `${shown * 100}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

function FxSlotControl({ slot, onChange }: {
  slot: FxSlot;
  onChange: (patch: Partial<FxSlot>) => void;
}) {
  const wet = clamp(slot.wet, 0, 1);
  const parameter = clamp(slot.parameter, 0, 1);
  const label = slot.kind === "echo" ? "Echo" : slot.kind === "reverb" ? "Reverb" : slot.kind === "gater" ? "Gater" : "Vocal";
  return (
    <div className="kd-performance-fx-slot" data-active={slot.enabled || undefined} data-kind={slot.kind}>
      <button type="button" className="kd-performance-fx-on" aria-pressed={slot.enabled} onClick={() => onChange({ enabled: !slot.enabled })}>ON</button>
      <label className="kd-performance-fx-select">
        <span>{label}</span>
        <select value={slot.kind} aria-label="选择效果" onChange={(event) => onChange({ kind: event.currentTarget.value as FxKind })}>
          <option value="echo">Echo</option>
          <option value="reverb">Reverb</option>
          <option value="gater">Gater</option>
          <option value="vocal">Vocal</option>
        </select>
        <ChevronDown size={10} aria-hidden="true" />
      </label>
      {slot.kind === "vocal" ? null : <SlideStrip label="PRM" value={parameter} min={0} max={1} onChange={(parameter) => onChange({ parameter })} onReset={() => onChange({ parameter: 0.5 })} />}
      <SlideStrip label="MIX" value={wet} min={0} max={1} onChange={(wet) => onChange({ wet })} onReset={() => onChange({ wet: slot.kind === "vocal" ? 1 : 0.5 })} />
    </div>
  );
}

/**
 * 竖排 TEMPO 面板（rekordbox 式）：竖推子占满控制区全高，SYNC、有效 BPM 读数、
 * 百分比 + 量程下拉、−/+ 步进键收进推子旁的一列（B 台镜像），不再占推子上下方。
 */
function TempoPanel({
  deck,
  side,
  locked,
  syncEnabled,
  hardwareUnit,
  onToggleSync,
  onRateChange,
  onPreviewRate,
  onSoftwareTempoOverride,
}: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  /** 双台 SYNC 锁定中（本台可能是基准方也可能是我随方）。 */
  locked: boolean;
  syncEnabled: boolean;
  /** 最近一次机体 TEMPO 行程（0..1）；与虚拟推子错开时画实体影。 */
  hardwareUnit: number | null;
  onToggleSync: (side: 0 | 1) => void;
  onRateChange: PerformanceWorkspaceProps["onRateChange"];
  onPreviewRate: (side: 0 | 1, rate: number) => number;
  onSoftwareTempoOverride: (side: 0 | 1) => void;
}) {
  const track = deck.track;
  const [rangeId, setRangeId] = useState<TempoRangeId>(() => readTempoRanges()[side]);
  const range = TEMPO_RANGES.find((item) => item.id === rangeId) ?? TEMPO_RANGES[1];
  const [draft, setDraft] = useState(deck.rate);
  const draftRef = useRef(deck.rate);
  const tempoGestureRef = useRef(false);
  const sideRef = useRef(side);
  const onRateChangeRef = useRef(onRateChange);
  const onPreviewRateRef = useRef(onPreviewRate);
  const tempoLaneRef = useRef<LatestTempoCommandLane | null>(null);
  if (tempoLaneRef.current === null) {
    tempoLaneRef.current = new LatestTempoCommandLane((rate) => {
      onRateChangeRef.current(sideRef.current, rate);
    });
  }
  useEffect(() => {
    sideRef.current = side;
    onRateChangeRef.current = onRateChange;
    onPreviewRateRef.current = onPreviewRate;
  }, [onPreviewRate, onRateChange, side]);
  useEffect(() => () => tempoLaneRef.current?.cancel(), []);
  const previousTrackIdRef = useRef<number | null>(deck.track?.id ?? null);
  useEffect(() => {
    const trackId = deck.track?.id ?? null;
    if (previousTrackIdRef.current === trackId) return;
    previousTrackIdRef.current = trackId;
    // A newly installed Deck owns a fresh rate. Do not flush an old pointer-up into it.
    tempoGestureRef.current = false;
    tempoLaneRef.current?.cancel();
  }, [deck.track?.id]);
  useEffect(() => {
    // The native snapshot intentionally arrives at a low cadence. Do not let an older echoed
    // rate pull the physical fader out from under an active pointer gesture.
    if (tempoGestureRef.current) return;
    draftRef.current = deck.rate;
    setDraft(deck.rate);
  }, [deck.rate, deck.track?.id]);
  const commit = (value: number, bounds: { min: number; max: number } = range) => {
    onSoftwareTempoOverride(sideRef.current);
    const requestedRate = clamp(value, bounds.min, bounds.max);
    // The parent may constrain this side further so its linked partner stays inside the native
    // 0.5–2.0 range. Use that exact preview for the thumb and for the eventual native command.
    const rate = onPreviewRateRef.current(sideRef.current, requestedRate);
    draftRef.current = rate;
    setDraft(rate);
    tempoLaneRef.current?.submit(rate);
  };
  const selectRange = (id: TempoRangeId) => {
    onSoftwareTempoOverride(side);
    setRangeId(id);
    const stored = readTempoRanges();
    stored[side] = id;
    localStorage.setItem(TEMPO_RANGE_STORAGE_KEY, JSON.stringify(stored));
    const next = TEMPO_RANGES.find((item) => item.id === id) ?? TEMPO_RANGES[1];
    // 切量程把越界的当前速率钳进新行程，推子位置与引擎状态保持一致。
    if (draftRef.current < next.min || draftRef.current > next.max) {
      commit(draftRef.current, next);
      tempoLaneRef.current?.flush();
    }
  };

  // 竖推手势挂在 VFader 上：按下定位、拖动跟随、松手 flush；键盘中步进留在推子内部，
  // 这里只把 0..1 行程换算回当前量程的 rate。±2% 中位吸附也由 VFader 的 snapRatio 完成。
  const commitRatio = (ratio: number) => {
    commit(range.min + clamp(ratio, 0, 1) * (range.max - range.min));
  };
  const onFaderGestureEnd = () => {
    tempoGestureRef.current = false;
    // Pointer-up is the single value that must never remain behind the lane's trailing timer.
    tempoLaneRef.current?.flush();
  };

  // −/+ 按住连续步进：先单击一次，360ms 后按 80ms 节奏重复，松开/移出即停。
  const stepTimerRef = useRef<number | null>(null);
  const stepIntervalRef = useRef<number | null>(null);
  const stopStep = useCallback(() => {
    if (stepTimerRef.current !== null) {
      window.clearTimeout(stepTimerRef.current);
      stepTimerRef.current = null;
    }
    if (stepIntervalRef.current !== null) {
      window.clearInterval(stepIntervalRef.current);
      stepIntervalRef.current = null;
    }
    tempoLaneRef.current?.flush();
  }, []);
  useEffect(() => stopStep, [stopStep]);
  const startStep = (direction: 1 | -1) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopStep();
    commit(draftRef.current + direction * TEMPO_STEP);
    stepTimerRef.current = window.setTimeout(() => {
      stepTimerRef.current = null;
      stepIntervalRef.current = window.setInterval(() => {
        commit(draftRef.current + direction * TEMPO_STEP);
      }, 80);
    }, 360);
  };

  // 读数显示引擎里的真实速率（SYNC 跟随可能超出本台推子量程）；只有推子位置与
  // aria 值钳在量程内——拇指钉在边界，读数不能跟着说谎。
  const shown = clamp(draft, range.min, range.max);
  const bpm = track?.bpm ? track.bpm * draft : null;
  const percent = Math.round((draft - 1) * 1000) / 10;
  const pctText = percent === 0 ? "0.0%" : `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
  // 0% 档在量程里的位置（WIDE 不是对称量程，中位线不能写死在 50%）。
  const zeroRatio = clamp((1 - range.min) / (range.max - range.min), 0, 1);
  const softwareRatio = clamp((shown - range.min) / (range.max - range.min), 0, 1);
  const hardwareRate = hardwareUnit != null ? scaleUnitToRange(hardwareUnit, range.min, range.max) : null;
  const hardwareRatio = hardwareRate != null ? scaleRangeToUnit(hardwareRate, range.min, range.max) : null;
  const takeoverActive = hardwareRatio != null
    && Math.abs(hardwareRatio - softwareRatio) > SOFT_TAKEOVER_THRESHOLD;
  return (
    <div className="kd-performance-tempo">
      <VFader
        ratio={softwareRatio}
        label={`Deck ${side === 0 ? "A" : "B"} Tempo`}
        disabled={!track}
        ariaText={pctText}
        snapRatio={range.min < 1 && range.max > 1 ? zeroRatio : undefined}
        stepRatio={TEMPO_STEP / (range.max - range.min)}
        onRatio={commitRatio}
        onGestureStart={() => {
          tempoGestureRef.current = true;
        }}
        onGestureEnd={onFaderGestureEnd}
        onReset={() => {
          commit(1);
          tempoLaneRef.current?.flush();
        }}
        center={Boolean(track) && !takeoverActive && Math.abs(shown - 1) < 0.0005}
      >
        <i className="kd-dj-vfader-zero" style={{ bottom: `${zeroRatio * 100}%` }} aria-hidden="true" />
        <i
          className="kd-dj-vfader-lock"
          data-active={locked || undefined}
          style={{ bottom: `${zeroRatio * 100}%` }}
          aria-hidden="true"
        />
        {takeoverActive && hardwareRatio != null ? (
          <>
            <i
              className="kd-dj-vfader-takeover"
              style={{
                bottom: `${Math.min(softwareRatio, hardwareRatio) * 100}%`,
                height: `${Math.abs(softwareRatio - hardwareRatio) * 100}%`,
              }}
              aria-hidden="true"
            />
            <i
              className="kd-dj-vfader-ghost"
              style={{ bottom: `${hardwareRatio * 100}%` }}
              aria-hidden="true"
            />
          </>
        ) : null}
      </VFader>
      <div className="kd-performance-tempo-side">
        <button
          type="button"
          className="kd-performance-sync"
          data-active={locked || undefined}
          aria-pressed={locked}
          onClick={() => onToggleSync(side)}
          disabled={!syncEnabled}
          title="SYNC：本台对齐另一台的有效 BPM，并锁网格相位；再点一次解除锁定"
        >
          SYNC
        </button>
        <output className="kd-performance-tempo-bpm">{bpm ? bpm.toFixed(1) : "—.—"}</output>
        <span className="kd-performance-tempo-pct">
          <output>{pctText}</output>
          <span className="kd-performance-tempo-range">
            <select
              value={rangeId}
              aria-label="TEMPO 量程"
              title="TEMPO 量程"
              onChange={(event) => selectRange(event.currentTarget.value as TempoRangeId)}
            >
              {TEMPO_RANGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <ChevronDown size={9} aria-hidden="true" />
          </span>
        </span>
        <span className="kd-performance-tempo-steps">
          <button
            type="button"
            aria-label="减速"
            disabled={!track}
            onPointerDown={startStep(-1)}
            onPointerUp={stopStep}
            onPointerLeave={stopStep}
            onPointerCancel={stopStep}
          >
            <Minus size={11} />
          </button>
          <button
            type="button"
            aria-label="加速"
            disabled={!track}
            onPointerDown={startStep(1)}
            onPointerUp={stopStep}
            onPointerLeave={stopStep}
            onPointerCancel={stopStep}
          >
            <Plus size={11} />
          </button>
        </span>
      </div>
    </div>
  );
}

/** 通道音量 / 横推：和 TEMPO 同一套刻度轨与直角推柄，不再用原生 range。 */
function MixerFader({
  axis,
  value,
  label,
  disabled,
  centerSnap = axis === "horizontal",
  onChange,
  onGestureEnd,
  onReset,
}: {
  axis: "vertical" | "horizontal";
  value: number;
  label: string;
  disabled?: boolean;
  centerSnap?: boolean;
  onChange: (value: number) => void;
  onGestureEnd?: () => void;
  onReset?: () => void;
}) {
  const faderRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const atPointer = (clientX: number, clientY: number): number => {
    const el = faderRef.current;
    if (!el) return valueRef.current;
    const rect = el.getBoundingClientRect();
    const raw = axis === "vertical"
      ? (rect.bottom - clientY) / rect.height
      : (clientX - rect.left) / rect.width;
    let next = clamp(raw, 0, 1);
    if (axis === "horizontal" && centerSnap && Math.abs(next - 0.5) <= 0.02) next = 0.5;
    return next;
  };
  const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    onChange(atPointer(event.clientX, event.clientY));
  };
  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || pointerRef.current !== event.pointerId) return;
    event.preventDefault();
    onChange(atPointer(event.clientX, event.clientY));
  };
  const onUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    onGestureEnd?.();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit may release capture before pointercancel reaches React.
    }
  };
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.shiftKey ? 0.1 : 0.02;
    const delta = axis === "vertical"
      ? (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0)
      : (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0);
    if (delta === 0) return;
    event.preventDefault();
    onChange(clamp(valueRef.current + delta, 0, 1));
  };
  const ratio = clamp(value, 0, 1);
  const percent = Math.round(ratio * 100);
  return (
    <div
      ref={faderRef}
      className="kd-performance-fader"
      data-axis={axis}
      data-disabled={disabled || undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={ratio}
      aria-valuetext={`${percent}%`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={disabled ? undefined : onReset}
      title={disabled ? undefined : "拖动调整，双击复位"}
    >
      <i className="kd-performance-fader-ticks" aria-hidden="true"><u /><u /><u /><u /><u /></i>
      <i className="kd-performance-fader-fill" style={axis === "vertical" ? { height: `${ratio * 100}%` } : { width: `${ratio * 100}%` }} aria-hidden="true" />
      <i
        className="kd-performance-fader-thumb"
        data-center={(axis === "horizontal" && Math.abs(ratio - 0.5) < 0.0005) || undefined}
        style={axis === "vertical" ? { bottom: `${ratio * 100}%` } : { left: `${ratio * 100}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

type EqChartPoint = { x: number; y: number };

function smoothEqChartPath(points: EqChartPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.slice(0, -1).reduce((path, point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[index + 1];
    const after = points[Math.min(points.length - 1, index + 2)];
    const control1 = {
      x: point.x + (next.x - previous.x) / 6,
      y: clamp(point.y + (next.y - previous.y) / 6, 0, 1_000),
    };
    const control2 = {
      x: next.x - (after.x - point.x) / 6,
      y: clamp(next.y - (after.y - point.y) / 6, 0, 1_000),
    };
    return `${path} C ${control1.x.toFixed(2)} ${control1.y.toFixed(2)} ${control2.x.toFixed(2)} ${control2.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }, `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`);
}

/**
 * Fifteen genuine post-EQ levels form one moving spectrum line under the three-control preset.
 * The pointer gesture
 * is intentionally relative: contact never jumps to an absolute y value. Coalesced pointer
 * segments are integrated across every crossed cell, then distributed to LOW/MID/HIGH.
 */
function EqSpectrumChart({ side, values, playing, onAdjust, onReset }: {
  side: 0 | 1;
  values: EqGraphValues;
  playing: boolean;
  onAdjust: (delta: EqGraphValues) => void;
  onReset: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const spectrumPathRef = useRef<SVGPathElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const latestRef = useRef({ onAdjust, onReset });
  latestRef.current = { onAdjust, onReset };
  const dragRef = useRef<{
    pointerId: number;
    pointerType: string;
    x: number;
    y: number;
    distance: number;
  } | null>(null);
  const lastTouchTapRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const shown = new Array<number>(EQ_GRAPH_BAND_COUNT).fill(0);
    const painted = new Array<number>(EQ_GRAPH_BAND_COUNT).fill(-1);
    let frame = 0;
    let previousAt = performance.now();
    const tick = (at: number) => {
      const dt = Math.min(0.1, Math.max(0, (at - previousAt) / 1_000));
      previousAt = at;
      const live = playingRef.current ? getLiveDeckSpectrum(side) : null;
      let changed = false;
      for (let band = 0; band < EQ_GRAPH_BAND_COUNT; band += 1) {
        const target = eqSpectrumLevelToRatio(live?.[band] ?? 0);
        shown[band] = target >= shown[band]
          ? target
          : Math.max(target, shown[band] - dt / (playingRef.current ? 0.19 : 0.1));
        const level = Math.round(shown[band] * 1000) / 1000;
        if (level !== painted[band]) {
          painted[band] = level;
          changed = true;
        }
      }
      if (changed && spectrumPathRef.current) {
        const points = painted.map((level, index) => ({
          x: (index + 0.5) / EQ_GRAPH_BAND_COUNT * 1_000,
          y: (1 - Math.max(0, level)) * 1_000,
        }));
        const pathPoints = [
          { x: 0, y: points[0].y },
          ...points,
          { x: 1_000, y: points[points.length - 1].y },
        ];
        spectrumPathRef.current.setAttribute("d", smoothEqChartPath(pathPoints));
        spectrumPathRef.current.style.opacity = String(clamp(Math.max(...painted) * 4, 0, 1));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [side]);

  const pointRatios = EQ_GRAPH_FREQUENCIES.map((_, index) => (index + 0.5) / EQ_GRAPH_BAND_COUNT);
  const curvePoints = pointRatios.map((ratio) => ({
    x: ratio * 1_000,
    y: eqDbToGraphRatio(eqCurveDbAtRatio(values, ratio)) * 1_000,
  }));
  const pathPoints = [
    { x: 0, y: curvePoints[0].y },
    ...curvePoints,
    { x: 1_000, y: curvePoints[curvePoints.length - 1].y },
  ];
  const smoothCurvePath = smoothEqChartPath(pathPoints);

  const applyPointerSamples = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !root) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const native = event.nativeEvent;
    const samples = typeof native.getCoalescedEvents === "function"
      ? native.getCoalescedEvents()
      : [native];
    let low = 0;
    let mid = 0;
    let high = 0;
    for (const sample of samples.length > 0 ? samples : [native]) {
      const nextX = sample.clientX;
      const nextY = sample.clientY;
      const dx = nextX - drag.x;
      const dy = nextY - drag.y;
      if (dx === 0 && dy === 0) continue;
      const weights = eqGestureWeights(
        (drag.x - rect.left) / rect.width,
        (nextX - rect.left) / rect.width,
      );
      // Roughly 65% of chart height moves one side of the bipolar control's full throw.
      const delta = -dy / (rect.height * 0.65);
      low += delta * weights.low;
      mid += delta * weights.mid;
      high += delta * weights.high;
      drag.distance += Math.hypot(dx, dy);
      drag.x = nextX;
      drag.y = nextY;
    }
    if (low !== 0 || mid !== 0 || high !== 0) {
      latestRef.current.onAdjust({ low, mid, high });
    }
  };

  const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      distance: 0,
    };
    event.currentTarget.dataset.dragging = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finishPointer = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!cancelled) applyPointerSamples(event);
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit may release capture before pointercancel.
    }
    if (!cancelled && drag.pointerType !== "mouse" && drag.distance < 8) {
      const now = performance.now();
      if (now - lastTouchTapRef.current <= 320) {
        lastTouchTapRef.current = Number.NEGATIVE_INFINITY;
        latestRef.current.onReset();
      } else {
        lastTouchTapRef.current = now;
      }
    }
  };

  return (
    <div
      ref={rootRef}
      className="kd-dj-eq-chart"
      data-side={side === 0 ? "a" : "b"}
      role="group"
      aria-label={`Deck ${side === 0 ? "A" : "B"} 三段手绘 EQ 与十五段实时响度`}
      title="相对拖动手绘 EQ；双击恢复平直"
      onPointerDown={onDown}
      onPointerMove={applyPointerSamples}
      onPointerUp={(event) => finishPointer(event, false)}
      onPointerCancel={(event) => finishPointer(event, true)}
      onDoubleClick={(event) => { event.preventDefault(); latestRef.current.onReset(); }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <svg className="kd-dj-eq-spectrum" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`kd-dj-eq-spectrum-${side}`} gradientUnits="userSpaceOnUse" x1="0" y1="1000" x2="0" y2="0">
            <stop offset="0%" stopColor="#22d85b" />
            <stop offset="52%" stopColor="#a8e53b" />
            <stop offset="72%" stopColor="#e8e632" />
            <stop offset="86%" stopColor="#ffb52f" />
            <stop offset="100%" stopColor="#f04452" />
          </linearGradient>
        </defs>
        <path ref={spectrumPathRef} style={{ stroke: `url(#kd-dj-eq-spectrum-${side})` }} />
      </svg>
      <i className="kd-dj-eq-zero" aria-hidden="true" />
      <span className="kd-dj-eq-guides" aria-hidden="true">
        <i data-kind="minor" style={{ left: `${100 / 6}%` }} />
        <i data-kind="major" style={{ left: `${100 / 3}%` }} />
        <i data-kind="minor" style={{ left: "50%" }} />
        <i data-kind="major" style={{ left: `${200 / 3}%` }} />
        <i data-kind="minor" style={{ left: `${500 / 6}%` }} />
      </span>
      <svg className="kd-dj-eq-curve" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <path d={smoothCurvePath} />
      </svg>
    </div>
  );
}

/** Single Deck mixer: the graph and the physical-style LOW/MID/HIGH knobs share one state. */
function MixerStrip({ side, mixer, playing, setMixer, adjustEq }: {
  side: 0 | 1;
  mixer: PerformanceMixerValues;
  playing: boolean;
  setMixer: (patch: Partial<PerformanceMixerValues>) => void;
  adjustEq: (delta: EqGraphValues) => void;
}) {
  return (
    <div className="kd-performance-strip" data-side={side === 0 ? "a" : "b"}>
      <div className="kd-performance-strip-knobs">
        <EqSpectrumChart
          side={side}
          values={mixer}
          playing={playing}
          onAdjust={adjustEq}
          onReset={() => setMixer({ low: 0, mid: 0, high: 0 })}
        />
        <div className="kd-dj-eq-knobs">
          <ArcKnob size="sm" label="LOW" value={mixer.low} onChange={(low) => setMixer({ low })} onReset={() => setMixer({ low: 0 })} />
          <ArcKnob size="sm" label="MID" value={mixer.mid} onChange={(mid) => setMixer({ mid })} onReset={() => setMixer({ mid: 0 })} />
          <ArcKnob size="sm" label="HIGH" value={mixer.high} onChange={(high) => setMixer({ high })} onReset={() => setMixer({ high: 0 })} />
        </div>
      </div>
    </div>
  );
}

/** Pure channel-volume fader. Live loudness now exists only in the EQ spectrum line. */
function ChannelFader({ side, mixer, setMixer }: {
  side: 0 | 1;
  mixer: PerformanceMixerValues;
  setMixer: (patch: Partial<PerformanceMixerValues>) => void;
}) {
  return (
    <div className="kd-performance-channel-fader" data-side={side === 0 ? "a" : "b"}>
      <b>LEVEL</b>
      <VFader
        ratio={mixer.volume}
        label={`CH ${side === 0 ? "A" : "B"} 音量`}
        ariaText={`${Math.round(clamp(mixer.volume, 0, 1) * 100)}%`}
        stepRatio={0.02}
        onRatio={(volume) => setMixer({ volume })}
        onReset={() => setMixer({ volume: 1 })}
      />
    </div>
  );
}

const StableDeckWave = memo(DeckWave);
const StableDeckInfo = memo(DeckInfo);

export function PerformanceWorkspace({
  decks: sourceDecks,
  stems,
  stemRuntime,
  stemMode,
  masterVolume,
  onSeek,
  onJogSeek,
  onJogNudge,
  onJogScratchTick,
  onJogScratchStart,
  onJogScratchRelease,
  onScratchRelease,
  onScratchHold,
  onTrackDrop,
  onTogglePlay,
  onMainCue,
  onRateChange,
  onRatePairChange,
  onSync,
  onMixerChange,
  onDeckFx,
  onMasterVolumeChange,
  onEnsureStemWaveScan,
  onReleaseStemWaveScan,
  onStemWaveMaskChange,
  onToggleStemAll,
  onStemGain,
  onSetLoop,
  onClearLoop,
  onSaveCuePoints,
  onSaveMainCue,
}: PerformanceWorkspaceProps) {
  const [analyzedDeckTracks, setAnalyzedDeckTracks] = useState<[Track | null, Track | null]>([null, null]);
  useEffect(() => {
    let alive = true;
    const resolve = (track: Track | null) => {
      const localId = localLibraryDataTrackId(track);
      if (!track || localId === null) return Promise.resolve(track);
      return api.track(localId)
        .then((analyzed) => ({
          ...track,
          bpm: analyzed.bpm ?? track.bpm,
          bpm_v2: analyzed.bpm_v2,
          bpm_confidence: analyzed.bpm_confidence ?? track.bpm_confidence,
          first_beat: analyzed.first_beat ?? track.first_beat,
        }))
        .catch(() => track);
    };
    void Promise.all([resolve(sourceDecks[0].track), resolve(sourceDecks[1].track)]).then((tracks) => {
      if (alive) setAnalyzedDeckTracks(tracks as [Track | null, Track | null]);
    });
    return () => { alive = false; };
  }, [
    sourceDecks[0].track?.id,
    sourceDecks[0].track?.modified_at,
    sourceDecks[1].track?.id,
    sourceDecks[1].track?.modified_at,
  ]);
  const decks = useMemo<[PerformanceDeckModel, PerformanceDeckModel]>(() =>
    sourceDecks.map((deck, side) => {
      const current = deck.track;
      const analyzed = analyzedDeckTracks[side];
      if (!current || analyzed?.id !== current.id) return deck;
      return {
        ...deck,
        track: {
          ...current,
          bpm: analyzed.bpm ?? current.bpm,
          bpm_v2: analyzed.bpm_v2,
          bpm_confidence: analyzed.bpm_confidence ?? current.bpm_confidence,
          first_beat: analyzed.first_beat ?? current.first_beat,
        },
      };
    }) as [PerformanceDeckModel, PerformanceDeckModel],
  [sourceDecks, analyzedDeckTracks]);
  const autoBeatSync = useDjConfig((state) => state.autoBeatSync);
  const quantize = usePlaybackPrefs((state) => state.quantize);
  const [mixers, setMixers] = useState<[PerformanceMixerValues, PerformanceMixerValues]>(readMixer);
  const [visualRates, setVisualRates] = useState<[number | null, number | null]>([null, null]);
  const [tempoHardwareUnit, setTempoHardwareUnit] = useState<[number | null, number | null]>([null, null]);
  const tempoTakeoverRef = useRef({
    lanes: [new SoftTakeover(), new SoftTakeover()] as [SoftTakeover, SoftTakeover],
    hardwareUnit: [null, null] as [number | null, number | null],
  });
  const armTempoTakeover = (side: 0 | 1) => {
    tempoTakeoverRef.current.lanes[side].ignoreNext();
    const unit = tempoTakeoverRef.current.hardwareUnit[side];
    setTempoHardwareUnit((prev) => {
      if (prev[side] === unit) return prev;
      const next: [number | null, number | null] = [prev[0], prev[1]];
      next[side] = unit;
      return next;
    });
  };
  const showTempoHardware = (side: 0 | 1, unit: number | null) => {
    setTempoHardwareUnit((prev) => {
      if (prev[side] === unit) return prev;
      const next: [number | null, number | null] = [prev[0], prev[1]];
      next[side] = unit;
      return next;
    });
  };
  const [crossfader, setCrossfader] = useState(0);
  const [crossfaderEnabled, setCrossfaderEnabled] = useState(readCrossfaderEnabled);
  const [crossfaderTempoSync, setCrossfaderTempoSync] = useState(false);
  const [eqStemMode, setEqStemMode] = useState<[EqStemLayer, EqStemLayer]>(["eq", "eq"]);
  const [midiPort, setMidiPort] = useState<string | null>(null);
  const [loopBeats, setLoopBeats] = useState<[number, number]>(readLoopBeats);
  const [jumpBeats, setJumpBeats] = useState<[number, number]>(readJumpBeats);
  const [deckPadPage, setDeckPadPage] = useState<[DeckPadPage, DeckPadPage]>(["cue", "cue"]);
  const [fxMode, setFxMode] = useState<[FxPanelMode, FxPanelMode]>(["knobs", "knobs"]);
  const [fxSlots, setFxSlots] = useState<[DeckFxSlots, DeckFxSlots]>([
    defaultDeckFxSlots(),
    defaultDeckFxSlots(),
  ]);
  const [heldPadFx, setHeldPadFx] = useState<[number, number]>([0, 0]);
  const vocalFxRestoreRef = useRef<[
    { gain: number; wasEnabled: boolean } | null,
    { gain: number; wasEnabled: boolean } | null,
  ]>([null, null]);
  const vocalFxEnableAttemptRef = useRef<[string | null, string | null]>([null, null]);
  const vocalFxDisableAttemptRef = useRef<[boolean, boolean]>([false, false]);
  const [samplerSlotIds, setSamplerSlotIds] = useState<Array<number | null>>(readSamplerSlotIds);
  const [samplerTracks, setSamplerTracks] = useState<Array<Track | null>>(() => Array(8).fill(null));
  const samplerAudioRef = useRef<Array<HTMLAudioElement | null>>(Array(8).fill(null));
  const [activeStemDisplayMask, setActiveStemDisplayMask] = useState(readPerformanceWaveMask);
  /** SYNC 锁定：base 是按下 SYNC 的那台；关系 otherEff = multiple × baseEff，双向跟随。 */
  const [syncLock, setSyncLock] = useState<{ base: 0 | 1; multiple: number } | null>(null);
  const [stemWaveforms, setStemWaveforms] = useState<[
    Partial<Record<StemName, WaveformData>>,
    Partial<Record<StemName, WaveformData>>,
  ]>([{}, {}]);
  // `revision` is a server-side append cursor, not React state: ordinary 200ms polls must not
  // schedule a component update. This is the important boundary that keeps the compositor free.
  const stemWaveCursorRef = useRef<[StemWaveCursor, StemWaveCursor]>([
    { trackId: null, epoch: null, revision: 0 },
    { trackId: null, epoch: null, revision: 0 },
  ]);
  const stemScanTrackIdsRef = useRef<[number | null, number | null]>([null, null]);
  const [scratchPreviews, setScratchPreviews] = useState<[number | null, number | null]>([
    null,
    null,
  ]);
  /** Held hardware platter positions preview the needle while ticks already drive the engine. */
  const [midiScratchActive, setMidiScratchActive] = useState<[boolean, boolean]>([false, false]);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onJogSeekRef = useRef(onJogSeek);
  onJogSeekRef.current = onJogSeek;
  const onJogNudgeRef = useRef(onJogNudge);
  onJogNudgeRef.current = onJogNudge;
  const onJogScratchTickRef = useRef(onJogScratchTick);
  onJogScratchTickRef.current = onJogScratchTick;
  const onJogScratchStartRef = useRef(onJogScratchStart);
  onJogScratchStartRef.current = onJogScratchStart;
  const onJogScratchReleaseRef = useRef(onJogScratchRelease);
  onJogScratchReleaseRef.current = onJogScratchRelease;
  const onDeckFxRef = useRef(onDeckFx);
  onDeckFxRef.current = onDeckFx;
  const deckTrackIdsRef = useRef<[number | null, number | null]>([
    decks[0].track?.id ?? null,
    decks[1].track?.id ?? null,
  ]);
  deckTrackIdsRef.current = [decks[0].track?.id ?? null, decks[1].track?.id ?? null];
  const jogTouchRef = useRef<[boolean, boolean]>([false, false]);
  const decksRef = useRef(decks);
  decksRef.current = decks;
  const syncLockRef = useRef(syncLock);
  syncLockRef.current = syncLock;
  const syncInteractionRevisionRef = useRef(0);
  const crossfaderTempoSyncRef = useRef(crossfaderTempoSync);
  crossfaderTempoSyncRef.current = crossfaderTempoSync;
  const crossfaderTempoPendingRef = useRef<[number, number] | null>(null);
  const crossfaderTempoTimerRef = useRef<number | null>(null);
  const onRatePairChangeRef = useRef(onRatePairChange);
  onRatePairChangeRef.current = onRatePairChange;
  const jogAtRef = useRef<[
    { trackId: number; position: number; at: number } | null,
    { trackId: number; position: number; at: number } | null,
  ]>([null, null]);
  const jogSeekPendingRef = useRef<[
    { trackId: number; position: number } | null,
    { trackId: number; position: number } | null,
  ]>([null, null]);
  const jogSeekTimerRef = useRef<[number | null, number | null]>([null, null]);
  const jogSeekSentAtRef = useRef<[number, number]>([0, 0]);
  const scratchPreviewPendingRef = useRef<[number | null, number | null]>([null, null]);
  const scratchPreviewFrameRef = useRef<number | null>(null);
  const syncPlayingRef = useRef<[boolean, boolean] | null>(null);
  const syncTrackIdsRef = useRef<[number | null, number | null]>([null, null]);
  const mixerTimerRef = useRef<number | null>(null);
  const mixerDispatchRef = useRef({
    mixers,
    crossfader,
    crossfaderEnabled,
    onMixerChange,
    trackIds: [decks[0].track?.id ?? null, decks[1].track?.id ?? null] as [number | null, number | null],
  });
  const mixerSignatureRef = useRef<[string, string]>(["", ""]);
  useEffect(() => {
    localStorage.setItem(LOOP_BEATS_STORAGE_KEY, JSON.stringify(loopBeats));
  }, [loopBeats]);
  useEffect(() => {
    localStorage.setItem(JUMP_BEATS_STORAGE_KEY, JSON.stringify(jumpBeats));
  }, [jumpBeats]);
  useEffect(() => {
    localStorage.setItem(SAMPLER_STORAGE_KEY, JSON.stringify(samplerSlotIds));
    let alive = true;
    void Promise.all(samplerSlotIds.map(async (id) => {
      if (id === null) return null;
      try {
        const track = await api.track(id);
        return usesLocalLibraryRecord(track) ? track : null;
      } catch {
        return null;
      }
    })).then((tracks) => { if (alive) setSamplerTracks(tracks); });
    return () => { alive = false; };
  }, [samplerSlotIds]);
  useEffect(() => {
    samplerAudioRef.current.forEach((audio) => { if (audio) audio.volume = masterVolume; });
  }, [masterVolume]);
  useEffect(() => () => {
    samplerAudioRef.current.forEach((audio) => {
      audio?.pause();
      if (audio) audio.src = "";
    });
    ([0, 1] as const).forEach((side) => {
      onDeckFxRef.current(side, { echo: 0, echoParameter: 0.5, reverb: 0, reverbParameter: 0.5, gater: 0, gaterParameter: 0.5, pad: 0, beatSeconds: 0.5 });
    });
  }, []);
  useEffect(() => {
    const effect = (slots: DeckFxSlots, kind: FxKind): { wet: number; parameter: number } => {
      const candidates = slots.filter((slot) => slot.enabled && slot.kind === kind);
      if (candidates.length === 0) return { wet: 0, parameter: 0.5 };
      return candidates.reduce((best, slot) => slot.wet >= best.wet ? slot : best);
    };
    ([0, 1] as const).forEach((side) => {
      const echo = effect(fxSlots[side], "echo");
      const reverb = effect(fxSlots[side], "reverb");
      const gater = effect(fxSlots[side], "gater");
      const knobMode = fxMode[side] === "knobs";
      const padMode = fxMode[side] === "pads";
      onDeckFxRef.current(side, {
        echo: knobMode ? echo.wet : 0,
        echoParameter: echo.parameter,
        reverb: knobMode ? reverb.wet : 0,
        reverbParameter: reverb.parameter,
        gater: knobMode ? gater.wet : 0,
        gaterParameter: gater.parameter,
        pad: padMode ? heldPadFx[side] : 0,
        beatSeconds: beatSeconds(decks[side].track) ?? 0.5,
      });
    });
  }, [
    decks[0].track?.bpm,
    decks[1].track?.bpm,
    fxSlots,
    fxMode,
    heldPadFx,
  ]);
  useEffect(() => {
    ([0, 1] as const).forEach((side) => {
      const vocal = fxMode[side] === "knobs"
        ? fxSlots[side]
          .filter((slot) => slot.enabled && slot.kind === "vocal")
          .reduce<FxSlot | null>((best, slot) => !best || slot.wet >= best.wet ? slot : best, null)
        : null;
      const restore = vocalFxRestoreRef.current[side];
      if (vocal) {
        if (!restore) {
          vocalFxRestoreRef.current[side] = {
            gain: stems[side].gains[3],
            wasEnabled: stems[side].enabled,
          };
        }
        vocalFxDisableAttemptRef.current[side] = false;
        if (!stems[side].enabled) {
          const token = [
            decks[side].track?.id ?? "none",
            stemRuntime?.state ?? "none",
            stems[side].status?.state ?? "none",
          ].join(":");
          if (vocalFxEnableAttemptRef.current[side] !== token) {
            vocalFxEnableAttemptRef.current[side] = token;
            onToggleStemAll(side);
          }
          return;
        }
        vocalFxEnableAttemptRef.current[side] = null;
        if (Math.abs(stems[side].gains[3] - vocal.wet) > 0.002) {
          onStemGain(side, "vocals", vocal.wet);
        }
        return;
      }

      if (!restore) return;
      if (stems[side].enabled) {
        if (Math.abs(stems[side].gains[3] - restore.gain) > 0.002) {
          onStemGain(side, "vocals", restore.gain);
        }
        if (!restore.wasEnabled && !vocalFxDisableAttemptRef.current[side]) {
          vocalFxDisableAttemptRef.current[side] = true;
          onToggleStemAll(side);
        } else if (restore.wasEnabled) {
          vocalFxRestoreRef.current[side] = null;
        }
      } else if (!restore.wasEnabled && vocalFxEnableAttemptRef.current[side] === null) {
        vocalFxRestoreRef.current[side] = null;
        vocalFxDisableAttemptRef.current[side] = false;
      } else if (!stems[side].enabled && vocalFxDisableAttemptRef.current[side]) {
        vocalFxRestoreRef.current[side] = null;
        vocalFxEnableAttemptRef.current[side] = null;
        vocalFxDisableAttemptRef.current[side] = false;
      }
    });
  }, [
    decks[0].track?.id,
    decks[1].track?.id,
    fxMode,
    fxSlots,
    stemRuntime?.state,
    stems[0].enabled,
    stems[1].enabled,
    stems[0].gains,
    stems[1].gains,
    stems[0].status?.state,
    stems[1].status?.state,
  ]);
  useEffect(() => {
    localStorage.setItem(PERFORMANCE_WAVE_DISPLAY_STORAGE_KEY, JSON.stringify(activeStemDisplayMask));
    onStemWaveMaskChange?.(activeStemDisplayMask);
  }, [activeStemDisplayMask, onStemWaveMaskChange]);
  useEffect(() => {
    const previous = stemScanTrackIdsRef.current;
    const next: [number | null, number | null] = [
      decks[0].track?.id ?? null,
      decks[1].track?.id ?? null,
    ];
    const wantsVocalWave = performanceStemLanesVisible(activeStemDisplayMask);
    const active: [number | null, number | null] = [
      wantsVocalWave ? next[0] : null,
      wantsVocalWave ? next[1] : null,
    ];
    [...new Set(previous.filter((trackId): trackId is number => trackId !== null))]
      .filter((trackId) => !active.includes(trackId))
      .forEach((trackId) => onReleaseStemWaveScan?.(trackId));
    stemScanTrackIdsRef.current = active;
    if (stemRuntime?.state !== "ready") return;
    // Give the original 640-column rail its first paint, then automatically prepare STEM around
    // each loaded Deck. Staggering the mounts avoids two cold decode requests landing together;
    // the native scheduler still owns inference priority and expands beyond the viewport later.
    const timers = ([0, 1] as const).flatMap((side) => {
      if (active[side] === null) return [];
      return [window.setTimeout(
        () => onEnsureStemWaveScan?.(side),
        700 + side * 300,
      )];
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [
    decks[0].track?.id,
    decks[1].track?.id,
    activeStemDisplayMask,
    onEnsureStemWaveScan,
    onReleaseStemWaveScan,
    stemRuntime?.state,
  ]);
  useEffect(() => {
    localStorage.setItem(CROSSFADER_ENABLED_STORAGE_KEY, JSON.stringify(crossfaderEnabled));
  }, [crossfaderEnabled]);
  useEffect(() => {
    localStorage.setItem(MIXER_STORAGE_KEY, JSON.stringify(mixers));
    mixerDispatchRef.current = {
      mixers,
      crossfader,
      crossfaderEnabled,
      onMixerChange,
      trackIds: [decks[0].track?.id ?? null, decks[1].track?.id ?? null],
    };
    // Pointer events can arrive faster than IPC and audio callbacks. Keep the local control at
    // pointer speed, but coalesce DSP delivery to one stable trailing update every 40ms so mixer
    // commands never build a stale queue that also floods the waveform clock with old snapshots.
    if (mixerTimerRef.current === null) {
      mixerTimerRef.current = window.setTimeout(() => {
        mixerTimerRef.current = null;
        const latest = mixerDispatchRef.current;
        const [left, right] = crossfaderChannelGains(latest.crossfaderEnabled ? latest.crossfader : 0);
        ([left, right] as const).forEach((crossGain, side) => {
          const values = latest.mixers[side];
          const channelGain = crossGain * channelFaderGain(values.volume);
          const signature = [
            latest.trackIds[side] ?? "",
            values.gain,
            values.high,
            values.mid,
            values.low,
            values.filter,
            channelGain,
          ].join(":");
          if (signature === mixerSignatureRef.current[side]) return;
          mixerSignatureRef.current[side] = signature;
          latest.onMixerChange(side as 0 | 1, values, channelGain);
        });
      }, 40);
    }
  }, [mixers, crossfader, crossfaderEnabled, decks[0].track?.id, decks[1].track?.id]);
  useEffect(() => () => {
    if (mixerTimerRef.current !== null) {
      window.clearTimeout(mixerTimerRef.current);
      // React StrictMode 会在开发环境执行一次 setup → cleanup → setup。只清掉
      // timeout 却保留非 null 的句柄，会让第二次 setup 和之后所有推子变化都
      // 误以为已有派发在排队，横推/竖推因此只动 UI、永远进不了音频引擎。
      mixerTimerRef.current = null;
    }
  }, []);
  const onTrackDropRef = useRef(onTrackDrop);
  onTrackDropRef.current = onTrackDrop;
  useEffect(() => {
    const drop = (event: Event) => {
      const detail = (event as CustomEvent<TrackDeckDropDetail>).detail;
      if (!detail || (detail.side !== 0 && detail.side !== 1) || detail.ids.length === 0) return;
      onTrackDropRef.current(detail.side, detail.ids);
    };
    window.addEventListener(TRACK_DECK_DROP_EVENT, drop);
    return () => window.removeEventListener(TRACK_DECK_DROP_EVENT, drop);
  }, []);
  const assignSamplerSlot = useCallback(async (slot: number, id: number) => {
    if (slot < 0 || slot > 7 || !Number.isFinite(id)) return;
    try {
      const track = await api.track(id);
      if (!usesLocalLibraryRecord(track)) return;
      setSamplerSlotIds((current) => current.map((value, index) => index === slot ? track.id : value));
    } catch {
      // A stale library row must not clear a working sampler slot.
    }
  }, []);
  useEffect(() => {
    const drop = (event: Event) => {
      const detail = (event as CustomEvent<TrackSamplerDropDetail>).detail;
      const id = detail?.ids?.[0];
      if (id == null) return;
      void assignSamplerSlot(detail.slot, id);
    };
    window.addEventListener(TRACK_SAMPLER_DROP_EVENT, drop);
    return () => window.removeEventListener(TRACK_SAMPLER_DROP_EVENT, drop);
  }, [assignSamplerSlot]);

  useEffect(() => {
    setStemWaveforms([{}, {}]);
    stemWaveCursorRef.current = [
      { trackId: decks[0].track?.id ?? null, epoch: null, revision: 0 },
      { trackId: decks[1].track?.id ?? null, epoch: null, revision: 0 },
    ];
    // 任一台换歌后旧的对齐关系不再成立，解除 SYNC 锁定（重新点 SYNC 即可）。
    crossfaderTempoSyncRef.current = false;
    setCrossfaderTempoSync(false);
    crossfaderTempoPendingRef.current = null;
    if (crossfaderTempoTimerRef.current !== null) {
      window.clearTimeout(crossfaderTempoTimerRef.current);
      crossfaderTempoTimerRef.current = null;
    }
    syncLockRef.current = null;
    setSyncLock(null);
  }, [decks[0].track?.id, decks[1].track?.id, stemMode]);

  useEffect(() => () => {
    if (crossfaderTempoTimerRef.current !== null) {
      window.clearTimeout(crossfaderTempoTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const running = [false, false];
    const sync = async (side: 0 | 1) => {
      const track = decks[side].track;
      const lanesVisible = performanceStemLanesVisible(activeStemDisplayMask);
      const scanMounted = Boolean(stems[side].status?.phase);
      if (!track || !lanesVisible || (!stems[side].enabled && !scanMounted) || running[side]) {
        return;
      }
      running[side] = true;
      const cursor = stemWaveCursorRef.current[side];
      if (cursor.trackId !== track.id) {
        cursor.trackId = track.id;
        cursor.epoch = null;
        cursor.revision = 0;
      }
      let delta: Awaited<ReturnType<typeof api.stemWaveformDelta>> | null = null;
      try {
        delta = await api.stemWaveformDelta(
          track.id,
          detailWaveformBuckets(decks[side].duration),
          cursor.revision,
          cursor.epoch,
        );
      } catch {
        // Playback creates the in-memory session asynchronously; the next 200ms tick retries.
      }
      running[side] = false;
      if (!alive || !delta || delta.track_id !== track.id) return;
      const isNewEpoch = cursor.epoch !== delta.epoch;
      cursor.epoch = delta.epoch;
      cursor.revision = delta.revision;
      const hasPoints = delta.stems.some(({ points }) => points.length > 0);
      // Empty delta responses are the normal steady state. Do not touch React state or GPU
      // textures in that case; the independent visual clock keeps drawing at display Hz.
      if (!hasPoints && !isNewEpoch) return;
      setStemWaveforms((current) => {
        const next = [{ ...current[0] }, { ...current[1] }] as [
          Partial<Record<StemName, WaveformData>>,
          Partial<Record<StemName, WaveformData>>,
        ];
        // A live separator has to decode a new local window after a genuine seek, but it is
        // still the same song. Keep already published columns instead of blanking every STEM rail
        // and making a jog/SYNC look like a whole-track re-analysis.
        delta.stems.forEach(({ stem, points }) => {
          // Runtime/model changes create a new public epoch. Never merge that first payload into
          // old-model arrays: their lane meaning and coverage are no longer compatible.
          const prior = isNewEpoch ? undefined : next[side][stem];
          const waveform = prior
            && prior.track_id === track.id
            && prior.amp.length === delta.columns
            ? prior
            : emptyLiveStemWaveform(
                track.id,
                delta.duration,
                delta.columns,
                delta.analysis_start,
                delta.analysis_frontier,
                delta.analysis_back_frontier,
              );
          points.forEach(({ index, amp, r, g, b }) => {
            if (index < 0 || index >= waveform.amp.length || !Number.isFinite(amp)) return;
            waveform.amp[index] = Math.max(waveform.amp[index], amp);
            waveform.r[index] = Math.round(Math.min(255, Math.max(0, r)));
            waveform.g[index] = Math.round(Math.min(255, Math.max(0, g)));
            waveform.b[index] = Math.round(Math.min(255, Math.max(0, b)));
            if (waveform.known) waveform.known[index] = true;
          });
          // A fresh wrapper makes Waveform repaint only when a real classical separation block changed. Its
          // large typed timeline arrays stay shared; copying them on every visual update would
          // merely move the old polling bottleneck from JSON parsing into the JS heap.
          next[side][stem] = {
            ...waveform,
            analysis_start: delta.analysis_start,
            analysis_frontier: delta.analysis_frontier,
            analysis_back_frontier: delta.analysis_back_frontier,
          };
        });
        return next;
      });
    };
    ([0, 1] as const).forEach((side) => {
      const shouldPoll = performanceStemLanesVisible(activeStemDisplayMask)
        && (stems[side].enabled || Boolean(stems[side].status?.phase));
      if (!shouldPoll || decks[side].track?.id !== stemWaveCursorRef.current[side].trackId) {
        stemWaveCursorRef.current[side] = {
          trackId: decks[side].track?.id ?? null,
          epoch: null,
          revision: 0,
        };
        if (!performanceStemLanesVisible(activeStemDisplayMask)) {
          setStemWaveforms((current) => {
            const next = [{ ...current[0] }, { ...current[1] }] as [
              Partial<Record<StemName, WaveformData>>,
              Partial<Record<StemName, WaveformData>>,
            ];
            next[side] = {};
            return next;
          });
        }
      }
      void sync(side);
    });
    const timer = window.setInterval(() => {
      void sync(0);
      void sync(1);
    }, 200);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [
    decks[0].track?.id,
    decks[1].track?.id,
    decks[0].duration,
    decks[1].duration,
    activeStemDisplayMask,
    stems[0].enabled,
    stems[1].enabled,
    stems[0].status?.phase,
    stems[1].status?.phase,
  ]);

  const updateScratchPreview = useCallback((side: 0 | 1, position: number | null) => {
    scratchPreviewPendingRef.current[side] = position;
    if (scratchPreviewFrameRef.current !== null) return;
    scratchPreviewFrameRef.current = window.requestAnimationFrame(() => {
      scratchPreviewFrameRef.current = null;
      const pending = scratchPreviewPendingRef.current;
      setScratchPreviews((current) => {
        if (current[0] === pending[0] && current[1] === pending[1]) return current;
        return [pending[0], pending[1]];
      });
    });
  }, []);

  const flushJogSeek = useCallback((side: 0 | 1) => {
    const timer = jogSeekTimerRef.current[side];
    if (timer !== null) {
      window.clearTimeout(timer);
      jogSeekTimerRef.current[side] = null;
    }
    const pending = jogSeekPendingRef.current[side];
    jogSeekPendingRef.current[side] = null;
    if (!pending || deckTrackIdsRef.current[side] !== pending.trackId) return;
    cancelPendingSyncCorrection();
    jogSeekSentAtRef.current[side] = performance.now();
    onJogSeekRef.current(side, pending.position);
  }, []);

  const queueJogSeek = useCallback((side: 0 | 1, trackId: number, position: number, flush = false) => {
    jogSeekPendingRef.current[side] = { trackId, position };
    if (flush) {
      flushJogSeek(side);
      return;
    }
    if (jogSeekTimerRef.current[side] !== null) return;
    const wait = Math.max(
      0,
      MIDI_JOG_SEEK_INTERVAL_MS - (performance.now() - jogSeekSentAtRef.current[side]),
    );
    if (wait === 0) {
      flushJogSeek(side);
      return;
    }
    jogSeekTimerRef.current[side] = window.setTimeout(() => flushJogSeek(side), wait);
  }, [flushJogSeek]);

  const discardJogSeek = (side: 0 | 1) => {
    const timer = jogSeekTimerRef.current[side];
    if (timer !== null) window.clearTimeout(timer);
    jogSeekTimerRef.current[side] = null;
    jogSeekPendingRef.current[side] = null;
  };

  const startMidiJogScratch = (side: 0 | 1) => {
    cancelPendingSyncCorrection();
    if (jogTouchRef.current[side]) return;
    jogTouchRef.current[side] = true;
    // A capacitive platter owns the Deck cursor without toggling Play/Pause. Ticks go to the
    // engine immediately as vinyl velocity; note-off still seeks once so a reverse grab can
    // resync the streaming worker.
    discardJogSeek(side);
    const deck = decksRef.current[side];
    const trackId = deck.track?.id;
    const at = Number.isFinite(deck.position) ? deck.position : 0;
    jogAtRef.current[side] = trackId != null
      ? { trackId, position: at, at: performance.now() }
      : null;
    updateScratchPreview(side, at);
    setMidiScratchActive((current) => {
      if (current[side]) return current;
      const next: [boolean, boolean] = [current[0], current[1]];
      next[side] = true;
      return next;
    });
    // Touch is a momentary platter hold for a Deck that is actually playing now, rather than a
    // stale visual row turning into an implicit load/focus request or a hidden PauseDeck.
    onJogScratchStartRef.current(side);
  };

  const finishMidiJogScratch = (side: 0 | 1) => {
    cancelPendingSyncCorrection();
    if (!jogTouchRef.current[side]) return;
    jogTouchRef.current[side] = false;
    const position = jogAtRef.current[side]?.position
      ?? jogSeekPendingRef.current[side]?.position
      ?? null;
    // Ticks already moved the callback needle. Keep one final seek so a reverse grab can rebuild
    // the streaming worker onto that same platter position.
    discardJogSeek(side);
    setMidiScratchActive((current) => {
      if (!current[side]) return current;
      const next: [boolean, boolean] = [current[0], current[1]];
      next[side] = false;
      return next;
    });
    onJogScratchReleaseRef.current(side, position);
    jogAtRef.current[side] = null;
  };

  useEffect(() => () => {
    if (scratchPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(scratchPreviewFrameRef.current);
    }
    ([0, 1] as const).forEach((side) => {
      const timer = jogSeekTimerRef.current[side];
      if (timer !== null) window.clearTimeout(timer);
    });
  }, []);

  useEffect(() => {
    // A jog message from the prior source must not land after a Deck replacement. The actual
    // player clock clears a live preview once the coalesced seek reaches the audio engine.
    // Do not synthesize a release here: a visual row can change before its physical Deck does,
    // and a synthetic release could briefly revive the departing source. A later real note-off
    // is guarded by its original physical track ID in PlayerBar.
    jogTouchRef.current = [false, false];
    setMidiScratchActive([false, false]);
    jogAtRef.current = [null, null];
    ([0, 1] as const).forEach((side) => {
      const timer = jogSeekTimerRef.current[side];
      if (timer !== null) window.clearTimeout(timer);
      jogSeekTimerRef.current[side] = null;
      jogSeekPendingRef.current[side] = null;
    });
    updateScratchPreview(0, null);
    updateScratchPreview(1, null);
  }, [decks[0].track?.id, decks[1].track?.id, updateScratchPreview]);

  useEffect(() => {
    setScratchPreviews((current) => {
      const next: [number | null, number | null] = [current[0], current[1]];
      ([0, 1] as const).forEach((side) => {
        // React state follows the hardware event on the next render. The ref flips in the same
        // MIDI callback, so it prevents a 100ms native transport snapshot from clearing the
        // first visual platter frame while the callback-only hold takes effect.
        if (jogTouchRef.current[side] || midiScratchActive[side]) return;
        const preview = current[side];
        if (
          preview !== null
          && (!decks[side].track || Math.abs(preview - decks[side].position) < 0.08)
        ) {
          next[side] = null;
        }
      });
      return next[0] === current[0] && next[1] === current[1] ? current : next;
    });
  }, [
    decks[0].position,
    decks[1].position,
    decks[0].track?.id,
    decks[1].track?.id,
    midiScratchActive,
  ]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const side = decks[1].active ? 1 : 0;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        onToggleStemAll(side);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [decks[0].active, decks[1].active, onToggleStemAll]);

  const viewDecks = useMemo<[PerformanceDeckModel, PerformanceDeckModel]>(
    () => [
      { ...decks[0], rate: visualRates[0] ?? decks[0].rate },
      { ...decks[1], rate: visualRates[1] ?? decks[1].rate },
    ],
    [decks, visualRates],
  );

  useEffect(() => {
    setVisualRates([null, null]);
    armTempoTakeover(0);
    armTempoTakeover(1);
  }, [decks[0].track?.id, decks[1].track?.id]);

  useEffect(() => {
    setVisualRates((current) => {
      const next: [number | null, number | null] = [
        current[0] != null && Math.abs(current[0] - decks[0].rate) < 0.0005 ? null : current[0],
        current[1] != null && Math.abs(current[1] - decks[1].rate) < 0.0005 ? null : current[1],
      ];
      return next[0] === current[0] && next[1] === current[1] ? current : next;
    });
  }, [decks[0].rate, decks[1].rate]);

  const syncEnabled = Boolean(
    decks[0].track?.bpm
    && decks[1].track?.bpm
    && decks[0].track?.first_beat != null
    && decks[1].track?.first_beat != null,
  );
  const previewDeckRate = (side: 0 | 1, rate: number): number => {
    const bpms = [decks[0].track?.bpm, decks[1].track?.bpm] as const;
    const paired = syncLock
      ? linkedDeckRates(side, rate, bpms, syncLock, ENGINE_TEMPO_MIN, ENGINE_TEMPO_MAX)
      : null;
    const shownRate = paired?.[side] ?? rate;
    setVisualRates((current) => {
      const next: [number | null, number | null] = [
        paired ? paired[0] : side === 0 ? shownRate : current[0],
        paired ? paired[1] : side === 1 ? shownRate : current[1],
      ];
      return next[0] === current[0] && next[1] === current[1] ? current : next;
    });
    return shownRate;
  };

  const requestNativeSync = (side: 0 | 1, masterSide: 0 | 1, rate: number) => {
    const follower = decksRef.current[side].track;
    const master = decksRef.current[masterSide].track;
    if (
      !follower?.bpm
      || !master?.bpm
      || follower.first_beat == null
      || master.first_beat == null
    ) {
      return Promise.resolve(false);
    }
    return Promise.resolve(onSync({
      follower: side,
      master: masterSide,
      rate,
      followerBpm: follower.bpm,
      followerFirstBeat: follower.first_beat,
      masterBpm: master.bpm,
      masterFirstBeat: master.first_beat,
      beatsPerBar: 4,
    }));
  };

  const flushCrossfaderTempoRates = () => {
    if (crossfaderTempoTimerRef.current !== null) {
      window.clearTimeout(crossfaderTempoTimerRef.current);
      crossfaderTempoTimerRef.current = null;
    }
    const rates = crossfaderTempoPendingRef.current;
    crossfaderTempoPendingRef.current = null;
    if (rates) void Promise.resolve(onRatePairChangeRef.current(rates));
  };

  const queueCrossfaderTempoRates = (rates: [number, number], immediate = false) => {
    crossfaderTempoPendingRef.current = rates;
    if (immediate) {
      flushCrossfaderTempoRates();
      return;
    }
    if (crossfaderTempoTimerRef.current !== null) return;
    crossfaderTempoTimerRef.current = window.setTimeout(() => {
      crossfaderTempoTimerRef.current = null;
      flushCrossfaderTempoRates();
    }, TEMPO_COMMAND_INTERVAL_MS);
  };

  const previewCrossfaderTempo = (ratio: number, immediate = false) => {
    if (!crossfaderTempoSyncRef.current) return null;
    const current = decksRef.current;
    const plan = crossfaderTempoPlan(
      ratio,
      [current[0].track?.bpm, current[1].track?.bpm],
      ENGINE_TEMPO_MIN,
      ENGINE_TEMPO_MAX,
    );
    if (!plan) return null;
    setVisualRates(plan.rates);
    queueCrossfaderTempoRates(plan.rates, immediate);
    return plan;
  };

  const handleCrossfaderChange = (value: number, immediate = false) => {
    const next = clamp(value, -1, 1);
    setCrossfader(next);
    previewCrossfaderTempo((next + 1) / 2, immediate);
  };

  const cancelPendingSyncCorrection = () => {
    syncInteractionRevisionRef.current += 1;
  };

  const handleManualSeek: PerformanceWorkspaceProps["onSeek"] = (side, detail) => {
    cancelPendingSyncCorrection();
    onSeek(side, detail);
  };
  const handleManualSetLoop: PerformanceWorkspaceProps["onSetLoop"] = (side, start, length) => {
    cancelPendingSyncCorrection();
    onSetLoop(side, start, length);
  };
  const handleManualClearLoop: PerformanceWorkspaceProps["onClearLoop"] = (side) => {
    cancelPendingSyncCorrection();
    onClearLoop(side);
  };
  const handleManualScratchHold: PerformanceWorkspaceProps["onScratchHold"] = (side) => {
    cancelPendingSyncCorrection();
    onScratchHold(side);
  };
  const handleManualScratchRelease: PerformanceWorkspaceProps["onScratchRelease"] = (
    side,
    position,
    resume,
  ) => {
    cancelPendingSyncCorrection();
    onScratchRelease(side, position, resume);
  };
  const handleManualTogglePlay: PerformanceWorkspaceProps["onTogglePlay"] = (side) => {
    cancelPendingSyncCorrection();
    onTogglePlay(side);
  };
  const handleManualMainCue: PerformanceWorkspaceProps["onMainCue"] = (side, position) => {
    cancelPendingSyncCorrection();
    onMainCue(side, position);
  };
  const handleManualTrackDrop: PerformanceWorkspaceProps["onTrackDrop"] = (side, ids) => {
    cancelPendingSyncCorrection();
    onTrackDrop(side, ids);
  };

  const toggleSyncLock = (side: 0 | 1) => {
    if (crossfaderTempoSyncRef.current) {
      crossfaderTempoSyncRef.current = false;
      setCrossfaderTempoSync(false);
      flushCrossfaderTempoRates();
    }
    if (syncLock) {
      // 两个亮起的关联按钮都可解除锁定；保持当前速度，与 DJ 台 SYNC off 一致。
      cancelPendingSyncCorrection();
      syncLockRef.current = null;
      setSyncLock(null);
      return;
    }
    const other = (1 - side) as 0 | 1;
    const baseBpm = decks[side].track?.bpm;
    const otherDeck = decks[other];
    if (!baseBpm || !otherDeck.track?.bpm) return;
    // 把按下的这台对齐到另一台的有效 BPM（先试半倍/原倍/双倍取最近档）。
    // 推子量程只钉拇指；真实速率按引擎 0.5–2.0 走，机体推子仍停在原位，走软接管。
    const plan = deckSyncRate(
      otherDeck.track.bpm * otherDeck.rate,
      baseBpm,
      ENGINE_TEMPO_MIN,
      ENGINE_TEMPO_MAX,
    );
    if (!plan) return;
    armTempoTakeover(side);
    setVisualRates((current) => {
      const next: [number | null, number | null] = [current[0], current[1]];
      next[side] = plan.rate;
      return next;
    });
    const nextLock = { base: side, multiple: plan.multiple } as const;
    const operationRevision = syncInteractionRevisionRef.current + 1;
    syncInteractionRevisionRef.current = operationRevision;
    syncLockRef.current = nextLock;
    setSyncLock(nextLock);
    void requestNativeSync(side, other, plan.rate).then((applied) => {
      const activeLock = syncLockRef.current;
      if (
        applied
        || syncInteractionRevisionRef.current !== operationRevision
        || activeLock?.base !== nextLock.base
        || activeLock.multiple !== nextLock.multiple
      ) return;
      syncLockRef.current = null;
      setSyncLock(null);
      setVisualRates((current) => {
        const next: [number | null, number | null] = [current[0], current[1]];
        next[side] = null;
        return next;
      });
    }).catch(() => undefined);
  };
  const handleDeckRateChange = (side: 0 | 1, rate: number) => {
    cancelPendingSyncCorrection();
    const other = (1 - side) as 0 | 1;
    const relation = syncLockRef.current;
    const current = decksRef.current;
    const paired = relation
      ? linkedDeckRates(
        side,
        rate,
        [current[0].track?.bpm, current[1].track?.bpm],
        relation,
        ENGINE_TEMPO_MIN,
        ENGINE_TEMPO_MAX,
      )
      : null;
    if (paired) {
      const hardware = tempoTakeoverRef.current.hardwareUnit[other];
      if (hardware != null) showTempoHardware(other, hardware);
      return Promise.resolve(onRatePairChange(paired));
    }
    return Promise.resolve(onRateChange(side, rate));
  };

  useEffect(() => {
    const current: [boolean, boolean] = [decks[0].playing, decks[1].playing];
    const previous = syncPlayingRef.current;
    syncPlayingRef.current = current;
    const trackIds: [number | null, number | null] = [
      decks[0].track?.id ?? null,
      decks[1].track?.id ?? null,
    ];
    const tracksChanged = syncTrackIdsRef.current[0] !== trackIds[0]
      || syncTrackIdsRef.current[1] !== trackIds[1];
    syncTrackIdsRef.current = trackIds;
    // 第一次只记下走带状态。不能把挂载时已经在播的 Deck 当成「刚起播」去 seek。
    if (previous === null || !syncLock || tracksChanged) return;
    if (scratchPreviews[0] != null || scratchPreviews[1] != null) return;
    // 对拍只允许发生在起播边沿。旧实现每 100ms 跟播放头改一次 rate，
    // 第二台一开播就会把 BPM、波形缩放和 IPC 打进正反馈，整台卡死。
    ([0, 1] as const).forEach((side) => {
      const other = (1 - side) as 0 | 1;
      if (!shouldQuantizeSyncOnPlay(current[side], previous[side], previous[other])) return;
      const started = decks[side];
      const reference = decks[other];
      if (!started.track || !reference.track) return;
      void requestNativeSync(side, other, started.rate).catch(() => undefined);
    });
  }, [
    syncLock,
    scratchPreviews[0],
    scratchPreviews[1],
    decks[0].playing,
    decks[1].playing,
    decks[0].track?.id,
    decks[1].track?.id,
  ]);

  const scratchMultiple = (side: 0 | 1) =>
    syncLock
      ? (syncLock.base === side ? syncLock.multiple : 1 / syncLock.multiple)
      : 1;

  const patchMixer = (side: 0 | 1, patch: Partial<PerformanceMixerValues>) => {
    setMixers((current) => {
      const merged = { ...current[side], ...patch };
      const next: [PerformanceMixerValues, PerformanceMixerValues] = [current[0], current[1]];
      next[side] = {
        ...merged,
        gain: snapKnobToCenter(merged.gain, -1, 1),
        high: snapKnobToCenter(merged.high, -1, 1),
        mid: snapKnobToCenter(merged.mid, -1, 1),
        low: snapKnobToCenter(merged.low, -1, 1),
        filter: snapKnobToCenter(merged.filter, -1, 1),
      };
      return next;
    });
  };
  const adjustMixerEq = (side: 0 | 1, delta: EqGraphValues) => {
    setMixers((current) => {
      const present = current[side];
      const relative = (value: number, change: number) => {
        const next = clamp(value + change, -1, 1);
        return Math.abs(next) < 0.000_5 ? 0 : next;
      };
      const updated: PerformanceMixerValues = {
        ...present,
        low: relative(present.low, delta.low),
        mid: relative(present.mid, delta.mid),
        high: relative(present.high, delta.high),
      };
      if (
        updated.low === present.low
        && updated.mid === present.mid
        && updated.high === present.high
      ) return current;
      return side === 0 ? [updated, current[1]] : [current[0], updated];
    });
  };
  const toggleStemLayer = (side: 0 | 1) => {
    setEqStemMode((current) => {
      const next: [EqStemLayer, EqStemLayer] = [current[0], current[1]];
      next[side] = toggleEqStemLayer(current[side]);
      return next;
    });
  };
  const toggleCrossfaderEnabled = () => {
    setCrossfaderEnabled((on) => {
      if (on) handleCrossfaderChange(0, true);
      return !on;
    });
  };

  const disableCrossfaderTempoSync = () => {
    cancelPendingSyncCorrection();
    crossfaderTempoSyncRef.current = false;
    setCrossfaderTempoSync(false);
    flushCrossfaderTempoRates();
    syncLockRef.current = null;
    setSyncLock(null);
  };

  const toggleCrossfaderTempoSync = () => {
    if (crossfaderTempoSyncRef.current) {
      disableCrossfaderTempoSync();
      return;
    }
    const current = decksRef.current;
    const bpms = [current[0].track?.bpm, current[1].track?.bpm] as const;
    const ratio = ((crossfaderEnabled ? crossfader : 0) + 1) / 2;
    const plan = crossfaderTempoPlan(
      ratio,
      bpms,
      ENGINE_TEMPO_MIN,
      ENGINE_TEMPO_MAX,
    );
    // Both endpoints must be reachable, otherwise an extreme fader position would silently
    // break the lock or move the audible Deck away from its own original BPM.
    const endpointsReachable = crossfaderTempoPlan(0, bpms)
      && crossfaderTempoPlan(1, bpms);
    if (!syncEnabled || !plan || !endpointsReachable) return;

    cancelPendingSyncCorrection();
    const operationRevision = syncInteractionRevisionRef.current;
    crossfaderTempoSyncRef.current = true;
    setCrossfaderTempoSync(true);
    syncLockRef.current = plan.relation;
    setSyncLock(plan.relation);
    armTempoTakeover(0);
    armTempoTakeover(1);
    setVisualRates(plan.rates);

    const master = (ratio <= 0.5 ? 0 : 1) as 0 | 1;
    const follower = (1 - master) as 0 | 1;
    void Promise.resolve(onRatePairChangeRef.current(plan.rates))
      .then((applied) => {
        if (
          !applied
          || !crossfaderTempoSyncRef.current
          || syncInteractionRevisionRef.current !== operationRevision
        ) return false;
        return requestNativeSync(follower, master, plan.rates[follower]);
      })
      .then((aligned) => {
        if (aligned || !crossfaderTempoSyncRef.current) return;
        disableCrossfaderTempoSync();
      })
      .catch(() => disableCrossfaderTempoSync());
  };
  const shiftHeldRef = useRef(false);
  const moveJogPosition = (
    side: 0 | 1,
    delta: number,
    wholeTrack: boolean,
    commitToTransport = true,
  ) => {
    cancelPendingSyncCorrection();
    const deck = decksRef.current[side];
    const trackId = deck.track?.id;
    if (trackId == null || delta === 0) return;
    const now = performance.now();
    const held = jogTouchRef.current[side];
    const from = midiJogCursorPosition(
      jogAtRef.current[side],
      trackId,
      deck.position,
      now,
      held,
    );
    const deltaSec = wholeTrack
      ? midiJogSeekSeconds(delta, deck.duration)
      : midiJogVinylSeconds(delta);
    const at = clampJogPosition(from + deltaSec, deck.duration);
    jogAtRef.current[side] = { trackId, position: at, at: now };
    updateScratchPreview(side, at);
    if (commitToTransport) {
      // Shift+jog still coalesces absolute seeks so a fast spin cannot rebuild decoders.
      queueJogSeek(side, trackId, at);
    } else if (held) {
      onJogScratchTickRef.current(side, deltaSec);
    }
  };
  const applyMidiAction = (action: MidiResolvedAction) => {
    switch (action.type) {
      case "playToggle":
        handleManualTogglePlay(action.deck);
        return;
      case "cue": {
        const deck = decks[action.deck];
        const cue = deck.track?.cue_ms != null ? deck.track.cue_ms / 1000 : (deck.track?.first_beat ?? 0);
        handleManualMainCue(action.deck, cue);
        return;
      }
      case "sync":
        toggleSyncLock(action.deck);
        return;
      case "eqHigh":
        if (action.deck != null) patchMixer(action.deck, { high: action.value });
        return;
      case "eqMid":
        if (action.deck != null) patchMixer(action.deck, { mid: action.value });
        return;
      case "eqLow":
        if (action.deck != null) patchMixer(action.deck, { low: action.value });
        return;
      case "filter":
        if (action.deck != null) patchMixer(action.deck, { filter: action.value });
        return;
      case "gain":
        if (action.deck != null) patchMixer(action.deck, { gain: action.value });
        return;
      case "volume":
        if (action.deck != null) patchMixer(action.deck, { volume: action.value });
        return;
      case "crossfader":
        if (crossfaderEnabled) handleCrossfaderChange(action.value);
        return;
      case "toggleCrossfader":
        toggleCrossfaderEnabled();
        return;
      case "shiftHold":
        shiftHeldRef.current = action.held;
        return;
      case "master":
        onMasterVolumeChange(action.value);
        return;
      case "tempo":
        if (action.deck != null) {
          const range = deckTempoRange(action.deck);
          const incomingRate = scaleUnitToRange(action.value, range.min, range.max);
          const softwareRate = visualRates[action.deck] ?? decks[action.deck].rate;
          const currentUnit = scaleRangeToUnit(softwareRate, range.min, range.max);
          const incomingUnit = scaleRangeToUnit(incomingRate, range.min, range.max);
          tempoTakeoverRef.current.hardwareUnit[action.deck] = action.value;
          if (tempoTakeoverRef.current.lanes[action.deck].ignore(currentUnit, incomingUnit)) {
            showTempoHardware(action.deck, action.value);
            return;
          }
          showTempoHardware(action.deck, null);
          const previewedRate = previewDeckRate(action.deck, incomingRate);
          handleDeckRateChange(action.deck, previewedRate);
        }
        return;
      case "toggleEqStem":
        toggleStemLayer(action.deck);
        return;
      case "stemGain":
        for (const stem of action.stems) {
          if (stemOptions(stemMode).some((option) => option.stem === stem)) {
            onStemGain(action.deck, stem, stemEqToGain(action.value));
          }
        }
        return;
      case "loopToggle": {
        const deck = decks[action.deck];
        const beat = beatSeconds(deck.track);
        if (!deck.track || !beat) return;
        if (deck.loopStart !== null && deck.loopLength !== null) {
          handleManualClearLoop(action.deck);
          return;
        }
        const start = snapCueSeconds(deck.position, deck.track.bpm, deck.track.first_beat, quantize);
        const length = loopBeats[action.deck] * beat;
        if (start + length > deck.duration + 0.05) return;
        handleManualSetLoop(action.deck, start, length);
        return;
      }
      case "loopSize": {
        const beats = nextLoopBeats(loopBeats[action.deck], action.delta);
        setLoopBeats((current) => {
          const next: [number, number] = [current[0], current[1]];
          next[action.deck] = beats;
          return next;
        });
        const deck = decks[action.deck];
        const beat = beatSeconds(deck.track);
        if (deck.loopStart !== null && beat) {
          handleManualSetLoop(action.deck, deck.loopStart, beats * beat);
        }
        return;
      }
      case "jogTouch":
        if (action.held) startMidiJogScratch(action.deck);
        else finishMidiJogScratch(action.deck);
        return;
      case "jog":
        // A JSON mapping normally resolves this to jogSeek before it reaches the workspace.
        // Keep the runtime guard for custom mappings that only expose a Shift hold signal.
        if (shiftHeldRef.current) {
          moveJogPosition(action.deck, action.delta, true, !jogTouchRef.current[action.deck]);
        } else if (jogTouchRef.current[action.deck]) {
          moveJogPosition(action.deck, action.delta, false, false);
        } else {
          cancelPendingSyncCorrection();
          onJogNudgeRef.current(action.deck, midiJogNudgeAmount(action.delta));
        }
        return;
      // Keep hand-written mappings using the old names operational. The Buddy preset uses the
      // explicit jog/jogTouch pair above, so only legacy maps retain the old stop-and-scratch
      // interpretation.
      case "scratchTouch":
        if (action.held) startMidiJogScratch(action.deck);
        else finishMidiJogScratch(action.deck);
        return;
      case "scratch":
        if (shiftHeldRef.current) {
          moveJogPosition(action.deck, action.delta, true, !jogTouchRef.current[action.deck]);
          return;
        }
        if (jogTouchRef.current[action.deck]) {
          moveJogPosition(action.deck, action.delta, false, false);
        } else {
          // Older mappings expose only a rotary "scratch" message and have no reliable release
          // edge. Treat that as an edge pitch-bend; pausing it here would have no matching resume
          // command and left the Deck permanently stopped.
          cancelPendingSyncCorrection();
          onJogNudgeRef.current(action.deck, midiJogNudgeAmount(action.delta));
        }
        return;
      case "jogSeek":
        // Shift overrides both edge nudge and the capacitive surface: its scope is intentionally
        // the full track, but the latest-value lane keeps it from resetting playback/loading.
        moveJogPosition(action.deck, action.delta, true, !jogTouchRef.current[action.deck]);
        return;
      case "browseStep":
        if (action.delta === 0) return;
        window.dispatchEvent(new CustomEvent(MIDI_BROWSE_EVENT, { detail: { type: "step", delta: action.delta } }));
        return;
      case "browsePress":
        window.dispatchEvent(new CustomEvent(MIDI_BROWSE_EVENT, { detail: { type: "press" } }));
        return;
      case "loadSelected":
        window.dispatchEvent(new CustomEvent(MIDI_BROWSE_EVENT, { detail: { type: "load", deck: action.deck } }));
        return;
    }
  };

  const midiLiveRef = useRef({
    apply: applyMidiAction,
    mapping: null as MidiMapping | null,
    port: null as string | null,
    fourteenBit: new MidiFourteenBit(),
  });
  midiLiveRef.current.apply = applyMidiAction;
  const eqStemModeRef = useRef(eqStemMode);
  eqStemModeRef.current = eqStemMode;
  const midiLedRef = useRef(new Map<string, number>());
  const midiEchoRef = useRef(new MidiEchoGuard());

  useEffect(() => {
    return subscribeMidi((devices) => {
      const selected = selectMappedPort(devices, MIDI_PRESETS);
      midiLiveRef.current.mapping = selected?.mapping ?? null;
      midiLiveRef.current.port = selected?.port ?? null;
      setMidiPort(selected?.port ?? null);
    }, (message) => {
      const mapping = mappingForPort(message.port, MIDI_PRESETS) ?? midiLiveRef.current.mapping;
      if (!mapping) return;
      midiLiveRef.current.mapping = mapping;
      const parsed = parseMidiBytes(message.bytes);
      if (parsed && midiEchoRef.current.isEcho(parsed)) return;
      const layers: MidiLayerState = { eqStem: eqStemModeRef.current, shift: shiftHeldRef.current };
      for (const action of dispatchMidiMessage(mapping, message, layers, midiLiveRef.current.fourteenBit)) {
        midiLiveRef.current.apply(action);
      }
    });
  }, []);

  useEffect(() => {
    const mapping = midiLiveRef.current.mapping;
    if (!mapping || !midiPort) return;
    const feedback: MidiFeedback = {
      playing: [decks[0].playing, decks[1].playing],
      pausedLoaded: [
        Boolean(decks[0].track) && !decks[0].playing,
        Boolean(decks[1].track) && !decks[1].playing,
      ],
      syncing: [syncLock !== null, syncLock !== null],
      looping: [
        decks[0].loopStart !== null && decks[0].loopLength !== null,
        decks[1].loopStart !== null && decks[1].loopLength !== null,
      ],
      eqStem: [eqStemMode[0] === "stems", eqStemMode[1] === "stems"],
      crossfaderEnabled,
    };
    void sendMidiOutputs(mapping, feedback, midiLedRef.current, midiEchoRef.current);
  }, [
    decks[0].playing,
    decks[1].playing,
    decks[0].track?.id,
    decks[1].track?.id,
    decks[0].loopStart,
    decks[1].loopStart,
    decks[0].loopLength,
    decks[1].loopLength,
    eqStemMode,
    crossfaderEnabled,
    midiPort,
    syncLock,
  ]);

  const renderTempo = (side: 0 | 1) => (
    <div className="kd-performance-mixer-tempo" data-side={side === 0 ? "a" : "b"}>
      <TempoPanel
        deck={viewDecks[side]}
        side={side}
        locked={syncLock !== null}
        syncEnabled={syncEnabled}
        onToggleSync={toggleSyncLock}
        onRateChange={handleDeckRateChange}
        onPreviewRate={previewDeckRate}
        hardwareUnit={tempoHardwareUnit[side]}
        onSoftwareTempoOverride={armTempoTakeover}
      />
    </div>
  );
  const crossfaderValue = crossfaderEnabled ? crossfader : 0;
  const crossfaderRatio = (crossfaderValue + 1) / 2;
  const crossfaderTempoBpms = [
    decks[0].track?.bpm,
    decks[1].track?.bpm,
  ] as const;
  const crossfaderTempoSyncAvailable = Boolean(
    syncEnabled
    && crossfaderTempoPlan(0, crossfaderTempoBpms)
    && crossfaderTempoPlan(1, crossfaderTempoBpms),
  );
  const triggerSampler = (slot: number) => {
    const track = samplerTracks[slot];
    if (!track) return;
    samplerAudioRef.current[slot]?.pause();
    const audio = new Audio(mediaUrlForTrack(track));
    audio.preload = "auto";
    audio.volume = masterVolume;
    samplerAudioRef.current[slot] = audio;
    const start = Math.max(0, (track.cue_ms ?? 0) / 1000);
    const play = () => {
      try { audio.currentTime = start; } catch { /* metadata may still be settling */ }
      void audio.play().catch(() => undefined);
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) play();
    else audio.addEventListener("loadedmetadata", play, { once: true });
  };
  const patchFxSlot = (side: 0 | 1, index: number, patch: Partial<FxSlot>) => {
    setFxSlots((current) => {
      const next: [DeckFxSlots, DeckFxSlots] = [
        [...current[0]] as DeckFxSlots,
        [...current[1]] as DeckFxSlots,
      ];
      next[side][index] = { ...next[side][index], ...patch };
      return next;
    });
  };
  const selectFxMode = (side: 0 | 1, mode: FxPanelMode) => {
    setHeldPadFx((current) => side === 0 ? [0, current[1]] : [current[0], 0]);
    setFxMode((current) => side === 0 ? [mode, current[1]] : [current[0], mode]);
  };
  const holdPadFx = (side: 0 | 1, pad: number) => {
    setHeldPadFx((current) => side === 0 ? [pad, current[1]] : [current[0], pad]);
  };
  const renderFxBank = (side: 0 | 1) => (
    <section
      className="kd-performance-deck-fx-bank"
      data-side={side === 0 ? "a" : "b"}
      data-targeted="true"
      aria-label={side === 0 ? "Deck A 3 FX" : "Deck B 3 FX"}
    >
      <header><b>3 FX</b></header>
      <div className="kd-performance-fx-knobs">
        {fxSlots[side].map((slot, index) => (
          <FxSlotControl key={index} slot={slot} onChange={(patch) => patchFxSlot(side, index, patch)} />
        ))}
      </div>
    </section>
  );
  const renderDeckFxPage = (side: 0 | 1) => (
    <div className="kd-performance-deck-fx-page">
      <div className="kd-performance-fx-toolbar">
        <span className="kd-performance-fx-modes">
          {([
            ["knobs", "3 FX"],
            ["pads", "PAD FX"],
            ["sampler", "采样器"],
          ] as const).map(([mode, label]) => (
            <button key={mode} type="button" data-active={fxMode[side] === mode || undefined} onClick={() => selectFxMode(side, mode)}>{label}</button>
          ))}
        </span>
      </div>
      {fxMode[side] === "knobs" ? renderFxBank(side) : fxMode[side] === "pads" ? (
        <div className="kd-performance-pad-fx">
          {PAD_FX_LABELS.map((label, index) => {
            const pad = index + 1;
            return (
              <button
                key={label}
                type="button"
                data-active={heldPadFx[side] === pad || undefined}
                onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); holdPadFx(side, pad); }}
                onPointerUp={() => holdPadFx(side, 0)}
                onPointerCancel={() => holdPadFx(side, 0)}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="kd-performance-sampler-pads">
          {samplerTracks.map((track, slot) => (
            <button
              key={slot}
              type="button"
              {...{ [TRACK_SAMPLER_DROP_TARGET_ATTR]: String(slot) }}
              title={track?.title || track?.filename || undefined}
              aria-label={track ? `重触发采样 ${track.title || track.filename}` : `采样槽 ${slot + 1}`}
              onClick={() => triggerSampler(slot)}
              onContextMenu={(event) => {
                event.preventDefault();
                samplerAudioRef.current[slot]?.pause();
                setSamplerSlotIds((current) => current.map((value, index) => index === slot ? null : value));
              }}
              onDragOver={(event) => { if (isTrackDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
              onDrop={(event) => {
                if (!isTrackDrag(event)) return;
                event.preventDefault();
                const id = readTrackDragIds(event.dataTransfer)[0];
                finishTrackDrop();
                if (id != null) void assignSamplerSlot(slot, id);
              }}
            >
              {track ? <span>{track.title || track.filename}</span> : <Plus size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const selectDeckPadPage = (side: 0 | 1, page: DeckPadPage) => {
    setDeckPadPage((current) => side === 0 ? [page, current[1]] : [current[0], page]);
  };
  const triggerLoopPad = (side: 0 | 1, beats: number) => {
    const deck = viewDecks[side];
    const track = deck.track;
    const beat = beatSeconds(track);
    setLoopBeats((current) => side === 0 ? [beats, current[1]] : [current[0], beats]);
    if (!track || !beat) return;
    const looping = deck.loopStart !== null && deck.loopLength !== null;
    if (looping && loopBeats[side] === beats) {
      handleManualClearLoop(side);
      return;
    }
    const start = deck.loopStart ?? snapCueSeconds(deck.position, track.bpm, track.first_beat, quantize);
    if (start + beats * beat > deck.duration + 0.05) return;
    handleManualSetLoop(side, start, beats * beat);
  };
  const renderDeckPadPanel = (side: 0 | 1) => (
    <section
      className="kd-performance-deck-pad-bank"
      data-page={deckPadPage[side]}
      aria-label={side === 0 ? "Deck A 演奏垫" : "Deck B 演奏垫"}
    >
      <header className="kd-performance-pad-page-tabs" role="tablist" aria-label="演奏垫模式">
        {(["cue", "loop", "fx"] as const).map((page) => (
          <button
            key={page}
            type="button"
            role="tab"
            aria-selected={deckPadPage[side] === page}
            aria-label={page === "cue" ? "Hot Cue" : page === "loop" ? "Loop" : "效果器"}
            title={page === "cue" ? "Hot Cue" : page === "loop" ? "Loop" : "效果器"}
            data-active={deckPadPage[side] === page || undefined}
            onClick={() => selectDeckPadPage(side, page)}
          >
            {page === "cue" ? <CircleDot size={13} /> : page === "loop" ? <Repeat2 size={14} /> : <b>FX</b>}
          </button>
        ))}
      </header>
      <div className="kd-performance-pad-page-content">
        {deckPadPage[side] === "cue" ? (
          <HotCuePads deck={viewDecks[side]} side={side} quantize={quantize} onSeek={handleManualSeek} onSaveCuePoints={onSaveCuePoints} />
        ) : deckPadPage[side] === "loop" ? (
          <div className="kd-performance-loop-pads">
            {LOOP_BEAT_CHOICES.map((beats) => (
              <button
                key={beats}
                type="button"
                data-active={viewDecks[side].loopStart !== null && loopBeats[side] === beats || undefined}
                disabled={!viewDecks[side].track || !beatSeconds(viewDecks[side].track)}
                onClick={() => triggerLoopPad(side, beats)}
              >
                <b>{beats < 1 ? "1/" + Math.round(1 / beats) : beats}</b>
                <span>BEATS</span>
              </button>
            ))}
          </div>
        ) : renderDeckFxPage(side)}
      </div>
    </section>
  );
  const renderDeckMain = (side: 0 | 1) => (
    <section
      className="kd-performance-main-deck"
      data-side={side === 0 ? "a" : "b"}
      {...{ [TRACK_DECK_DROP_TARGET_ATTR]: String(side) }}
      onDragOver={(event) => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        event.currentTarget.dataset.kdNativeTrackOver = "true";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          delete event.currentTarget.dataset.kdNativeTrackOver;
        }
      }}
      onDrop={(event) => {
        if (!isTrackDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const ids = readTrackDragIds(event.dataTransfer);
        delete event.currentTarget.dataset.kdNativeTrackOver;
        finishTrackDrop();
        if (ids.length) handleManualTrackDrop(side, ids);
      }}
    >
      {renderTempo(side)}
      {renderDeckPadPanel(side)}
      <div className="kd-performance-deck-mix-module">
        <MixerStrip
          side={side}
          mixer={mixers[side]}
          playing={viewDecks[side].playing}
          setMixer={(patch) => patchMixer(side, patch)}
          adjustEq={(delta) => adjustMixerEq(side, delta)}
        />
        <div className="kd-performance-gain-fader">
          <div className="kd-performance-gain-stack">
            <ArcKnob size="xs" label="GAIN" value={mixers[side].gain} onChange={(gain) => patchMixer(side, { gain })} onReset={() => patchMixer(side, { gain: 0 })} />
            <ChannelFader
              side={side}
              mixer={mixers[side]}
              setMixer={(patch) => patchMixer(side, patch)}
            />
          </div>
          <ArcKnob size="xl" label="FILTER" value={mixers[side].filter} onChange={(filter) => patchMixer(side, { filter })} onReset={() => patchMixer(side, { filter: 0 })} />
        </div>
      </div>
    </section>
  );
  const renderDeckTransport = (side: 0 | 1) => (
    <div className="kd-performance-deck-transport-row" data-side={side === 0 ? "a" : "b"}>
      <DeckTransport
        deck={decks[side]}
        side={side}
        quantize={quantize}
        onTogglePlay={handleManualTogglePlay}
        onMainCue={handleManualMainCue}
        onSaveMainCue={onSaveMainCue}
      />
      <LoopControls
        deck={viewDecks[side]}
        side={side}
        beats={loopBeats[side]}
        jumpBeats={jumpBeats[side]}
        quantize={quantize}
        onBeats={(beats) => setLoopBeats((current) => side === 0 ? [beats, current[1]] : [current[0], beats])}
        onJumpBeats={(beats) => setJumpBeats((current) => side === 0 ? [beats, current[1]] : [current[0], beats])}
        onSetLoop={handleManualSetLoop}
        onClearLoop={handleManualClearLoop}
        onSeek={handleManualSeek}
      />
    </div>
  );
  const crossfaderControl = (
    <div
      className="kd-performance-dock-crossfader"
      data-off={crossfaderEnabled ? undefined : true}
      data-tempo-sync={crossfaderTempoSync || undefined}
    >
      <button
        type="button"
        className="kd-performance-crossfader-lock"
        aria-pressed={!crossfaderEnabled}
        aria-label={crossfaderEnabled ? "锁定横推" : "解锁横推"}
        title={crossfaderEnabled ? "锁定横推并回中" : "解锁横推"}
        onClick={toggleCrossfaderEnabled}
      >
        {crossfaderEnabled ? <LockOpen size={13} /> : <Lock size={13} />}
      </button>
      <span className="kd-performance-crossfader-capsule">
        <MixerFader
          axis="horizontal"
          value={crossfaderRatio}
          label="Crossfader A B"
          disabled={!crossfaderEnabled}
          onChange={(ratio) => handleCrossfaderChange(ratio * 2 - 1)}
          onGestureEnd={flushCrossfaderTempoRates}
          onReset={() => handleCrossfaderChange(0, true)}
        />
      </span>
      <button
        type="button"
        className="kd-performance-crossfader-tempo-sync"
        data-active={crossfaderTempoSync || undefined}
        aria-pressed={crossfaderTempoSync}
        aria-label="横推联动 BPM 与对拍"
        title={crossfaderTempoSync
          ? "关闭横推 BPM/小节对拍联动（保留当前速度）"
          : "开启横推 BPM/小节对拍联动"}
        disabled={!crossfaderTempoSyncAvailable}
        onClick={toggleCrossfaderTempoSync}
      >
        BPM
      </button>
    </div>
  );

  return (
    <>
      <div className="kd-performance-workspace" data-testid="performance-workspace">
        <div className="kd-performance-wave-stack" aria-label="Deck A/B 实时滚动波形">
          {([0, 1] as const).map((side) => {
            const position = scratchPreviews[side] ?? decks[side].position;
            const interactiveScrub = midiScratchActive[side] || scratchPreviews[side] != null;
            const other = (1 - side) as 0 | 1;
            return (
              <PerformanceDeckWaves
                key={side}
                deck={viewDecks[side]}
                other={viewDecks[other]}
                stemState={stems[side]}
                stemMode={stemMode}
                side={side}
                position={position}
                interactiveScrub={interactiveScrub}
                snapRail={false}
                displayMask={activeStemDisplayMask}
                waveforms={stemWaveforms[side]}
                autoBeatSync={autoBeatSync}
                syncMultiple={scratchMultiple(side)}
                onSeek={handleManualSeek}
                onScratchHold={handleManualScratchHold}
                onScratchRelease={handleManualScratchRelease}
                onScratchPreview={updateScratchPreview}
                onScratchTick={onJogScratchTick}
                onTrackDrop={handleManualTrackDrop}
                cornerControl={side === 0 ? (
                  <WaveDisplayMenu
                    vocalVisible={(activeStemDisplayMask & VOCAL_WAVE_BIT) !== 0}
                    onToggleVocal={() => setActiveStemDisplayMask((mask) =>
                      (mask & VOCAL_WAVE_BIT) !== 0
                        ? ORIGINAL_WAVE_BIT
                        : ORIGINAL_WAVE_BIT | VOCAL_WAVE_BIT)}
                  />
                ) : undefined}
              />
            );
          })}
        </div>
        <div
          className="kd-performance-info-grid"
          aria-label="Deck A/B 整曲预览波形"
          {...{ [TRACK_DECK_DROP_TARGET_ATTR]: TRACK_DECK_SPLIT_DROP_TARGET }}
          onDragOver={(event) => {
            if (!isTrackDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dataset.kdNativeTrackOver = event.clientX < rect.left + rect.width / 2 ? "0" : "1";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              delete event.currentTarget.dataset.kdNativeTrackOver;
            }
          }}
          onDrop={(event) => {
            if (!isTrackDrag(event)) return;
            event.preventDefault();
            const ids = readTrackDragIds(event.dataTransfer);
            const rect = event.currentTarget.getBoundingClientRect();
            const side = event.clientX < rect.left + rect.width / 2 ? 0 : 1;
            delete event.currentTarget.dataset.kdNativeTrackOver;
            finishTrackDrop();
            if (ids.length) handleManualTrackDrop(side, ids);
          }}
        >
          <StableDeckInfo deck={decks[0]} side={0} preserveBarPhase={autoBeatSync} quantize={quantize} onSeek={handleManualSeek} onTogglePlay={handleManualTogglePlay} onMainCue={handleManualMainCue} onSaveMainCue={onSaveMainCue} />
          <StableDeckInfo deck={decks[1]} side={1} preserveBarPhase={autoBeatSync} quantize={quantize} onSeek={handleManualSeek} onTogglePlay={handleManualTogglePlay} onMainCue={handleManualMainCue} onSaveMainCue={onSaveMainCue} />
        </div>
        <div className="kd-performance-mixer-dock" data-testid="performance-control-panel" aria-label="双 Deck 混音台">
          <div className="kd-performance-main-decks">
            {renderDeckMain(0)}
            {renderDeckMain(1)}
          </div>
          <div className="kd-performance-transport-layout">
            {renderDeckTransport(0)}
            {crossfaderControl}
            {renderDeckTransport(1)}
          </div>
        </div>
      </div>
    </>
  );
}
