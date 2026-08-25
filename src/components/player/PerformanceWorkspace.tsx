import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AudioLines, ChevronDown, Lock, LockOpen, Minus, Pause, Play, Plus } from "lucide-react";
import {
  channelFaderGain,
  crossfaderChannelGains,
  HOT_CUE_COLORS,
  HOT_CUE_PAD_COUNT,
  removeHotCue,
  shouldDropSeekPreview,
  snapCueSeconds,
  updateHotCueComment,
  upsertHotCue,
} from "../../lib/performanceCues";
import { api } from "../../lib/api";
import { camelotColor, parseCamelot } from "../../lib/camelot";
import { formatDuration, formatSignedDuration } from "../../lib/format";
import { PERFORMANCE_PREROLL_SECONDS } from "../../lib/deckPosition";
import {
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  STREAM_DECK_DROP_EVENT,
  TRACK_DECK_DROP_EVENT,
  TRACK_DECK_DROP_TARGET_ATTR,
  TRACK_DECK_SPLIT_DROP_TARGET,
  TRACK_SAMPLER_DROP_EVENT,
  TRACK_SAMPLER_DROP_TARGET_ATTR,
  type StreamDeckDropDetail,
  type TrackDeckDropDetail,
  type TrackSamplerDropDetail,
} from "../../lib/trackDrag";
import {
  finishSearchDrop,
  isSearchAudioDrag,
  readSearchDrop,
  searchAudioSource,
} from "../../lib/searchDrag";
import type {
  CuePoint,
  StemRuntimeStatus,
  StemMode,
  StemName,
  Track,
  TrackStemStatus,
} from "../../types";
import {
  detailWaveformBuckets,
  performanceWaveformViewportSeconds,
} from "../../lib/waveformViewport";
import { performanceWaveformAmplitudeScale } from "../../lib/waveformRenderPolicy";
import { useDjConfig } from "../../lib/djMix";
import {
  getLiveDeckSpectrum,
  type UnifiedDeckSyncRequest,
  type UnifiedPlatterEvent,
  type UnifiedSyncState,
} from "../../lib/unifiedPlayer";
import {
  EQ_GRAPH_BAND_COUNT,
  EQ_GRAPH_FREQUENCIES,
  channelFilterCutoffHz,
  channelFilterDbAtRatio,
  channelFilterResonanceQ,
  eqCurveDbAtRatio,
  eqDbToGraphRatio,
  eqGestureWeights,
  eqSpectrumLevelToRatio,
  type EqGraphValues,
} from "../../lib/eqGraph";
import { useAppStore } from "../../stores/appStore";
import {
  ENGINE_TEMPO_MAX,
  ENGINE_TEMPO_MIN,
  crossfaderTempoPlan,
  deckSyncRate,
  linkedDeckRates,
  adoptNativeSyncRelation,
  shouldQuantizeSyncOnPlay,
} from "../../lib/beatGridSync";
import { LatestTempoCommandLane, TEMPO_COMMAND_INTERVAL_MS } from "../../lib/tempoCommandLane";
import { mediaUrlForTrack } from "../../lib/streamTrack";
import { Waveform, type SeekDetail } from "../library/Waveform";
import type { MidiFeedback, MidiLayerState, MidiMapping, MidiResolvedAction } from "../../lib/midi/mapping";
import { MIDI_PRESETS } from "../../lib/midi/presets";
import { mappingForPort, dispatchMidiMessage, MidiEchoGuard, MidiFourteenBit, parseMidiBytes, scaleRangeToUnit, scaleUnitToRange } from "../../lib/midi/mapping";
import { SOFT_TAKEOVER_THRESHOLD, SoftTakeover } from "../../lib/midi/softTakeover";
import { selectMappedPort, sendMidiOutputs, subscribeMidi } from "../../lib/midi/runtime";
import { MIDI_BROWSE_EVENT } from "../../lib/midiLibraryNav";
import {
  clampJogPosition,
  midiJogCursorPosition,
  midiJogNudgeAmount,
  midiJogSeekSeconds,
  midiJogMode,
  midiJogVinylSeconds,
} from "../../lib/midiJog";
import { PlatterVelocityTracker, PointerPlatterTracker } from "../../lib/platter";
import { usesLocalLibraryRecord } from "../../lib/playbackTrackSource";
import { knobBias, snapKnobToCenter } from "../../lib/stemDeckLog";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";
import {
  hydratePlaybackTrack,
  songSourceRequest,
  subscribePlaybackTrackMetadata,
  trackIdRequest,
  type PlaybackTrackRequest,
} from "../../lib/playbackTrack";

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
  /** User transport intent; controls stay lit while a requested source is buffering. */
  playing: boolean;
  /** Physical callback clock. Waveforms must not walk before buffered audio starts moving. */
  transportRunning: boolean;
  /** Post-EQ peak in linear full scale; values >= 1 indicate clipping. */
  peakLevel: number;
  rate: number;
  audibleRate: number;
  scratchHeld: boolean;
  discontinuityRevision: number;
  cover: string;
  /** 引擎级无缝循环窗口（曲目秒）；null 表示线性播放。 */
  loopStart: number | null;
  loopLength: number | null;
  effectiveLoopStart: number | null;
  effectiveLoopLength: number | null;
  effectiveLoopGeneration: number;
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
  slots: DeckFxSlots;
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
  /** Incremented when manager playback explicitly returns Deck controls to neutral. */
  deckResetRevisions: readonly [number, number];
  stems: [PerformanceStemDeckModel, PerformanceStemDeckModel];
  stemRuntime: StemRuntimeStatus | null;
  stemMode: StemMode;
  masterVolume: number;
  /** Resolves after the native Deck accepted the landing, so the visual clock can snap with it. */
  onSeek: (side: 0 | 1, detail: Omit<SeekDetail, "trackId">) => Promise<boolean>;
  /** Hardware jog seeks must stay on an already installed physical Deck. */
  onJogSeek: (side: 0 | 1, position: number) => void;
  /** Edge rotation: transient pitch bend, never a source reload or persistent TEMPO change. */
  onJogNudge: (side: 0 | 1, amount: number) => void;
  /** Pointer, touch and MIDI all enter the same signed-velocity platter state machine. */
  onPlatter: (side: 0 | 1, event: UnifiedPlatterEvent) => void;
  /** All source kinds cross one normalized load edge; provider details stop here. */
  onTrackLoad: (side: 0 | 1, request: PlaybackTrackRequest) => void;
  onTogglePlay: (side: 0 | 1) => void;
  onMainCue: (side: 0 | 1, position: number) => void;
  onRateChange: (side: 0 | 1, rate: number) => boolean | Promise<boolean>;
  onRatePairChange: (rates: [number, number]) => boolean | Promise<boolean>;
  onSync: (request: UnifiedDeckSyncRequest) => boolean | Promise<boolean>;
  onClearSync: () => void;
  nativeSync: UnifiedSyncState;
  onMixerChange: (
    side: 0 | 1,
    expectedTrackId: number | null,
    values: PerformanceMixerValues,
    channelGain: number,
  ) => void;
  onDeckFx: (side: 0 | 1, fx: PerformanceDeckFx) => void;
  onMasterVolumeChange: (volume: number) => void;
  onToggleStemAll: (side: 0 | 1) => void;
  onDeckPfl: (side: 0 | 1, enabled: boolean) => void;
  onToggleLoop: (side: 0 | 1, length: number, quantize: boolean) => void | Promise<void>;
  onResizeLoop: (side: 0 | 1, length: number) => void | Promise<void>;
  onSaveCuePoints: (track: Track, cues: CuePoint[]) => Promise<void>;
  onSaveMainCue: (track: Track, cueMs: number) => Promise<void>;
}

// 现场旋钮只在当前应用进程内保留；真正重启必须回到中性值。
export const PERFORMANCE_MIXER_SESSION_KEY = "kd-performance-mixer-session-v1";
const LOOP_BEATS_STORAGE_KEY = "kd-performance-loop-beats-v1";
const JUMP_BEATS_STORAGE_KEY = "kd-performance-jump-beats-v1";
const CROSSFADER_ENABLED_STORAGE_KEY = "kd-performance-crossfader-enabled-v1";
const SAMPLER_STORAGE_KEY = "kd-performance-sampler-slots-v1";
type FxPanelMode = "knobs" | "pads" | "sampler";
type FxKind =
  | "echo"
  | "reverb"
  | "flanger"
  | "phaser"
  | "bitCrusher"
  | "gate"
  | "alarm"
  | "hydrant"
  | "rocket";
type FxSlot = { kind: FxKind; parameter: number; mix: number; enabled: boolean };
type DeckFxSlots = [FxSlot, FxSlot, FxSlot];
const FX_OPTIONS: ReadonlyArray<{ kind: FxKind; label: string }> = [
  { kind: "echo", label: "Echo" },
  { kind: "reverb", label: "Reverb" },
  { kind: "flanger", label: "Flanger" },
  { kind: "phaser", label: "Phaser" },
  { kind: "bitCrusher", label: "Bit Crusher" },
  { kind: "gate", label: "Gate" },
  { kind: "alarm", label: "Alarm" },
  { kind: "hydrant", label: "Hydrant" },
  { kind: "rocket", label: "Rocket" },
];
const PAD_FX_LABELS = [
  "ECHO 1/8", "ECHO 1/4", "REV SHORT", "REV LONG",
  "GATE 1/8", "GATE 1/16", "LP SWEEP", "HP SWEEP",
] as const;

function defaultDeckFxSlots(): DeckFxSlots {
  return [
    { kind: "echo", parameter: 0.5, mix: 0.35, enabled: false },
    { kind: "reverb", parameter: 0.5, mix: 0.3, enabled: false },
    { kind: "flanger", parameter: 0.5, mix: 0.5, enabled: false },
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
    const value = JSON.parse(sessionStorage.getItem(PERFORMANCE_MIXER_SESSION_KEY) ?? "null") as unknown;
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

/** Manager song loads start a neutral single-track context; DJ loads never call this. */
export function clearPerformanceMixerSession(
  storage: Pick<Storage, "removeItem"> = window.sessionStorage,
): void {
  try {
    storage.removeItem(PERFORMANCE_MIXER_SESSION_KEY);
  } catch {
    // Storage may be unavailable in a restricted WebView; the mounted reset revision still wins.
  }
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
const MAX_NATIVE_LOOP_SECONDS = 32;

function boundedLoopBeats(beats: number, beatSecondsValue: number): number {
  const maximum = MAX_NATIVE_LOOP_SECONDS / Math.max(beatSecondsValue, Number.EPSILON);
  return [...LOOP_BEAT_CHOICES]
    .reverse()
    .find((choice) => choice <= beats && choice <= maximum + 1.0e-9)
    ?? LOOP_BEAT_CHOICES[0];
}

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

function isPerformanceDeckDrag(event: { dataTransfer: DataTransfer | null }): boolean {
  return isTrackDrag(event) || isSearchAudioDrag(event);
}

/** Convert drag wire formats into the single Deck load contract at the UI boundary. */
function dropIntoPerformanceDeck(
  event: React.DragEvent<HTMLElement>,
  side: 0 | 1,
  onTrackLoad: PerformanceWorkspaceProps["onTrackLoad"],
): void {
  if (isSearchAudioDrag(event)) {
    event.preventDefault();
    event.stopPropagation();
    const source = searchAudioSource(readSearchDrop(event.dataTransfer));
    finishSearchDrop();
    if (source) onTrackLoad(side, songSourceRequest(source));
    return;
  }
  if (!isTrackDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const ids = readTrackDragIds(event.dataTransfer);
  finishTrackDrop();
  if (ids.length) onTrackLoad(side, trackIdRequest(ids[0]));
}

function DeckScratchSurface({
  deck,
  side,
  onPlatter,
  onTrackLoad,
}: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  onPlatter: PerformanceWorkspaceProps["onPlatter"];
  onTrackLoad: PerformanceWorkspaceProps["onTrackLoad"];
}) {
  const track = deck.track;
  const scratchRef = useRef<{
    pointerId: number;
    tracker: PointerPlatterTracker;
  } | null>(null);
  const onPlatterLiveRef = useRef(onPlatter);
  onPlatterLiveRef.current = onPlatter;

  useEffect(() => () => {
    // Track replacement/unmount is a real gesture boundary. A generation-safe end cannot
    // release a newer source, but it prevents the old callback voice from remaining grabbed.
    if (scratchRef.current) onPlatterLiveRef.current(side, { phase: "end", velocity: 0 });
    scratchRef.current = null;
  }, [side, track?.id]);

  const finishScratch = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = scratchRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    scratchRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit may release capture before pointercancel reaches React.
    }
    onPlatter(side, { phase: "end", velocity: gesture.tracker.end(event.timeStamp) });
  };

  if (!track) return null;
  return (
    <div
      className="kd-performance-scratch"
      data-side={side === 0 ? "a" : "b"}
      role="slider"
      tabIndex={0}
      aria-label={`${side === 0 ? "A" : "B"} Deck 波形，拖动刮擦`}
      aria-valuemin={-PERFORMANCE_PREROLL_SECONDS}
      aria-valuemax={deck.duration}
      aria-valuenow={deck.position}
      {...{ [TRACK_DECK_DROP_TARGET_ATTR]: String(side) }}
      onDragOver={(event) => {
        if (!isPerformanceDeckDrag(event)) return;
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
        delete event.currentTarget.dataset.kdNativeTrackOver;
        dropIntoPerformanceDeck(event, side, onTrackLoad);
      }}
      onPointerDownCapture={(event) => {
        if (event.button !== 0 || scratchRef.current) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        scratchRef.current = {
          pointerId: event.pointerId,
          tracker: new PointerPlatterTracker(event.clientX, rect.width, event.timeStamp),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        // A real capacitive platter grabs on contact, not after an arbitrary drag threshold.
        onPlatter(side, { phase: "start" });
      }}
      onPointerMove={(event) => {
        const gesture = scratchRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        const native = event.nativeEvent;
        const coalesced = typeof native.getCoalescedEvents === "function"
          ? native.getCoalescedEvents()
          : [];
        const points = coalesced.length > 0 ? coalesced : [native];
        const velocity = gesture.tracker.move(points, native.timeStamp);
        if (velocity !== null) {
          onPlatter(side, {
            phase: "move",
            velocity,
            validForMs: gesture.tracker.velocityValidityMs(),
          });
        }
      }}
      onPointerUp={finishScratch}
      onPointerCancel={finishScratch}
      onLostPointerCapture={finishScratch}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const velocity = event.key === "ArrowLeft" ? -0.75 : 0.75;
        onPlatter(side, { phase: "start" });
        onPlatter(side, { phase: "move", velocity });
        onPlatter(side, { phase: "end", velocity });
      }}
    />
  );
}

function DeckWave({
  deck,
  side,
  position,
  motionRate,
  amplitudeScale,
  interactiveScrub,
  snapRail,
  motionRevision,
  onTrackLoad,
}: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  position: number;
  motionRate: number;
  amplitudeScale: number;
  interactiveScrub: boolean;
  snapRail: boolean;
  motionRevision: number;
  onTrackLoad: PerformanceWorkspaceProps["onTrackLoad"];
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
        if (!isPerformanceDeckDrag(event)) return;
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
        delete event.currentTarget.dataset.kdNativeTrackOver;
        dropIntoPerformanceDeck(event, side, onTrackLoad);
      }}
    >
      {!track ? <span className="kd-performance-wave-empty" /> : null}
      {track ? (
        <Waveform
          className="kd-performance-focus-wave"
          trackId={track.id}
          track={track}
          position={position}
          duration={deck.duration || track.duration || 0}
          cueMs={track.cue_ms}
          endMs={track.end_ms}
          cuePoints={track.cue_points}
          loopStart={deck.effectiveLoopStart}
          loopLength={deck.effectiveLoopLength}
          loopGeneration={deck.effectiveLoopGeneration}
          height={50}
          seekable={false}
          showBeatGrid
          viewportSeconds={performanceWaveformViewportSeconds(deck.rate)}
          playing={deck.transportRunning || deck.scratchHeld || interactiveScrub}
          playbackRate={motionRate}
          buckets={detailWaveformBuckets(deck.duration || track.duration || 0)}
          detailUpgradeDelayMs={120}
          amplitudeScale={amplitudeScale}
          interactiveScrub={interactiveScrub}
          snapRail={snapRail}
          motionRevision={motionRevision}
          nativeDeck={side}
        />
      ) : null}
    </div>
  );
}

function PerformanceDeckWaves({
  deck,
  side,
  position,
  motionRate,
  trimGain,
  interactiveScrub,
  snapRail,
  motionRevision,
  onPlatter,
  onTrackLoad,
}: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  position: number;
  motionRate: number;
  trimGain: number;
  interactiveScrub: boolean;
  snapRail: boolean;
  motionRevision: number;
  onPlatter: PerformanceWorkspaceProps["onPlatter"];
  onTrackLoad: PerformanceWorkspaceProps["onTrackLoad"];
}) {
  return (
    <div className="kd-performance-deck-waves" data-side={side === 0 ? "a" : "b"}>
      <StableDeckWave
        deck={deck}
        side={side}
        position={position}
        motionRate={motionRate}
        amplitudeScale={performanceWaveformAmplitudeScale(trimGain)}
        interactiveScrub={interactiveScrub}
        snapRail={snapRail}
        motionRevision={motionRevision}
        onTrackLoad={onTrackLoad}
      />
      <DeckScratchSurface
        deck={deck}
        side={side}
        onPlatter={onPlatter}
        onTrackLoad={onTrackLoad}
      />
      {deck.track ? <i className="kd-performance-wave-needle" aria-hidden="true" /> : null}
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
        <span
          className="kd-performance-vinyl-record"
          data-spinning={deck.transportRunning || undefined}
          data-empty={!track || undefined}
          style={{ "--kd-vinyl-spin-duration": `${2.8 / clamp(deck.rate, 0.5, 2)}s` } as CSSProperties}
        >
          {deck.cover ? <img src={deck.cover} alt="" /> : <b className="kd-performance-platter-brand">KDJ</b>}
        </span>
      </span>
      <div className="kd-performance-overview-slot">
        {track ? (
          <Waveform
            trackId={track.id}
            renderProfile="release-overview"
            track={track}
            position={deck.position}
            duration={deck.duration}
            cuePoints={track.cue_points ?? []}
            loopStart={deck.loopStart}
            loopLength={deck.loopLength}
            height={18}
            buckets={640}
            preserveBarPhase={preserveBarPhase}
            playing={deck.transportRunning}
            playbackRate={deck.transportRunning ? deck.rate : 0}
            onSeek={(detail) => onSeek(side, detail)}
            className="kd-performance-overview-wave"
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
            <div data-time="true"><dt>TIME</dt><dd>{formatSignedDuration(deck.position)}</dd></div>
            <div data-key="true"><dt aria-label="调性" /><dd style={keyColor ? { color: keyColor } : undefined}>{deckKey(track)}</dd></div>
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
function LoopControls({ deck, side, beats, jumpBeats, onBeats, onJumpBeats, onToggleLoop, onResizeLoop, onSeek }: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  beats: number;
  jumpBeats: number;
  onBeats: (beats: number) => void;
  onJumpBeats: (beats: number) => void;
  onToggleLoop: (side: 0 | 1) => void;
  onResizeLoop: (side: 0 | 1, beats: number) => void;
  onSeek: PerformanceWorkspaceProps["onSeek"];
}) {
  const track = deck.track;
  const beat = beatSeconds(track);
  const looping = deck.loopStart !== null && deck.loopLength !== null;
  const stepBeats = (direction: -1 | 1) => {
    const index = LOOP_BEAT_CHOICES.indexOf(beats);
    const selected = LOOP_BEAT_CHOICES[clamp(index + direction, 0, LOOP_BEAT_CHOICES.length - 1)];
    const next = beat ? boundedLoopBeats(selected, beat) : selected;
    onBeats(next);
    if (looping && beat) onResizeLoop(side, next);
  };
  const toggleLoop = () => {
    onToggleLoop(side);
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
  const mix = clamp(slot.mix, 0, 1);
  const parameter = clamp(slot.parameter, 0, 1);
  const index = FX_OPTIONS.findIndex((effect) => effect.kind === slot.kind);
  const label = FX_OPTIONS[index]?.label ?? "Echo";
  const cycle = (direction: -1 | 1) => {
    const next = (index + direction + FX_OPTIONS.length) % FX_OPTIONS.length;
    onChange({ kind: FX_OPTIONS[next].kind });
  };
  return (
    <div className="kd-performance-fx-slot" data-active={slot.enabled || undefined} data-kind={slot.kind}>
      <div className="kd-performance-fx-head">
        <button type="button" aria-label="上一个效果" onClick={() => cycle(-1)}>‹</button>
        <label className="kd-performance-fx-select">
          <AudioLines size={12} aria-hidden="true" />
          <span>{label}</span>
          <select
            value={slot.kind}
            aria-label="选择效果"
            onChange={(event) => onChange({ kind: event.currentTarget.value as FxKind })}
          >
            {FX_OPTIONS.map((effect) => <option key={effect.kind} value={effect.kind}>{effect.label}</option>)}
          </select>
          <ChevronDown size={10} aria-hidden="true" />
        </label>
        <button type="button" aria-label="下一个效果" onClick={() => cycle(1)}>›</button>
      </div>
      <div className="kd-performance-fx-body">
        <button
          type="button"
          className="kd-performance-fx-on"
          aria-pressed={slot.enabled}
          onClick={() => onChange({ enabled: !slot.enabled })}
        >
          ON
        </button>
        <SlideStrip
          label="PARAMETER"
          value={parameter}
          min={0}
          max={1}
          onChange={(value) => onChange({ parameter: value })}
          onReset={() => onChange({ parameter: 0.5 })}
        />
        <span className="kd-performance-fx-mix">
          <i>D</i>
          <ArcKnob
            size="xs"
            label="DRY/WET"
            value={mix}
            min={0}
            max={1}
            onChange={(value) => onChange({ mix: value })}
            onReset={() => onChange({ mix: 0.5 })}
          />
          <i>W</i>
        </span>
      </div>
    </div>
  );
}

/**
 * 竖排 TEMPO 面板（rekordbox 式）：竖推子占满控制区全高，SYNC、有效 BPM 读数、
 * 百分比 + 量程下拉、−/+ 步进键收进推子旁的一列（B 台镜像），不再占推子上下方。
 * 推子极性跟 CDJ：往上减速，往下加速。
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

  // 竖推手势挂在 VFader 上：按下定位、拖动跟随、松手 flush；键盘中步进留在推子内部。
  // Pioneer / CDJ：槽顶是 −、槽底是 +。中位吸附走 VFader 的 snapRatio（WIDE 的 0% 不在 50%）。
  const commitRatio = (ratio: number) => {
    commit(range.max - clamp(ratio, 0, 1) * (range.max - range.min));
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
  const zeroRatio = scaleRangeToUnit(1, range.min, range.max);
  const softwareRatio = scaleRangeToUnit(shown, range.min, range.max);
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
 * The pointer gesture is relative: contact never jumps to an absolute y value.
 */
function EqSpectrumChart({ side, values, filter, resonanceQ, playing, onAdjust, onReset }: {
  side: 0 | 1;
  values: EqGraphValues;
  filter: number;
  resonanceQ: number;
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
  const filterActive = channelFilterCutoffHz(filter) != null;
  const filterPointRatios = Array.from({ length: 41 }, (_, index) => index / 40);
  const filterCurvePoints = filterPointRatios.map((ratio) => ({
    x: ratio * 1_000,
    y: eqDbToGraphRatio(channelFilterDbAtRatio(filter, resonanceQ, ratio)) * 1_000,
  }));
  const filterPathPoints = filterCurvePoints.length === 0
    ? []
    : [
      { x: 0, y: filterCurvePoints[0].y },
      ...filterCurvePoints,
      { x: 1_000, y: filterCurvePoints[filterCurvePoints.length - 1].y },
    ];
  const smoothFilterPath = filterActive ? smoothEqChartPath(filterPathPoints) : "";

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
      {filterActive ? (
        <svg className="kd-dj-eq-filter" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          <path d={smoothFilterPath} />
        </svg>
      ) : null}
    </div>
  );
}

/** Single Deck mixer: the graph and the physical-style LOW/MID/HIGH knobs share one state. */
function MixerStrip({ side, mixer, resonanceQ, playing, setMixer, adjustEq }: {
  side: 0 | 1;
  mixer: PerformanceMixerValues;
  resonanceQ: number;
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
          filter={mixer.filter}
          resonanceQ={resonanceQ}
          playing={playing}
          onAdjust={adjustEq}
          onReset={() => setMixer({ low: 0, mid: 0, high: 0 })}
        />
        <div className="kd-dj-eq-knobs">
          <ArcKnob size="sm" label="HIGH" value={mixer.high} onChange={(high) => setMixer({ high })} onReset={() => setMixer({ high: 0 })} />
          <ArcKnob size="sm" label="MID" value={mixer.mid} onChange={(mid) => setMixer({ mid })} onReset={() => setMixer({ mid: 0 })} />
          <ArcKnob size="sm" label="LOW" value={mixer.low} onChange={(low) => setMixer({ low })} onReset={() => setMixer({ low: 0 })} />
        </div>
      </div>
    </div>
  );
}

/** Pure channel-volume fader. */
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
  deckResetRevisions,
  stemMode,
  masterVolume,
  onSeek,
  onJogSeek,
  onJogNudge,
  onPlatter,
  onTrackLoad,
  onTogglePlay,
  onMainCue,
  onRateChange,
  onRatePairChange,
  onSync,
  onClearSync,
  nativeSync,
  onMixerChange,
  onDeckFx,
  onMasterVolumeChange,
  onToggleStemAll,
  onDeckPfl,
  onToggleLoop,
  onResizeLoop,
  onSaveCuePoints,
  onSaveMainCue,
}: PerformanceWorkspaceProps) {
  const filterResonanceQ = channelFilterResonanceQ(
    useAppStore((state) => state.settings?.filter_resonance ?? "high"),
  );
  const [analyzedDeckTracks, setAnalyzedDeckTracks] = useState<[Track | null, Track | null]>([null, null]);
  useEffect(() => {
    let alive = true;
    const resolve = (track: Track | null) => {
      if (!track) return Promise.resolve(null);
      return hydratePlaybackTrack(track)
        .catch(() => track);
    };
    const refresh = () => {
      void Promise.all([resolve(sourceDecks[0].track), resolve(sourceDecks[1].track)])
        .then((tracks) => {
          if (alive) setAnalyzedDeckTracks(tracks as [Track | null, Track | null]);
        });
    };
    const unsubscribers = sourceDecks.flatMap((deck) =>
      deck.track ? [subscribePlaybackTrackMetadata(deck.track, refresh)] : [],
    );
    refresh();
    return () => {
      alive = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
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
          ...analyzed,
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
  const [deckPfl, setDeckPfl] = useState<[boolean, boolean]>([false, false]);
  const deckPflRef = useRef(deckPfl);
  deckPflRef.current = deckPfl;
  const [midiPort, setMidiPort] = useState<string | null>(null);
  const [loopBeats, setLoopBeats] = useState<[number, number]>(readLoopBeats);
  const loopBeatsRef = useRef(loopBeats);
  loopBeatsRef.current = loopBeats;
  const [jumpBeats, setJumpBeats] = useState<[number, number]>(readJumpBeats);
  const [fxMode, setFxMode] = useState<[FxPanelMode, FxPanelMode]>(["knobs", "knobs"]);
  const [fxSlots, setFxSlots] = useState<[DeckFxSlots, DeckFxSlots]>([
    defaultDeckFxSlots(),
    defaultDeckFxSlots(),
  ]);
  const [heldPadFx, setHeldPadFx] = useState<[number, number]>([0, 0]);
  const [samplerSlotIds, setSamplerSlotIds] = useState<Array<number | null>>(readSamplerSlotIds);
  const [samplerTracks, setSamplerTracks] = useState<Array<Track | null>>(() => Array(8).fill(null));
  const samplerAudioRef = useRef<Array<HTMLAudioElement | null>>(Array(8).fill(null));
  /** Native Sync Group mirror plus an optimistic button state while its command is in flight. */
  const [syncLock, setSyncLock] = useState<{ base: 0 | 1; multiple: number } | null>(null);
  const [scratchPreviews, setScratchPreviews] = useState<[number | null, number | null]>([
    null,
    null,
  ]);
  /** Immediate hardware-contact state while the callback start acknowledgement is in flight. */
  const [localPlatterActive, setLocalPlatterActive] = useState<[boolean, boolean]>([false, false]);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onJogSeekRef = useRef(onJogSeek);
  onJogSeekRef.current = onJogSeek;
  const onJogNudgeRef = useRef(onJogNudge);
  onJogNudgeRef.current = onJogNudge;
  const onPlatterRef = useRef(onPlatter);
  onPlatterRef.current = onPlatter;
  const onDeckFxRef = useRef(onDeckFx);
  onDeckFxRef.current = onDeckFx;
  const deckTrackIdsRef = useRef<[number | null, number | null]>([
    decks[0].track?.id ?? null,
    decks[1].track?.id ?? null,
  ]);
  deckTrackIdsRef.current = [decks[0].track?.id ?? null, decks[1].track?.id ?? null];
  const platterTrackIdsRef = useRef<[number | null, number | null]>([
    decks[0].track?.id ?? null,
    decks[1].track?.id ?? null,
  ]);
  const jogTouchRef = useRef<[boolean, boolean]>([false, false]);
  const midiPlatterTrackersRef = useRef<[PlatterVelocityTracker, PlatterVelocityTracker]>([
    new PlatterVelocityTracker(),
    new PlatterVelocityTracker(),
  ]);
  const isJogVinylMotion = (side: 0 | 1) => jogTouchRef.current[side];
  const decksRef = useRef(decks);
  decksRef.current = decks;
  const previewJogNudge = useCallback((side: 0 | 1, amount: number) => {
    onJogNudgeRef.current(side, amount);
  }, []);
  const syncLockRef = useRef(syncLock);
  syncLockRef.current = syncLock;
  useEffect(() => {
    const relation = adoptNativeSyncRelation(nativeSync);
    syncLockRef.current = relation;
    setSyncLock(relation);
  }, [nativeSync.enabled, nativeSync.follower, nativeSync.leader, nativeSync.multiple]);
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
  const appliedDeckResetRevisionsRef = useRef<[number, number]>([
    deckResetRevisions[0],
    deckResetRevisions[1],
  ]);
  useLayoutEffect(() => {
    const resetA = appliedDeckResetRevisionsRef.current[0] !== deckResetRevisions[0];
    const resetB = appliedDeckResetRevisionsRef.current[1] !== deckResetRevisions[1];
    appliedDeckResetRevisionsRef.current = [deckResetRevisions[0], deckResetRevisions[1]];
    if (!resetA && !resetB) return;

    // Manager ownership cancels trailing DJ gestures before publishing one neutral mixer/FX
    // snapshot. DJ source replacements never advance this revision.
    if (mixerTimerRef.current !== null) {
      window.clearTimeout(mixerTimerRef.current);
      mixerTimerRef.current = null;
    }
    if (crossfaderTempoTimerRef.current !== null) {
      window.clearTimeout(crossfaderTempoTimerRef.current);
      crossfaderTempoTimerRef.current = null;
    }
    crossfaderTempoPendingRef.current = null;
    crossfaderTempoSyncRef.current = false;
    syncLockRef.current = null;
    setCrossfaderTempoSync(false);
    setSyncLock(null);

    ([0, 1] as const).forEach((side) => {
      if (!(side === 0 ? resetA : resetB)) return;
      const jogTimer = jogSeekTimerRef.current[side];
      if (jogTimer !== null) window.clearTimeout(jogTimer);
      jogSeekTimerRef.current[side] = null;
      jogSeekPendingRef.current[side] = null;
      jogAtRef.current[side] = null;
      jogTouchRef.current[side] = false;
      midiPlatterTrackersRef.current[side].reset();
      scratchPreviewPendingRef.current[side] = null;
      mixerSignatureRef.current[side] = "";
      tempoTakeoverRef.current.lanes[side] = new SoftTakeover();
      tempoTakeoverRef.current.hardwareUnit[side] = null;
      onDeckPfl(side, false);
    });

    setMixers((current) => [
      resetA ? { ...DEFAULT_MIXER } : current[0],
      resetB ? { ...DEFAULT_MIXER } : current[1],
    ]);
    setVisualRates((current) => [resetA ? null : current[0], resetB ? null : current[1]]);
    setTempoHardwareUnit((current) => [resetA ? null : current[0], resetB ? null : current[1]]);
    const resetPfl: [boolean, boolean] = [resetA ? false : deckPflRef.current[0], resetB ? false : deckPflRef.current[1]];
    deckPflRef.current = resetPfl;
    setDeckPfl(resetPfl);
    setFxMode((current) => [resetA ? "knobs" : current[0], resetB ? "knobs" : current[1]]);
    setFxSlots((current) => [
      resetA ? defaultDeckFxSlots() : current[0],
      resetB ? defaultDeckFxSlots() : current[1],
    ]);
    setHeldPadFx((current) => [resetA ? 0 : current[0], resetB ? 0 : current[1]]);
    setScratchPreviews((current) => [resetA ? null : current[0], resetB ? null : current[1]]);
    setLocalPlatterActive((current) => [resetA ? false : current[0], resetB ? false : current[1]]);
  }, [deckResetRevisions[0], deckResetRevisions[1]]);
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
    // Closing the DJ surface is presentation-only. Manager `Load` owns the explicit neutral reset;
    // clearing FX here would mutate a still-mounted physical Deck merely because the view changed.
  }, []);
  useEffect(() => {
    ([0, 1] as const).forEach((side) => {
      const knobMode = fxMode[side] === "knobs";
      const padMode = fxMode[side] === "pads";
      const slots = fxSlots[side].map((slot) => ({
        ...slot,
        enabled: knobMode && slot.enabled,
      })) as DeckFxSlots;
      onDeckFxRef.current(side, {
        slots,
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
    localStorage.setItem(CROSSFADER_ENABLED_STORAGE_KEY, JSON.stringify(crossfaderEnabled));
  }, [crossfaderEnabled]);
  useEffect(() => {
    // 切出再切回 DJ 模式仍保留本次演出手感；进程重启后 sessionStorage 清空。
    sessionStorage.setItem(PERFORMANCE_MIXER_SESSION_KEY, JSON.stringify(mixers));
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
          latest.onMixerChange(
            side as 0 | 1,
            latest.trackIds[side],
            values,
            channelGain,
          );
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
  const onTrackLoadRef = useRef(onTrackLoad);
  onTrackLoadRef.current = onTrackLoad;
  useEffect(() => {
    const dropTrack = (event: Event) => {
      const detail = (event as CustomEvent<TrackDeckDropDetail>).detail;
      if (!detail || (detail.side !== 0 && detail.side !== 1) || detail.ids.length === 0) return;
      onTrackLoadRef.current(detail.side, trackIdRequest(detail.ids[0]));
    };
    const dropStream = (event: Event) => {
      const detail = (event as CustomEvent<StreamDeckDropDetail>).detail;
      if (!detail || (detail.side !== 0 && detail.side !== 1) || !detail.source) return;
      onTrackLoadRef.current(detail.side, songSourceRequest(detail.source));
    };
    window.addEventListener(TRACK_DECK_DROP_EVENT, dropTrack);
    window.addEventListener(STREAM_DECK_DROP_EVENT, dropStream);
    return () => {
      window.removeEventListener(TRACK_DECK_DROP_EVENT, dropTrack);
      window.removeEventListener(STREAM_DECK_DROP_EVENT, dropStream);
    };
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
  }, [
    decks[0].track?.id,
    decks[1].track?.id,
    deckResetRevisions[0],
    deckResetRevisions[1],
    stemMode,
  ]);

  useEffect(() => () => {
    if (crossfaderTempoTimerRef.current !== null) {
      window.clearTimeout(crossfaderTempoTimerRef.current);
    }
  }, []);

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

  const startMidiJogScratch = (side: 0 | 1, inputAt = performance.now()) => {
    cancelPendingSyncCorrection();
    if (jogTouchRef.current[side]) return;
    jogTouchRef.current[side] = true;
    midiPlatterTrackersRef.current[side].start(inputAt);
    // A capacitive platter owns the Deck cursor without toggling Play/Pause.
    discardJogSeek(side);
    const deck = decksRef.current[side];
    const trackId = deck.track?.id;
    const at = Number.isFinite(deck.position) ? deck.position : 0;
    jogAtRef.current[side] = trackId != null
      ? { trackId, position: at, at: performance.now() }
      : null;
    // MIDI does not own a preview needle — the scrolling waveform follows the engine only.
    setLocalPlatterActive((current) => {
      if (current[side]) return current;
      const next: [boolean, boolean] = [current[0], current[1]];
      next[side] = true;
      return next;
    });
    // Touch is a momentary platter owner, never an implicit load/focus or Play/Pause command.
    onPlatterRef.current(side, { phase: "start" });
  };

  const finishMidiJogScratch = (side: 0 | 1, inputAt = performance.now()) => {
    cancelPendingSyncCorrection();
    if (!jogTouchRef.current[side]) return;
    jogTouchRef.current[side] = false;
    const velocity = midiPlatterTrackersRef.current[side].end(inputAt);
    // Note-off and its final measured speed are one native command. No final seek/rebuild.
    discardJogSeek(side);
    setLocalPlatterActive((current) => {
      if (!current[side]) return current;
      const next: [boolean, boolean] = [current[0], current[1]];
      next[side] = false;
      return next;
    });
    onPlatterRef.current(side, { phase: "end", velocity });
    jogAtRef.current[side] = null;
  };

  useEffect(() => () => {
    if (scratchPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(scratchPreviewFrameRef.current);
    }
    ([0, 1] as const).forEach((side) => {
      if (jogTouchRef.current[side]) {
        onPlatterRef.current(side, { phase: "end", velocity: 0 });
        jogTouchRef.current[side] = false;
      }
      const timer = jogSeekTimerRef.current[side];
      if (timer !== null) window.clearTimeout(timer);
    });
  }, []);

  useEffect(() => {
    const nextTrackIds: [number | null, number | null] = [
      decks[0].track?.id ?? null,
      decks[1].track?.id ?? null,
    ];
    const changed: [boolean, boolean] = [
      platterTrackIdsRef.current[0] !== nextTrackIds[0],
      platterTrackIdsRef.current[1] !== nextTrackIds[1],
    ];
    platterTrackIdsRef.current = nextTrackIds;
    // A source change ends only that physical Deck's generation. Resetting both sides here made
    // an unrelated Deck-A load silently forget a still-held Deck-B touch; following B ticks then
    // lost their capacitive owner and a paused B could no longer enter negative pre-roll.
    ([0, 1] as const).forEach((side) => {
      if (!changed[side]) return;
      if (!jogTouchRef.current[side]) return;
      const velocity = midiPlatterTrackersRef.current[side].end(performance.now());
      onPlatterRef.current(side, { phase: "end", velocity });
    });
    setLocalPlatterActive((current) => [
      changed[0] ? false : current[0],
      changed[1] ? false : current[1],
    ]);
    ([0, 1] as const).forEach((side) => {
      if (!changed[side]) return;
      jogTouchRef.current[side] = false;
      midiPlatterTrackersRef.current[side].reset();
      jogAtRef.current[side] = null;
      const timer = jogSeekTimerRef.current[side];
      if (timer !== null) window.clearTimeout(timer);
      jogSeekTimerRef.current[side] = null;
      jogSeekPendingRef.current[side] = null;
      updateScratchPreview(side, null);
    });
  }, [decks[0].track?.id, decks[1].track?.id, updateScratchPreview]);

  useEffect(() => {
    setScratchPreviews((current) => {
      const next: [number | null, number | null] = [current[0], current[1]];
      ([0, 1] as const).forEach((side) => {
        // React state follows the hardware event on the next render. The ref flips in the same
        // MIDI callback, so it prevents a 100ms native transport snapshot from clearing the
        // first visual platter frame while the callback-only hold takes effect.
        if (jogTouchRef.current[side] || localPlatterActive[side]) return;
        const preview = current[side];
        if (shouldDropSeekPreview(preview, decks[side].position, false)) {
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
    localPlatterActive,
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
    const followerOrigin = (follower?.downbeat_confidence ?? 0) >= 0.5
      ? follower?.downbeat_origin ?? follower?.downbeats?.[0] ?? follower?.first_beat
      : follower?.first_beat;
    const masterOrigin = (master?.downbeat_confidence ?? 0) >= 0.5
      ? master?.downbeat_origin ?? master?.downbeats?.[0] ?? master?.first_beat
      : master?.first_beat;
    if (
      !follower?.bpm
      || !master?.bpm
      || followerOrigin == null
      || masterOrigin == null
    ) {
      return Promise.resolve(false);
    }
    return Promise.resolve(onSync({
      follower: side,
      master: masterSide,
      rate,
      followerBpm: follower.bpm,
      followerFirstBeat: followerOrigin,
      masterBpm: master.bpm,
      masterFirstBeat: masterOrigin,
      beatsPerBar: 4,
    }));
  };

  const rollbackVisualRates = (rejected: readonly [number | null, number | null]) => {
    setVisualRates((current) => {
      const next: [number | null, number | null] = [current[0], current[1]];
      ([0, 1] as const).forEach((side) => {
        const rate = rejected[side];
        // A late failed command must not erase a newer pointer/MIDI preview.
        if (rate !== null && current[side] !== null && Math.abs(current[side] - rate) < 0.0005) {
          next[side] = null;
        }
      });
      return next[0] === current[0] && next[1] === current[1] ? current : next;
    });
  };

  const flushCrossfaderTempoRates = () => {
    if (crossfaderTempoTimerRef.current !== null) {
      window.clearTimeout(crossfaderTempoTimerRef.current);
      crossfaderTempoTimerRef.current = null;
    }
    const rates = crossfaderTempoPendingRef.current;
    crossfaderTempoPendingRef.current = null;
    if (rates) {
      void Promise.resolve(onRatePairChangeRef.current(rates)).then((applied) => {
        if (!applied) rollbackVisualRates(rates);
      });
    }
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
    return onSeek(side, detail);
  };
  const handleResizeLoop = (side: 0 | 1, beats: number) => {
    const beat = beatSeconds(decks[side].track);
    if (decks[side].loopStart === null || !beat) return;
    cancelPendingSyncCorrection();
    const boundedBeats = boundedLoopBeats(beats, beat);
    if (boundedBeats !== beats) {
      const next: [number, number] = [loopBeatsRef.current[0], loopBeatsRef.current[1]];
      next[side] = boundedBeats;
      loopBeatsRef.current = next;
      setLoopBeats(next);
    }
    const length = boundedBeats * beat;
    const acknowledgedBeats = boundedLoopBeats(
      decks[side].loopLength !== null ? decks[side].loopLength / beat : boundedBeats,
      beat,
    );
    void Promise.resolve(onResizeLoop(side, length)).catch(() => {
      const next: [number, number] = [loopBeatsRef.current[0], loopBeatsRef.current[1]];
      next[side] = acknowledgedBeats;
      loopBeatsRef.current = next;
      setLoopBeats(next);
    });
  };
  const handleLoopToggle = (side: 0 | 1) => {
    const deck = decks[side];
    const beat = beatSeconds(deck.track);
    if (!deck.track || !beat) return;
    cancelPendingSyncCorrection();
    // Rust samples loop-in from the callback in the same command that toggles the loop. The UI
    // intentionally sends no position, so a delayed React snapshot can never jump the song.
    const boundedBeats = boundedLoopBeats(loopBeatsRef.current[side], beat);
    if (boundedBeats !== loopBeatsRef.current[side]) {
      const next: [number, number] = [loopBeatsRef.current[0], loopBeatsRef.current[1]];
      next[side] = boundedBeats;
      loopBeatsRef.current = next;
      setLoopBeats(next);
    }
    const length = boundedBeats * beat;
    void Promise.resolve(onToggleLoop(side, length, quantize)).catch(() => {});
  };
  const handleManualPlatter: PerformanceWorkspaceProps["onPlatter"] = (side, event) => {
    cancelPendingSyncCorrection();
    if (event.phase === "start" || event.phase === "end") {
      setLocalPlatterActive((current) => {
        const active = event.phase === "start";
        if (current[side] === active) return current;
        const next: [boolean, boolean] = [current[0], current[1]];
        next[side] = active;
        return next;
      });
    }
    onPlatter(side, event);
  };
  const handleManualTogglePlay: PerformanceWorkspaceProps["onTogglePlay"] = (side) => {
    cancelPendingSyncCorrection();
    onTogglePlay(side);
  };
  const handleManualMainCue: PerformanceWorkspaceProps["onMainCue"] = (side, position) => {
    cancelPendingSyncCorrection();
    onMainCue(side, position);
  };
  const handleManualTrackLoad: PerformanceWorkspaceProps["onTrackLoad"] = (side, request) => {
    cancelPendingSyncCorrection();
    onTrackLoad(side, request);
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
      onClearSync();
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
      return Promise.resolve(onRatePairChange(paired)).then((applied) => {
        if (!applied) rollbackVisualRates(paired);
        return applied;
      });
    }
    return Promise.resolve(onRateChange(side, rate)).then((applied) => {
      if (!applied) rollbackVisualRates(side === 0 ? [rate, null] : [null, rate]);
      return applied;
    });
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
    onClearSync();
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
    inputAt = performance.now(),
  ) => {
    cancelPendingSyncCorrection();
    const deck = decksRef.current[side];
    const trackId = deck.track?.id;
    if (trackId == null || delta === 0) return;
    const now = inputAt;
    const held = jogTouchRef.current[side];
    if (!wholeTrack && !commitToTransport) {
      if (!held) return;
      const velocity = midiPlatterTrackersRef.current[side].move(
        midiJogVinylSeconds(delta),
        now,
      );
      onPlatterRef.current(side, {
        phase: "move",
        velocity,
        validForMs: midiPlatterTrackersRef.current[side].velocityValidityMs(),
      });
      return;
    }
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
    if (commitToTransport) {
      // Shift+jog still coalesces absolute seeks so a fast spin cannot rebuild decoders.
      // Preview the seek cursor only for whole-track search — vinyl ticks follow the engine.
      updateScratchPreview(side, at);
      queueJogSeek(side, trackId, at);
    }
  };
  const hardwareFxTargets = (deck?: 0 | 1): readonly (0 | 1)[] =>
    deck === 0 || deck === 1 ? [deck] : [0, 1];
  const patchHardwareFx1 = (
    deck: 0 | 1 | undefined,
    patch: Partial<FxSlot>,
  ) => {
    const targets = hardwareFxTargets(deck);
    setFxMode((current) => [
      targets.includes(0) ? "knobs" : current[0],
      targets.includes(1) ? "knobs" : current[1],
    ]);
    setFxSlots((current) => {
      const next: [DeckFxSlots, DeckFxSlots] = [
        [...current[0]] as DeckFxSlots,
        [...current[1]] as DeckFxSlots,
      ];
      for (const side of targets) next[side][0] = { ...next[side][0], ...patch };
      return next;
    });
  };
  const stepHardwareFx1 = (deck: 0 | 1 | undefined, direction: -1 | 1) => {
    const targets = hardwareFxTargets(deck);
    setFxMode((current) => [
      targets.includes(0) ? "knobs" : current[0],
      targets.includes(1) ? "knobs" : current[1],
    ]);
    setFxSlots((current) => {
      const next: [DeckFxSlots, DeckFxSlots] = [
        [...current[0]] as DeckFxSlots,
        [...current[1]] as DeckFxSlots,
      ];
      for (const side of targets) {
        const present = next[side][0];
        const index = FX_OPTIONS.findIndex((effect) => effect.kind === present.kind);
        const stepped = (index + direction + FX_OPTIONS.length) % FX_OPTIONS.length;
        next[side][0] = { ...present, kind: FX_OPTIONS[stepped].kind };
      }
      return next;
    });
  };

  const applyMidiAction = (action: MidiResolvedAction, inputAt = performance.now()) => {
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
      case "pflToggle": {
        const next: [boolean, boolean] = [deckPflRef.current[0], deckPflRef.current[1]];
        next[action.deck] = !next[action.deck];
        deckPflRef.current = next;
        setDeckPfl(next);
        onDeckPfl(action.deck, next[action.deck]);
        return;
      }
      case "fxMix":
        patchHardwareFx1(undefined, { mix: action.value });
        return;
      case "fxParameter":
        patchHardwareFx1(undefined, { parameter: action.value });
        return;
      case "fxPrevious":
        stepHardwareFx1(action.deck, -1);
        return;
      case "fxNext":
        stepHardwareFx1(action.deck, 1);
        return;
      case "fxEnabled":
        patchHardwareFx1(action.deck, { enabled: action.held });
        return;
      case "loopToggle": {
        handleLoopToggle(action.deck);
        return;
      }
      case "loopSize": {
        const beats = nextLoopBeats(loopBeatsRef.current[action.deck], action.delta);
        const immediate: [number, number] = [
          loopBeatsRef.current[0],
          loopBeatsRef.current[1],
        ];
        immediate[action.deck] = beats;
        loopBeatsRef.current = immediate;
        setLoopBeats((current) => {
          const next: [number, number] = [current[0], current[1]];
          next[action.deck] = beats;
          return next;
        });
        handleResizeLoop(action.deck, beats);
        return;
      }
      case "jogTouch":
        if (action.held) startMidiJogScratch(action.deck, inputAt);
        else finishMidiJogScratch(action.deck, inputAt);
        return;
      case "jog": {
        // A JSON mapping normally resolves this to jogSeek before it reaches the workspace.
        // Keep the runtime guard for custom mappings that only expose a Shift hold signal.
        if (shiftHeldRef.current) {
          moveJogPosition(action.deck, action.delta, true, !jogTouchRef.current[action.deck], inputAt);
          return;
        }
        const mode = midiJogMode(
          isJogVinylMotion(action.deck),
          decksRef.current[action.deck].transportRunning,
        );
        if (mode === "platter") {
          moveJogPosition(action.deck, action.delta, false, false, inputAt);
        } else if (mode === "nudge") {
          cancelPendingSyncCorrection();
          previewJogNudge(action.deck, midiJogNudgeAmount(action.delta));
        }
        return;
      }
      // Keep hand-written mappings using the old names operational. The Buddy preset uses the
      // explicit jog/jogTouch pair above, so only legacy maps retain the old stop-and-scratch
      // interpretation.
      case "scratchTouch":
        if (action.held) startMidiJogScratch(action.deck, inputAt);
        else finishMidiJogScratch(action.deck, inputAt);
        return;
      case "scratch": {
        if (shiftHeldRef.current) {
          moveJogPosition(action.deck, action.delta, true, !jogTouchRef.current[action.deck], inputAt);
          return;
        }
        const mode = midiJogMode(
          isJogVinylMotion(action.deck),
          decksRef.current[action.deck].transportRunning,
        );
        if (mode === "platter") {
          moveJogPosition(action.deck, action.delta, false, false, inputAt);
        } else if (mode === "nudge") {
          // Older mappings expose only a rotary "scratch" message and have no reliable release
          // edge. Treat it as an edge nudge only while transport is actually running.
          cancelPendingSyncCorrection();
          previewJogNudge(action.deck, midiJogNudgeAmount(action.delta));
        }
        return;
      }
      case "jogSeek":
        // Shift overrides both edge nudge and the capacitive surface: its scope is intentionally
        // the full track, but the latest-value lane keeps it from resetting playback/loading.
        moveJogPosition(action.deck, action.delta, true, !jogTouchRef.current[action.deck], inputAt);
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
      const layers: MidiLayerState = { shift: shiftHeldRef.current };
      const inputAt = Number.isFinite(message.timestampMicros)
        ? Number(message.timestampMicros) / 1_000
        : performance.now();
      for (const action of dispatchMidiMessage(mapping, message, layers, midiLiveRef.current.fourteenBit)) {
        midiLiveRef.current.apply(action, inputAt);
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
      pfl: deckPfl,
      crossfaderEnabled,
    };
    void sendMidiOutputs(mapping, feedback, midiLedRef.current, midiEchoRef.current);
  }, [
    decks[0].playing,
    decks[1].playing,
    decks[0].track?.id,
    decks[1].track?.id,
    decks[0].loopStart,
    decks[0].loopLength,
    decks[1].loopStart,
    decks[1].loopLength,
    deckPfl,
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
      <div className="kd-performance-fx-knobs">
        {fxSlots[side].map((slot, index) => (
          <FxSlotControl key={index} slot={slot} onChange={(patch) => patchFxSlot(side, index, patch)} />
        ))}
      </div>
    </section>
  );
  const renderDeckFxPage = (side: 0 | 1) => (
    <div className="kd-performance-deck-fx-page" data-side={side === 0 ? "a" : "b"}>
      <div className="kd-performance-fx-toolbar">
        <span className="kd-performance-fx-modes">
          {([
            ["knobs", "FX"],
            ["pads", "PAD"],
            ["sampler", "SMP"],
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

  const renderDeckPadPanel = (side: 0 | 1) => (
    <section
      className="kd-performance-deck-pad-bank"
      aria-label={side === 0 ? "Deck A Hot Cue" : "Deck B Hot Cue"}
    >
      <HotCuePads deck={viewDecks[side]} side={side} quantize={quantize} onSeek={handleManualSeek} onSaveCuePoints={onSaveCuePoints} />
    </section>
  );

  const renderDeckMain = (side: 0 | 1) => (
    <section
      className="kd-performance-main-deck"
      data-side={side === 0 ? "a" : "b"}
      {...{ [TRACK_DECK_DROP_TARGET_ATTR]: String(side) }}
      onDragOver={(event) => {
        if (!isPerformanceDeckDrag(event)) return;
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
        delete event.currentTarget.dataset.kdNativeTrackOver;
        dropIntoPerformanceDeck(event, side, handleManualTrackLoad);
      }}
    >
      {renderTempo(side)}
      {renderDeckPadPanel(side)}
      <div className="kd-performance-deck-mix-module">
        <MixerStrip
          side={side}
          mixer={mixers[side]}
          resonanceQ={filterResonanceQ}
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
          <ArcKnob size="lg" label="FILTER" value={mixers[side].filter} onChange={(filter) => patchMixer(side, { filter })} onReset={() => patchMixer(side, { filter: 0 })} />
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
        onBeats={(beats) => {
          const next: [number, number] = side === 0
            ? [beats, loopBeatsRef.current[1]]
            : [loopBeatsRef.current[0], beats];
          loopBeatsRef.current = next;
          setLoopBeats(next);
        }}
        onJumpBeats={(beats) => setJumpBeats((current) => side === 0 ? [beats, current[1]] : [current[0], beats])}
        onToggleLoop={handleLoopToggle}
        onResizeLoop={handleResizeLoop}
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
            // Only Shift+Jog whole-track search owns an absolute preview. Pointer/touch/MIDI
            // platter motion is velocity input and always follows the audio callback needle.
            const seekPreview = scratchPreviews[side];
            const position = seekPreview ?? decks[side].position;
            const platterMotion = localPlatterActive[side] || decks[side].scratchHeld;
            const platterStartPending = localPlatterActive[side] && !decks[side].scratchHeld;
            const interactiveScrub = platterMotion || seekPreview != null;
            // The callback/DAC rate is the only waveform velocity owner. The optimistic TEMPO
            // preview remains useful for the fader and BPM readout, but letting it reach this rail
            // made React and the live clock alternately overwrite the same WAAPI playbackRate.
            const motionRate = platterMotion
              ? (platterStartPending ? 0 : decks[side].audibleRate)
              : (decks[side].transportRunning ? decks[side].audibleRate : 0);
            return (
              <PerformanceDeckWaves
                key={side}
                deck={decks[side]}
                side={side}
                position={position}
                motionRate={motionRate}
                trimGain={mixers[side].gain}
                interactiveScrub={interactiveScrub}
                snapRail={seekPreview != null && !localPlatterActive[side]}
                motionRevision={deckResetRevisions[side]
                  + decks[side].discontinuityRevision}
                onPlatter={handleManualPlatter}
                onTrackLoad={handleManualTrackLoad}
              />
            );
          })}
        </div>
        <div
          className="kd-performance-info-grid"
          aria-label="Deck A/B 整曲预览波形"
          {...{ [TRACK_DECK_DROP_TARGET_ATTR]: TRACK_DECK_SPLIT_DROP_TARGET }}
          onDragOver={(event) => {
            if (!isPerformanceDeckDrag(event)) return;
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
            const rect = event.currentTarget.getBoundingClientRect();
            const side = event.clientX < rect.left + rect.width / 2 ? 0 : 1;
            delete event.currentTarget.dataset.kdNativeTrackOver;
            dropIntoPerformanceDeck(event, side, handleManualTrackLoad);
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
          <div className="kd-performance-fx-layout" aria-label="双 Deck 效果器">
            {renderDeckFxPage(0)}
            {renderDeckFxPage(1)}
          </div>
        </div>
      </div>
    </>
  );
}
