import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, ChevronDown, Drum, Guitar, Mic, Minus, Pause, Play, Plus, VolumeX } from "lucide-react";
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
  type TrackDeckDropDetail,
} from "../../lib/trackDrag";
import type {
  CuePoint,
  StemModelStatus,
  StemMode,
  StemName,
  Track,
  TrackStemStatus,
  Waveform as WaveformData,
} from "../../types";
import { stemModeLaneKind, stemModeUsesFourLanes, stemModeUsesTwoLanes } from "../../lib/stemMode";
import {
  detailWaveformBuckets,
  performanceWaveformViewportSeconds,
  waveformPointerSeconds,
} from "../../lib/waveformViewport";
import {
  PERFORMANCE_WAVE_DISPLAY_STORAGE_KEY,
  ORIGINAL_WAVE_BIT,
  STEM_WAVE_BITS,
  normalizePerformanceWaveMask,
  performanceStemLanesVisible,
  readPerformanceWaveMask,
} from "../../lib/performanceWaveDisplay";
import { useDjConfig } from "../../lib/djMix";
import {
  ENGINE_TEMPO_MAX,
  ENGINE_TEMPO_MIN,
  applySyncRateBeforePhase,
  barPhaseLock,
  deckSyncRate,
  manualSyncBarInput,
  shouldQuantizeSyncOnPlay,
  scratchSnappedPosition,
  SYNC_PHASE_TOLERANCE_SEC,
  syncPhaseConfirmationDelayMs,
  syncSeekLeadSeconds,
  syncFollowerSeekPositionWithLead,
} from "../../lib/beatGridSync";
import { LatestTempoCommandLane } from "../../lib/tempoCommandLane";
import {
  cachedWaveform,
  loadWaveformForTrack,
  streamWaveformSnapshot,
  subscribeStreamWaveform,
} from "../../lib/waveformCache";
import { isStreamTrack } from "../../lib/streamTrack";
import { Waveform, type SeekDetail } from "../library/Waveform";
import { PerformanceWaveformCanvas, type PerformanceWaveLaneSource } from "./PerformanceWaveformCanvas";
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
import { usesLocalLibraryRecord } from "../../lib/playbackTrackSource";
import { STEM_GAIN_UNITY, stemEqRingFillPath, stemEqRingTrackPath, stemEqToGain, stemGainToEq } from "../../lib/stemEq";
import { knobBias, snapKnobToCenter, stemDeckLog, stemJobLine } from "../../lib/stemDeckLog";

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
  stemModel: StemModelStatus | null;
  stemMode: StemMode;
  masterVolume: number;
  embedded?: boolean;
  onClose?: () => void;
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
  onMixerChange: (
    side: 0 | 1,
    values: PerformanceMixerValues,
    channelGain: number,
  ) => void;
  onMasterVolumeChange: (volume: number) => void;
  onStartStems: (side: 0 | 1) => void;
  onEnsureStemWaveScan?: (side: 0 | 1) => void;
  onReleaseStemWaveScan?: (trackId: number) => void;
  onStemWaveMaskChange?: (mask: number) => void;
  onDownloadStemModel: () => void;
  onToggleStem: (side: 0 | 1, stem: StemName) => void;
  onStemGain: (side: 0 | 1, stem: StemName, value: number) => void;
  onOriginalMode: (side: 0 | 1) => void;
  onSetLoop: (side: 0 | 1, start: number, length: number) => void;
  onClearLoop: (side: 0 | 1) => void;
  onSaveCuePoints: (track: Track, cues: CuePoint[]) => Promise<void>;
  onSaveMainCue: (track: Track, cueMs: number) => Promise<void>;
}

type ModuleId = "info" | "wave" | "pads" | "mixer" | "monitor";

const MODULES: { id: ModuleId; label: string }[] = [
  { id: "info", label: "INFO" },
  { id: "wave", label: "WAVE" },
  { id: "pads", label: "CUE" },
  { id: "mixer", label: "MIX" },
  { id: "monitor", label: "MON" },
];
const ALL_MODULES = MODULES.map((module) => module.id);
const MODULE_STORAGE_KEY = "kd-performance-modules-v2";
const MIXER_STORAGE_KEY = "kd-performance-mixer-v2";
const LOOP_BEATS_STORAGE_KEY = "kd-performance-loop-beats-v1";
const CROSSFADER_ENABLED_STORAGE_KEY = "kd-performance-crossfader-enabled-v1";

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

function readModules(): ModuleId[] {
  try {
    const value = JSON.parse(localStorage.getItem(MODULE_STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(value)) {
      const selected = value.filter((item): item is ModuleId =>
        ALL_MODULES.includes(item as ModuleId),
      );
      if (selected.length) return selected;
    }
  } catch {
    // 坏存档回到默认全开。
  }
  return ALL_MODULES;
}

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

const LOOP_BEAT_CHOICES = [1, 2, 4, 8, 16, 32];

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function deckCues(track: Track | null): CuePoint[] {
  return track?.cue_points ? [...track.cue_points] : [];
}

function effectiveBpm(deck: PerformanceDeckModel): number | null {
  return deck.track?.bpm ? deck.track.bpm * deck.rate : null;
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
  icon: typeof Drum;
};

const FOUR_STEM_OPTIONS: StemOption[] = [
  { stem: "drums", label: "DRUMS", short: "D", shortcut: "D", bit: STEM_WAVE_BITS.drums, gainIndex: 0, icon: Drum },
  { stem: "bass", label: "BASS", short: "B", shortcut: "B", bit: STEM_WAVE_BITS.bass, gainIndex: 1, icon: Guitar },
  { stem: "other", label: "OTHER", short: "O", shortcut: "O", bit: STEM_WAVE_BITS.other, gainIndex: 2, icon: AudioLines },
  { stem: "vocals", label: "VOCALS", short: "V", shortcut: "V", bit: STEM_WAVE_BITS.vocals, gainIndex: 3, icon: Mic },
];

const TWO_STEM_OPTIONS: StemOption[] = [
  { stem: "other", label: "INSTRUMENTAL", short: "I", shortcut: "I", bit: STEM_WAVE_BITS.other, gainIndex: 2, icon: AudioLines },
  { stem: "vocals", label: "VOCALS", short: "V", shortcut: "V", bit: STEM_WAVE_BITS.vocals, gainIndex: 3, icon: Mic },
];

const FOUR_STEM_EQ_KNOBS: { stem: StemName; label: string; gainIndex: 0 | 1 | 2 | 3 }[] = [
  { stem: "vocals", label: "VOCALS", gainIndex: 3 },
  { stem: "other", label: "OTHER", gainIndex: 2 },
  { stem: "bass", label: "BASS", gainIndex: 1 },
  { stem: "drums", label: "DRUMS", gainIndex: 0 },
];

const TWO_STEM_EQ_KNOBS: { stem: StemName; label: string; gainIndex: 0 | 1 | 2 | 3 }[] = [
  { stem: "vocals", label: "VOCALS", gainIndex: 3 },
  { stem: "other", label: "INSTRUMENTAL", gainIndex: 2 },
];

function stemOptions(mode: StemMode): StemOption[] {
  return stemModeUsesFourLanes(mode) ? FOUR_STEM_OPTIONS : stemModeUsesTwoLanes(mode) ? TWO_STEM_OPTIONS : [];
}

function stemEqKnobs(mode: StemMode) {
  return stemModeUsesFourLanes(mode) ? FOUR_STEM_EQ_KNOBS : stemModeUsesTwoLanes(mode) ? TWO_STEM_EQ_KNOBS : [];
}

/** 低于这个幅度就当作底噪留空（后端 amp 已归一化到 0..1）。 */
const STEM_SILENCE_THRESHOLD = 0.06;

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

function DeckStemLog({
  status,
  model,
  displaying,
}: {
  status: TrackStemStatus | null;
  model: StemModelStatus | null;
  displaying: boolean;
}) {
  const log = stemDeckLog(status, model, displaying);
  return (
    <div
      className="kd-performance-stem-log"
      data-error={log.error || undefined}
      title={log.title || undefined}
    >
      <span>{log.job}</span>
      <span>{log.runtime}</span>
    </div>
  );
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

function DeckWave({
  deck,
  side,
  position,
  onTrackDrop,
}: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  position: number;
  onTrackDrop: PerformanceWorkspaceProps["onTrackDrop"];
}) {
  const track = deck.track;
  const bpm = effectiveBpm(deck);
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
      <span className="kd-performance-wave-id" aria-hidden="true">{side === 0 ? "A" : "B"}</span>
      <span className="kd-performance-wave-bpm">{bpm ? bpm.toFixed(1) : "—"}</span>
      <span className="kd-performance-wave-time">{formatDuration(position)}</span>
    </div>
  );
}

/** 顶栏硬件式按键：A/B 共用可见车道，与 STEM 声音掩码完全独立。 */
function ToolbarWaveChannels({ displayMask, stemMode, onDisplayMask }: {
  displayMask: number;
  stemMode: StemMode;
  onDisplayMask: (mask: number) => void;
}) {
  return (
    <span
      className="kd-performance-toolbar-waves"
      role="group"
      aria-label="A/B Deck 共用波形显示"
    >
      <b>WAVES</b>
      <button
        type="button"
        data-active={(displayMask & ORIGINAL_WAVE_BIT) !== 0 || undefined}
        title="原曲波形"
        onClick={() => onDisplayMask(displayMask ^ ORIGINAL_WAVE_BIT)}
      >
        ORG
      </button>
      {stemOptions(stemMode).map(({ stem, short, bit }) => (
        <button
          type="button"
          key={stem}
          data-active={(displayMask & bit) !== 0 || undefined}
          title={`${stem.toUpperCase()} 波形`}
          onClick={() => onDisplayMask(displayMask ^ bit)}
        >
          {short}
        </button>
      ))}
    </span>
  );
}

function StemWaveLanes({
  displayMask,
  stemMode,
}: {
  displayMask: number;
  stemMode: StemMode;
}) {
  // 车道数量只由用户按键决定。波形响应到达前保留同高空槽，加载/换歌不会把
  // STEM 区先清零再逐条撑开。
  const visibleLanes = stemOptions(stemMode).filter(({ bit }) => (displayMask & bit) !== 0);
  if (visibleLanes.length === 0) return null;
  return (
    <div className="kd-performance-stem-lanes">
      {visibleLanes.map(({ stem, label, icon: Icon }) => (
          <div
            className="kd-performance-stem-lane"
            key={stem}
            data-stem={stem}
            data-kd-performance-wave-lane={stem}
          >
            <span className="kd-performance-stem-wave-empty" aria-hidden="true" />
            <i className="kd-performance-stem-lane-icon" title={label} aria-label={label}>
              <Icon size={10} strokeWidth={2.4} />
            </i>
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
  const laneSources = useMemo<PerformanceWaveLaneSource[]>(() => {
    const result: PerformanceWaveLaneSource[] = [];
    for (const { stem, bit, gainIndex } of stemOptions(stemMode)) {
      if ((displayMask & bit) === 0) continue;
      const waveform = track && waveforms[stem]?.track_id === track.id ? waveforms[stem] ?? null : null;
      const gain = !stemState.enabled
        ? 1
        : (stemState.mask & bit) !== 0
          ? clamp(stemState.gains[gainIndex] ?? 1, 0, 1)
          : 0;
      result.push({
        key: stem,
        waveform: waveform ?? (stemState.enabled ? pendingWave : null),
        placeholder: mainWaveform,
        opacity: gain >= 0.999 ? 1 : 0.25 + 0.75 * gain,
        silenceThreshold: STEM_SILENCE_THRESHOLD,
        verticalInsetRatio: 0.1,
      });
    }
    if ((displayMask & ORIGINAL_WAVE_BIT) !== 0) {
      result.push({
        key: "org",
        waveform: mainWaveform,
        opacity: 1,
        silenceThreshold: 0,
        verticalInsetRatio: 0.1,
      });
    }
    return result;
  }, [displayMask, mainWaveform, pendingWave, stemMode, stemState, track?.id, waveforms]);

  return (
    <div className="kd-performance-deck-waves" data-side={side === 0 ? "a" : "b"}>
      <StemWaveLanes displayMask={displayMask} stemMode={stemMode} />
      {(displayMask & ORIGINAL_WAVE_BIT) !== 0 ? (
        <StableDeckWave
          deck={deck}
          side={side}
          position={position}
          onTrackDrop={onTrackDrop}
        />
      ) : null}
      <PerformanceWaveformCanvas
        trackId={track?.id ?? null}
        position={position}
        duration={duration}
        rate={deck.rate}
        playing={deck.playing}
        interactive={interactiveScrub}
        snap={snapRail}
        lanes={laneSources}
        bpm={track?.bpm ?? null}
        firstBeat={track?.first_beat ?? null}
        bpmConfidence={track?.bpm_confidence ?? null}
        cuePoints={track?.cue_points ?? []}
        cueMs={track?.cue_ms ?? null}
        endMs={track?.end_ms ?? null}
        loopStart={deck.loopStart}
        loopLength={deck.loopLength}
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

function DeckInfo({ deck, side, preserveBarPhase, onSeek, onTrackDrop }: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  preserveBarPhase: boolean;
  onSeek: PerformanceWorkspaceProps["onSeek"];
  onTrackDrop: PerformanceWorkspaceProps["onTrackDrop"];
}) {
  const track = deck.track;
  const dropTarget = { [TRACK_DECK_DROP_TARGET_ATTR]: String(side) };
  const keyColor = parseCamelot(track?.camelot) ? camelotColor(track?.camelot) : undefined;
  return (
    <section
      className="kd-performance-info"
      data-side={side === 0 ? "a" : "b"}
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
      <span className="kd-performance-vinyl" aria-hidden="true">
        {track ? (
          <span className="kd-performance-vinyl-record" data-spinning={deck.playing || undefined}>
            {deck.cover ? <img src={deck.cover} alt="" /> : null}
          </span>
        ) : null}
      </span>
      <div className="kd-performance-info-copy">
        <strong>{track?.title || track?.filename || ""}</strong>
        <span>{track?.artist || ""}</span>
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
            onSeek={(detail) => onSeek(side, detail)}
            className="kd-performance-overview-wave"
          />
        ) : null}
      </div>
      <dl className="kd-performance-metadata">
        <div><dt>KEY</dt><dd style={keyColor ? { color: keyColor } : undefined}>{deckKey(track)}</dd></div>
        <div><dt>BPM</dt><dd>{effectiveBpm(deck)?.toFixed(1) ?? "—"}</dd></div>
      </dl>
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

/** STEM 垫只负责开关；音量改由中央外侧的 STEM EQ 旋钮控制。 */
function StemPads({ deck, stemState, stemModel, stemMode, side, onDownloadStemModel, onToggleStem }: {
  deck: PerformanceDeckModel;
  stemState: PerformanceStemDeckModel;
  stemModel: StemModelStatus | null;
  stemMode: StemMode;
  side: 0 | 1;
  onDownloadStemModel: PerformanceWorkspaceProps["onDownloadStemModel"];
  onToggleStem: PerformanceWorkspaceProps["onToggleStem"];
}) {
  const track = deck.track;
  if (!track) return null;
  if (stemModel?.supported && stemModel.state !== "ready") {
    const downloading = stemModel.state === "queued" || stemModel.state === "downloading";
    const progress = Math.round(stemModel.progress * 100);
    return (
      <div className="kd-performance-stem-download" data-side={side === 0 ? "a" : "b"}>
        <button
          type="button"
          disabled={downloading}
          onClick={onDownloadStemModel}
          aria-label="下载分轨模型"
        >
          {downloading
            ? `正在下载分轨模型 ${progress}%`
            : "点击此处下载分轨模型（需要连接 Hugging Face）"}
        </button>
        {downloading ? (
          <i aria-hidden="true"><span style={{ width: `${progress}%` }} /></i>
        ) : null}
      </div>
    );
  }
  const ready = stemState.status?.state === "ready";
  const busy = Boolean(
    stemState.status && !["missing", "ready", "error"].includes(stemState.status.state),
  );
  const job = stemJobLine(stemState.status, stemModel);
  return (
    <div className="kd-performance-stem-pads" data-mode={stemModeLaneKind(stemMode)} data-side={side === 0 ? "a" : "b"} data-enabled={stemState.enabled || undefined}>
      {stemOptions(stemMode).map(({ stem, label, bit, icon: Icon }) => {
        const audible = stemState.enabled && (stemState.mask & bit) !== 0;
        return (
          <div
            className="kd-performance-stem-pad"
            key={stem}
            data-stem={stem}
            data-audible={audible || undefined}
            data-ready={ready || undefined}
          >
            <button
              type="button"
              className="kd-performance-stem-pad-main"
              disabled={busy}
              title={
                ready
                  ? `${label} ${audible ? "静音" : "启用"} · Shift+${label[0]}`
                  : busy
                    ? job
                    : `生成并启用 ${label}`
              }
              onClick={() => onToggleStem(side, stem)}
            >
              <Icon size={13} strokeWidth={2.2} />
              <span>{label}</span>
              <i className="kd-performance-stem-mute" data-muted={!audible || undefined}>
                <VolumeX size={10} strokeWidth={2.4} />
              </i>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** LOOP 控制：开/关 + 拍数步进 + 节拍跳转。循环窗口由引擎无缝回绕。 */
function LoopControls({ deck, side, beats, quantize, onBeats, onSetLoop, onClearLoop, onSeek }: {
  deck: PerformanceDeckModel;
  side: 0 | 1;
  beats: number;
  quantize: boolean;
  onBeats: (beats: number) => void;
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
    const at = clamp(deck.position + direction * beats * beat, 0, deck.duration);
    onSeek(side, { position: at, forceCommit: true });
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
          <button type="button" disabled={!track || !beat} title={`后退 ${beats} 拍`} onClick={() => jump(-1)}>‹‹</button>
          <button type="button" disabled={!track || !beat} title={`前进 ${beats} 拍`} onClick={() => jump(1)}>››</button>
        </span>
        <em>{`< ${beats} BEATS >`}</em>
      </span>
    </div>
  );
}

function Knob({
  label,
  value,
  min = -1,
  max = 1,
  step = 0.01,
  onChange,
  onReset,
  variant = "disc",
  stem,
  disabled = false,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onReset?: () => void;
  variant?: "disc" | "ring";
  stem?: StemName;
  disabled?: boolean;
}) {
  const shown = snapKnobToCenter(value, min, max);
  const ratio = (shown - min) / (max - min);
  const angle = -135 + clamp(ratio, 0, 1) * 270;
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    value: number;
    moved: boolean;
  } | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const lastClickAtRef = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
  }, []);
  const valueFromDrag = (x: number, y: number) => {
    const drag = dragRef.current;
    if (!drag) return value;
    const travel = (x - drag.x) - (y - drag.y);
    const raw = drag.value + travel / 180 * (max - min);
    const stepped = Math.round((raw - min) / step) * step + min;
    return snapKnobToCenter(clamp(Number(stepped.toFixed(6)), min, max), min, max);
  };
  const finishDrag = (event: React.PointerEvent<HTMLInputElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    if (!drag.moved && event.type === "pointerup") {
      const now = performance.now();
      if (now - lastClickAtRef.current <= 320) {
        if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
        lastClickAtRef.current = Number.NEGATIVE_INFINITY;
        onReset?.();
      } else {
        lastClickAtRef.current = now;
        const rect = event.currentTarget.getBoundingClientRect();
        const horizontal = event.clientX - (rect.left + rect.width / 2);
        const vertical = rect.top + rect.height / 2 - event.clientY;
        const direction = Math.abs(horizontal) >= Math.abs(vertical)
          ? (horizontal >= 0 ? 1 : -1)
          : (vertical >= 0 ? 1 : -1);
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null;
          onChange(snapKnobToCenter(clamp(Number((drag.value + direction * step).toFixed(6)), min, max), min, max));
        }, 330);
      }
    }
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Pointer capture can already be gone after a cancelled gesture.
    }
    event.currentTarget.removeAttribute("data-dragging");
  };
  const ring = variant === "ring";
  const fillPath = ring ? stemEqRingFillPath(shown) : null;
  const bias = knobBias(shown, min, max);
  return (
    <label
      className={ring ? "kd-performance-stem-eq-knob" : "kd-performance-knob"}
      data-stem={stem}
      data-boost={bias === "boost" ? "true" : undefined}
      data-cut={bias === "cut" ? "true" : undefined}
      title={`${label} ${shown.toFixed(2)}`}
      onDoubleClick={disabled ? undefined : onReset}
    >
      <span style={{ "--kd-knob-angle": `${angle}deg` } as CSSProperties}>
        {ring ? (
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <path className="track" d={stemEqRingTrackPath()} />
            {fillPath ? <path className="fill" d={fillPath} /> : null}
          </svg>
        ) : null}
        <i />
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(snapKnobToCenter(Number(event.currentTarget.value), min, max))}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            value,
            moved: false,
          };
          event.currentTarget.dataset.dragging = "true";
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          event.preventDefault();
          if (Math.abs(event.clientX - dragRef.current.x) + Math.abs(event.clientY - dragRef.current.y) >= 2) {
            dragRef.current.moved = true;
          }
          onChange(valueFromDrag(event.clientX, event.clientY));
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      />
      <b>{label}</b>
    </label>
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
  onPreviewRate: (side: 0 | 1, rate: number) => void;
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
    const rate = clamp(value, bounds.min, bounds.max);
    draftRef.current = rate;
    setDraft(rate);
    // Waveform scale must follow the fader immediately. Native tempo still goes through the
    // latest-value lane so IPC cannot retarget every rail on every pointer sample.
    onPreviewRateRef.current(sideRef.current, rate);
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

  const faderRef = useRef<HTMLDivElement>(null);
  const faderPointerRef = useRef<number | null>(null);
  const rateAtPointer = (clientY: number): number => {
    const el = faderRef.current;
    if (!el) return draftRef.current;
    const rect = el.getBoundingClientRect();
    const ratio = clamp((rect.bottom - clientY) / rect.height, 0, 1);
    let rate = range.min + ratio * (range.max - range.min);
    // 中位卡口：拖过 0% 附近时吸附到原速，手感跟硬件推子一致。
    if (range.min < 1 && range.max > 1 && Math.abs(rate - 1) <= (range.max - range.min) * 0.02) rate = 1;
    return rate;
  };
  const onFaderDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !track) return;
    event.preventDefault();
    tempoGestureRef.current = true;
    faderPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    commit(rateAtPointer(event.clientY));
  };
  const onFaderMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (faderPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    commit(rateAtPointer(event.clientY));
  };
  const onFaderUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (faderPointerRef.current !== event.pointerId) return;
    faderPointerRef.current = null;
    tempoGestureRef.current = false;
    // Pointer-up is the single value that must never remain behind the lane's trailing timer.
    tempoLaneRef.current?.flush();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit 可能在 pointercancel 前先释放捕获。
    }
  };
  const onFaderKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? TEMPO_STEP * 10 : TEMPO_STEP;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      commit(draftRef.current + step);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      commit(draftRef.current - step);
    }
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
      <div
        ref={faderRef}
        className="kd-performance-tempo-body"
        data-takeover={takeoverActive || undefined}
        role="slider"
        tabIndex={0}
        aria-label={`Deck ${side === 0 ? "A" : "B"} Tempo`}
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuenow={shown}
        aria-valuetext={pctText}
        onPointerDown={onFaderDown}
        onPointerMove={onFaderMove}
        onPointerUp={onFaderUp}
        onPointerCancel={onFaderUp}
        onKeyDown={onFaderKey}
        onDoubleClick={() => {
          commit(1);
          tempoLaneRef.current?.flush();
        }}
        title="拖动调整速度，双击恢复原速"
      >
        <i className="kd-performance-tempo-ticks" aria-hidden="true"><u /><u /><u /><u /><u /></i>
        <i className="kd-performance-tempo-zero" style={{ bottom: `${zeroRatio * 100}%` }} aria-hidden="true" />
        <i
          className="kd-performance-tempo-lock"
          data-active={locked || undefined}
          style={{ bottom: `${zeroRatio * 100}%` }}
          aria-hidden="true"
        />
        {takeoverActive && hardwareRatio != null ? (
          <>
            <i
              className="kd-performance-tempo-takeover"
              style={{
                bottom: `${Math.min(softwareRatio, hardwareRatio) * 100}%`,
                height: `${Math.abs(softwareRatio - hardwareRatio) * 100}%`,
              }}
              aria-hidden="true"
            />
            <i
              className="kd-performance-tempo-thumb"
              data-hardware="true"
              style={{ bottom: `${hardwareRatio * 100}%` }}
              aria-hidden="true"
            />
          </>
        ) : null}
        <i
          className="kd-performance-tempo-thumb"
          data-center={(!takeoverActive && Math.abs(shown - 1) < 0.0005) || undefined}
          style={{ bottom: `${softwareRatio * 100}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="kd-performance-tempo-side">
        <button
          type="button"
          className="kd-performance-sync"
          data-active={locked || undefined}
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

/** 通道音量 / 横推：和 TEMPO 同一套胶囊推子，不再用旋转的原生 range。 */
function MixerFader({
  axis,
  value,
  label,
  disabled,
  onChange,
  onReset,
}: {
  axis: "vertical" | "horizontal";
  value: number;
  label: string;
  disabled?: boolean;
  onChange: (value: number) => void;
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
    if (axis === "horizontal" && Math.abs(next - 0.5) <= 0.02) next = 0.5;
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

/** 单边通道条：GAIN/HIGH/MID/LOW 成列，FILTER 与通道推子同列——对齐真实 DJ 台布局。 */
function MixerStrip({ side, mixer, setMixer }: {
  side: 0 | 1;
  mixer: PerformanceMixerValues;
  setMixer: (patch: Partial<PerformanceMixerValues>) => void;
}) {
  return (
    <div className="kd-performance-strip" data-side={side === 0 ? "a" : "b"}>
      <div className="kd-performance-strip-knobs">
        <Knob label="GAIN" value={mixer.gain} min={-1} max={1} onChange={(gain) => setMixer({ gain })} onReset={() => setMixer({ gain: 0 })} />
        <Knob label="HIGH" value={mixer.high} onChange={(high) => setMixer({ high })} onReset={() => setMixer({ high: 0 })} />
        <Knob label="MID" value={mixer.mid} onChange={(mid) => setMixer({ mid })} onReset={() => setMixer({ mid: 0 })} />
        <Knob label="LOW" value={mixer.low} onChange={(low) => setMixer({ low })} onReset={() => setMixer({ low: 0 })} />
      </div>
      <div className="kd-performance-strip-fader">
        <Knob label="FILTER" value={mixer.filter} onChange={(filter) => setMixer({ filter })} onReset={() => setMixer({ filter: 0 })} />
        <MixerFader
          axis="vertical"
          value={mixer.volume}
          label={`CH ${side === 0 ? "A" : "B"} 音量`}
          onChange={(volume) => setMixer({ volume })}
          onReset={() => setMixer({ volume: 1 })}
        />
      </div>
    </div>
  );
}

function StemEqStrip({
  side,
  gains,
  stemMode,
  midiActive,
  ready,
  onChange,
}: {
  side: 0 | 1;
  gains: PerformanceStemGains;
  stemMode: StemMode;
  midiActive: boolean;
  ready: boolean;
  onChange: (stem: StemName, gain: number) => void;
}) {
  const knobs = stemEqKnobs(stemMode);
  if (knobs.length === 0) return null;
  return (
    <div
      className="kd-performance-stem-eq"
      data-mode={stemModeLaneKind(stemMode)}
      data-side={side === 0 ? "a" : "b"}
      data-midi={midiActive || undefined}
    >
      <b>STEM EQ</b>
      <div>
        {knobs.map(({ stem, label, gainIndex }) => (
          <Knob
            key={stem}
            variant="ring"
            stem={stem}
            label={label}
            value={stemGainToEq(gains[gainIndex])}
            min={-1}
            max={1}
            disabled={!ready}
            onChange={(eq) => onChange(stem, stemEqToGain(eq))}
            onReset={() => onChange(stem, STEM_GAIN_UNITY)}
          />
        ))}
      </div>
    </div>
  );
}

function DeckControls({
  deck,
  stemState,
  stemModel,
  stemMode,
  side,
  modules,
  quantize,
  loopBeats,
  setLoopBeats,
  onSeek,
  onTogglePlay,
  onMainCue,
  syncLocked,
  syncEnabled,
  onToggleSync,
  onRateChange,
  onPreviewRate,
  hardwareUnit,
  onSoftwareTempoOverride,
  onDownloadStemModel,
  onToggleStem,
  onSetLoop,
  onClearLoop,
  onSaveCuePoints,
  onSaveMainCue,
  stemLanesVisible,
}: {
  deck: PerformanceDeckModel;
  stemState: PerformanceStemDeckModel;
  stemModel: StemModelStatus | null;
  stemMode: StemMode;
  side: 0 | 1;
  modules: Set<ModuleId>;
  quantize: boolean;
  loopBeats: number;
  setLoopBeats: (beats: number) => void;
  onSeek: PerformanceWorkspaceProps["onSeek"];
  onTogglePlay: PerformanceWorkspaceProps["onTogglePlay"];
  onMainCue: PerformanceWorkspaceProps["onMainCue"];
  syncLocked: boolean;
  syncEnabled: boolean;
  onToggleSync: (side: 0 | 1) => void;
  onRateChange: PerformanceWorkspaceProps["onRateChange"];
  onPreviewRate: (side: 0 | 1, rate: number) => void;
  hardwareUnit: number | null;
  onSoftwareTempoOverride: (side: 0 | 1) => void;
  onDownloadStemModel: PerformanceWorkspaceProps["onDownloadStemModel"];
  onToggleStem: PerformanceWorkspaceProps["onToggleStem"];
  onSetLoop: PerformanceWorkspaceProps["onSetLoop"];
  onClearLoop: PerformanceWorkspaceProps["onClearLoop"];
  onSaveCuePoints: PerformanceWorkspaceProps["onSaveCuePoints"];
  onSaveMainCue: PerformanceWorkspaceProps["onSaveMainCue"];
  stemLanesVisible: boolean;
}) {
  const track = deck.track;
  const cue = track?.cue_ms != null ? track.cue_ms / 1000 : (track?.first_beat ?? 0);
  const setMainCue = () => {
    if (!track) return;
    const at = snapCueSeconds(deck.position, track.bpm, track.first_beat, quantize);
    void onSaveMainCue(track, Math.round(at * 1000));
  };
  return (
    <section className="kd-performance-deck-controls" data-side={side === 0 ? "a" : "b"} data-playing={deck.playing || undefined}>
      <div className="kd-performance-deck-main">
        {stemMode !== "none" ? (
          <StemPads
            deck={deck}
            stemState={stemState}
            stemModel={stemModel}
            stemMode={stemMode}
            side={side}
            onDownloadStemModel={onDownloadStemModel}
            onToggleStem={onToggleStem}
          />
        ) : null}
        <div className="kd-performance-transport">
          <button type="button" className="kd-performance-play" data-active={deck.playing || undefined} onClick={() => onTogglePlay(side)} disabled={!track} aria-label={deck.playing ? "暂停" : "播放"}>
            {deck.playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" className="kd-performance-main-cue" onClick={() => onMainCue(side, cue)} onDoubleClick={setMainCue} disabled={!track}>CUE</button>
          {modules.has("pads") ? (
            <HotCuePads deck={deck} side={side} quantize={quantize} onSeek={onSeek} onSaveCuePoints={onSaveCuePoints} />
          ) : null}
          <LoopControls
            deck={deck}
            side={side}
            beats={loopBeats}
            quantize={quantize}
            onBeats={setLoopBeats}
            onSetLoop={onSetLoop}
            onClearLoop={onClearLoop}
            onSeek={onSeek}
          />
        </div>
      </div>
      {modules.has("mixer") ? (
        <TempoPanel
          deck={deck}
          side={side}
          locked={syncLocked}
          syncEnabled={syncEnabled}
          onToggleSync={onToggleSync}
          onRateChange={onRateChange}
          onPreviewRate={onPreviewRate}
          hardwareUnit={hardwareUnit}
          onSoftwareTempoOverride={onSoftwareTempoOverride}
        />
      ) : null}
      <DeckStemLog status={stemState.status} model={stemModel} displaying={stemLanesVisible} />
    </section>
  );
}

const StableDeckWave = memo(DeckWave);
const StableDeckInfo = memo(DeckInfo);

export function PerformanceWorkspace({
  decks,
  stems,
  stemModel,
  stemMode,
  masterVolume,
  embedded = false,
  onClose,
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
  onMixerChange,
  onMasterVolumeChange,
  onStartStems,
  onEnsureStemWaveScan,
  onReleaseStemWaveScan,
  onStemWaveMaskChange,
  onDownloadStemModel,
  onToggleStem,
  onStemGain,
  onSetLoop,
  onClearLoop,
  onSaveCuePoints,
  onSaveMainCue,
}: PerformanceWorkspaceProps) {
  const autoBeatSync = useDjConfig((state) => state.autoBeatSync);
  const [visible, setVisible] = useState<ModuleId[]>(readModules);
  const [quantize, setQuantize] = useState(true);
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
  const [eqStemMode, setEqStemMode] = useState<[EqStemLayer, EqStemLayer]>(["eq", "eq"]);
  const [midiPort, setMidiPort] = useState<string | null>(null);
  const [headMix, setHeadMix] = useState(0);
  const [loopBeats, setLoopBeats] = useState<[number, number]>(readLoopBeats);
  const [storedStemDisplayMask, setStoredStemDisplayMask] = useState(readPerformanceWaveMask);
  // Fast Refresh can retain a pre-v3 mask with ORG turned off. Normalize at the render boundary,
  // not only while reading localStorage, so an already-open Performance view recovers immediately.
  const stemDisplayMask = normalizePerformanceWaveMask(storedStemDisplayMask);
  const allowedStemDisplayMask = stemModeUsesFourLanes(stemMode)
    ? 0b1111
    : stemModeUsesTwoLanes(stemMode)
      ? STEM_WAVE_BITS.other | STEM_WAVE_BITS.vocals
      : 0;
  const activeStemDisplayMask = stemDisplayMask & (ORIGINAL_WAVE_BIT | allowedStemDisplayMask);
  const setStemDisplayMask = useCallback((mask: number) => {
    setStoredStemDisplayMask(normalizePerformanceWaveMask(mask));
  }, []);
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
  const deckTrackIdsRef = useRef<[number | null, number | null]>([
    decks[0].track?.id ?? null,
    decks[1].track?.id ?? null,
  ]);
  deckTrackIdsRef.current = [decks[0].track?.id ?? null, decks[1].track?.id ?? null];
  const jogTouchRef = useRef<[boolean, boolean]>([false, false]);
  const decksRef = useRef(decks);
  decksRef.current = decks;
  const stemsRef = useRef(stems);
  stemsRef.current = stems;
  const stemModelRef = useRef(stemModel);
  stemModelRef.current = stemModel;
  const syncLockRef = useRef(syncLock);
  syncLockRef.current = syncLock;
  const scratchPreviewsRef = useRef(scratchPreviews);
  scratchPreviewsRef.current = scratchPreviews;
  const syncConfirmationTimerRef = useRef<number | null>(null);
  const syncInteractionRevisionRef = useRef(0);
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
  const modules = useMemo(() => new Set(visible), [visible]);

  useEffect(() => () => {
    if (syncConfirmationTimerRef.current !== null) {
      window.clearTimeout(syncConfirmationTimerRef.current);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(MODULE_STORAGE_KEY, JSON.stringify(visible));
  }, [visible]);
  useEffect(() => {
    localStorage.setItem(LOOP_BEATS_STORAGE_KEY, JSON.stringify(loopBeats));
  }, [loopBeats]);
  useEffect(() => {
    localStorage.setItem(PERFORMANCE_WAVE_DISPLAY_STORAGE_KEY, JSON.stringify(stemDisplayMask));
    onStemWaveMaskChange?.(stemDisplayMask);
  }, [onStemWaveMaskChange, stemDisplayMask]);
  useEffect(() => {
    const previous = stemScanTrackIdsRef.current;
    const next: [number | null, number | null] = [
      decks[0].track?.id ?? null,
      decks[1].track?.id ?? null,
    ];
    [...new Set(previous.filter((trackId): trackId is number => trackId !== null))]
      .filter((trackId) => !next.includes(trackId))
      .forEach((trackId) => onReleaseStemWaveScan?.(trackId));
    stemScanTrackIdsRef.current = next;
    if (stemModel?.state !== "ready") return;
    // Give the original 640-column rail its first paint, then automatically prepare STEM around
    // each loaded Deck. Staggering the mounts avoids two cold decode requests landing together;
    // the native scheduler still owns inference priority and expands beyond the viewport later.
    const timers = ([0, 1] as const).flatMap((side) => {
      if (next[side] === null) return [];
      return [window.setTimeout(
        () => onEnsureStemWaveScan?.(side),
        700 + side * 300,
      )];
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [
    decks[0].track?.id,
    decks[1].track?.id,
    onEnsureStemWaveScan,
    onReleaseStemWaveScan,
    stemModel?.state,
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
  useEffect(() => {
    const drop = (event: Event) => {
      const detail = (event as CustomEvent<TrackDeckDropDetail>).detail;
      if (!detail || (detail.side !== 0 && detail.side !== 1) || detail.ids.length === 0) return;
      onTrackDrop(detail.side, detail.ids);
    };
    window.addEventListener(TRACK_DECK_DROP_EVENT, drop);
    return () => window.removeEventListener(TRACK_DECK_DROP_EVENT, drop);
  }, [onTrackDrop]);

  useEffect(() => {
    setStemWaveforms([{}, {}]);
    stemWaveCursorRef.current = [
      { trackId: decks[0].track?.id ?? null, epoch: null, revision: 0 },
      { trackId: decks[1].track?.id ?? null, epoch: null, revision: 0 },
    ];
    // 任一台换歌后旧的对齐关系不再成立，解除 SYNC 锁定（重新点 SYNC 即可）。
    setSyncLock(null);
  }, [decks[0].track?.id, decks[1].track?.id, stemMode]);

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
          // A fresh wrapper makes Waveform repaint only when a real Spleeter4 block changed. Its
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
        onStartStems(side);
        return;
      }
      const stem = stemOptions(stemMode).find((option) => option.shortcut.toLowerCase() === key)?.stem;
      if (stem) {
        event.preventDefault();
        onToggleStem(side, stem);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [decks[0].active, decks[1].active, onStartStems, onToggleStem, stemMode]);

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

  const syncEnabled = Boolean(decks[0].track?.bpm && decks[1].track?.bpm);
  const previewDeckRate = (side: 0 | 1, rate: number): number | null => {
    const other = (1 - side) as 0 | 1;
    const thisBpm = decks[side].track?.bpm;
    const otherBpm = decks[other].track?.bpm;
    const follow = syncLock && thisBpm && otherBpm
      ? clamp(
        syncLock.base === side
          ? (rate * thisBpm * syncLock.multiple) / otherBpm
          : (rate * thisBpm) / (syncLock.multiple * otherBpm),
        ENGINE_TEMPO_MIN,
        ENGINE_TEMPO_MAX,
      )
      : null;
    setVisualRates((current) => {
      const next: [number | null, number | null] = [
        side === 0 ? rate : (follow ?? current[0]),
        side === 1 ? rate : (follow ?? current[1]),
      ];
      return next[0] === current[0] && next[1] === current[1] ? current : next;
    });
    return follow;
  };

  const barPhaseInput = (
    side: 0 | 1,
    masterSide: 0 | 1,
    multiple: number,
    followerRate: number,
  ) => {
    const follower = decksRef.current[side];
    const master = decksRef.current[masterSide];
    const followerBpm = follower.track?.bpm;
    const masterBpm = master.track?.bpm;
    if (
      !follower.track
      || !master.track
      || followerBpm == null
      || masterBpm == null
      || follower.track.first_beat == null
      || master.track.first_beat == null
    ) {
      return null;
    }
    return manualSyncBarInput({
      followerPositionSec: follower.position,
      followerBpm,
      followerFirstBeatSec: follower.track.first_beat,
      followerRate,
      masterPositionSec: master.position,
      masterBpm,
      masterFirstBeatSec: master.track.first_beat,
      masterRate: master.rate,
      multiple,
    });
  };

  const syncPhysicalDeck = (
    side: 0 | 1,
    masterSide: 0 | 1,
    multiple: number,
    followerRate: number,
  ): boolean => {
    const lockInput = barPhaseInput(side, masterSide, multiple, followerRate);
    if (!lockInput) return false;
    const lock = barPhaseLock(lockInput);
    if (!lock || Math.abs(lock.errorSec) <= SYNC_PHASE_TOLERANCE_SEC) return false;
    const seekTo = syncFollowerSeekPositionWithLead(
      lockInput,
      syncSeekLeadSeconds(stemsRef.current[side].enabled),
      SYNC_PHASE_TOLERANCE_SEC,
    );
    if (seekTo == null) return false;
    onJogSeekRef.current(side, seekTo);
    return true;
  };

  const clearSyncConfirmation = () => {
    if (syncConfirmationTimerRef.current === null) return;
    window.clearTimeout(syncConfirmationTimerRef.current);
    syncConfirmationTimerRef.current = null;
  };

  const cancelPendingSyncCorrection = () => {
    syncInteractionRevisionRef.current += 1;
    clearSyncConfirmation();
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

  const scheduleSyncConfirmation = (
    side: 0 | 1,
    masterSide: 0 | 1,
    multiple: number,
    followerRate: number,
    remainingChecks = 2,
  ) => {
    clearSyncConfirmation();
    const interactionRevision = syncInteractionRevisionRef.current;
    const trackIds = deckTrackIdsRef.current;
    const delay = syncPhaseConfirmationDelayMs(
      stemsRef.current[side].enabled,
      stemModelRef.current?.diagnostics.p95BlockMs,
    );
    syncConfirmationTimerRef.current = window.setTimeout(() => {
      syncConfirmationTimerRef.current = null;
      const lock = syncLockRef.current;
      const currentIds = deckTrackIdsRef.current;
      const expectedMultiple = lock?.base === side
        ? lock.multiple
        : lock
          ? 1 / lock.multiple
          : null;
      if (
        expectedMultiple == null
        || Math.abs(expectedMultiple - multiple) > 1e-6
        || currentIds[0] !== trackIds[0]
        || currentIds[1] !== trackIds[1]
        || syncInteractionRevisionRef.current !== interactionRevision
        || !decksRef.current[side].playing
        || !decksRef.current[masterSide].playing
        || scratchPreviewsRef.current[0] != null
        || scratchPreviewsRef.current[1] != null
      ) {
        return;
      }
      // The first authoritative snapshot after a seek acknowledgement can still describe the
      // outgoing source. Re-check only after the decoded/STEM shadow's measured promotion window,
      // and cap retries so SYNC can never become a 100ms feedback loop again.
      const corrected = syncPhysicalDeck(side, masterSide, multiple, followerRate);
      if (corrected && remainingChecks > 1) {
        scheduleSyncConfirmation(side, masterSide, multiple, followerRate, remainingChecks - 1);
      }
    }, delay);
  };

  const toggleSyncLock = (side: 0 | 1) => {
    if (syncLock?.base === side) {
      // 再点一次只解除锁定、保持当前速度——与 DJ 台的 SYNC off 一致。
      clearSyncConfirmation();
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
    clearSyncConfirmation();
    syncLockRef.current = nextLock;
    setSyncLock(nextLock);
    const follower = decks[side];
    void applySyncRateBeforePhase(
      () => onRateChange(side, plan.rate),
      () => {
        const activeLock = syncLockRef.current;
        if (
          activeLock?.base !== nextLock.base
          || activeLock.multiple !== nextLock.multiple
          || !follower.playing
        ) return;
        if (syncPhysicalDeck(side, other, plan.multiple, plan.rate)) {
          scheduleSyncConfirmation(side, other, plan.multiple, plan.rate);
        }
      },
    ).then((applied) => {
      const activeLock = syncLockRef.current;
      if (
        applied
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
    });
  };
  const handleDeckRateChange = (side: 0 | 1, rate: number) => {
    cancelPendingSyncCorrection();
    const other = (1 - side) as 0 | 1;
    const follow = previewDeckRate(side, rate);
    const ownApplied = Promise.resolve(onRateChange(side, rate));
    if (follow != null) {
      const otherApplied = Promise.resolve(onRateChange(other, follow));
      const hardware = tempoTakeoverRef.current.hardwareUnit[other];
      if (hardware != null) showTempoHardware(other, hardware);
      return Promise.all([ownApplied, otherApplied]).then((applied) => applied.every(Boolean));
    }
    return ownApplied;
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
      const multiple = syncLock.base === side ? syncLock.multiple : 1 / syncLock.multiple;
      if (syncPhysicalDeck(
        side,
        other,
        multiple,
        started.rate,
      )) {
        scheduleSyncConfirmation(side, other, multiple, started.rate);
      }
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
  const toggleStemLayer = (side: 0 | 1) => {
    setEqStemMode((current) => {
      const next: [EqStemLayer, EqStemLayer] = [current[0], current[1]];
      next[side] = toggleEqStemLayer(current[side]);
      return next;
    });
  };
  const toggleCrossfaderEnabled = () => {
    setCrossfaderEnabled((on) => {
      if (on) setCrossfader(0);
      return !on;
    });
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
        if (crossfaderEnabled) setCrossfader(action.value);
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
          handleDeckRateChange(action.deck, incomingRate);
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

  const toggleModule = (id: ModuleId) => {
    setVisible((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return (
    <div className="kd-performance-workspace" data-embedded={embedded || undefined} data-testid="performance-workspace">
      <header className="kd-performance-toolbar">
        <strong>PERFORMANCE</strong>
        {midiPort ? <span className="kd-performance-midi" data-active title={midiPort}>MIDI</span> : null}
        <button type="button" data-active={quantize || undefined} onClick={() => setQuantize((value) => !value)}>QNT</button>
        <ToolbarWaveChannels
          displayMask={activeStemDisplayMask}
          stemMode={stemMode}
          onDisplayMask={setStemDisplayMask}
        />
        {modules.has("monitor") ? (
          <span className="kd-performance-output-strips">
            <label title="双击恢复中间"><b>CUE MIX</b><input type="range" min={-1} max={1} step={0.01} value={headMix} onChange={(event) => setHeadMix(Number(event.currentTarget.value))} onDoubleClick={() => setHeadMix(0)} /></label>
            <label title="双击恢复 100%"><b>MASTER</b><input type="range" min={0} max={1} step={0.01} value={masterVolume} onChange={(event) => onMasterVolumeChange(Number(event.currentTarget.value))} onDoubleClick={() => onMasterVolumeChange(1)} /></label>
          </span>
        ) : null}
        <span className="kd-performance-module-switches">
          {MODULES.map((module) => <button type="button" key={module.id} data-active={modules.has(module.id) || undefined} onClick={() => toggleModule(module.id)}>{module.label}</button>)}
        </span>
        {!embedded && onClose ? <button type="button" className="kd-performance-toolbar-close" onClick={onClose} aria-label="关闭 Performance">×</button> : null}
      </header>

      {modules.has("wave") ? (
        <div className="kd-performance-wave-stack">
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
              />
            );
          })}
        </div>
      ) : null}

      {modules.has("info") ? (
        <div className="kd-performance-info-grid">
          <StableDeckInfo deck={decks[0]} side={0} preserveBarPhase={autoBeatSync} onSeek={handleManualSeek} onTrackDrop={handleManualTrackDrop} />
          <StableDeckInfo deck={decks[1]} side={1} preserveBarPhase={autoBeatSync} onSeek={handleManualSeek} onTrackDrop={handleManualTrackDrop} />
        </div>
      ) : null}

      <div className="kd-performance-console">
        <DeckControls
          deck={viewDecks[0]} stemState={stems[0]} stemModel={stemModel} side={0} modules={modules} quantize={quantize}
          loopBeats={loopBeats[0]} setLoopBeats={(beats) => setLoopBeats((current) => [beats, current[1]])}
          onSeek={handleManualSeek} onTogglePlay={handleManualTogglePlay} onMainCue={handleManualMainCue}
          syncLocked={syncLock !== null}
          syncEnabled={syncEnabled}
          onToggleSync={toggleSyncLock}
          onRateChange={handleDeckRateChange}
          onPreviewRate={previewDeckRate}
          hardwareUnit={tempoHardwareUnit[0]}
          onSoftwareTempoOverride={armTempoTakeover}
          onDownloadStemModel={onDownloadStemModel}
          onToggleStem={onToggleStem}
          onSetLoop={handleManualSetLoop} onClearLoop={handleManualClearLoop}
          onSaveCuePoints={onSaveCuePoints} onSaveMainCue={onSaveMainCue}
          stemMode={stemMode}
          stemLanesVisible={performanceStemLanesVisible(activeStemDisplayMask)}
        />
        <section className="kd-performance-master">
          {modules.has("mixer") ? (
            <>
              <div className="kd-performance-mixer-cluster">
                <StemEqStrip
                  side={0}
                  gains={stems[0].gains}
                  stemMode={stemMode}
                  midiActive={eqStemMode[0] === "stems"}
                  ready={stemModel?.state === "ready" && Boolean(decks[0].track && usesLocalLibraryRecord(decks[0].track))}
                  onChange={(stem, gain) => onStemGain(0, stem, gain)}
                />
                <MixerStrip
                  side={0}
                  mixer={mixers[0]}
                  setMixer={(patch) => patchMixer(0, patch)}
                />
                <MixerStrip
                  side={1}
                  mixer={mixers[1]}
                  setMixer={(patch) => patchMixer(1, patch)}
                />
                <StemEqStrip
                  side={1}
                  gains={stems[1].gains}
                  stemMode={stemMode}
                  midiActive={eqStemMode[1] === "stems"}
                  ready={stemModel?.state === "ready" && Boolean(decks[1].track && usesLocalLibraryRecord(decks[1].track))}
                  onChange={(stem, gain) => onStemGain(1, stem, gain)}
                />
              </div>
              <div className="kd-performance-crossfader" data-off={crossfaderEnabled ? undefined : true}>
                <button
                  type="button"
                  className="kd-performance-crossfader-toggle"
                  data-active={crossfaderEnabled || undefined}
                  aria-pressed={crossfaderEnabled}
                  aria-label="交叉推子"
                  onClick={toggleCrossfaderEnabled}
                >
                  XF
                </button>
                <span data-side="a">A</span>
                <span className="kd-performance-crossfader-body">
                  <i className="kd-performance-crossfader-scale" aria-hidden="true"><u /><u /><u /><u /><u /></i>
                  <MixerFader
                    axis="horizontal"
                    value={crossfaderEnabled ? (crossfader + 1) / 2 : 0.5}
                    label="Crossfader A B"
                    disabled={!crossfaderEnabled}
                    onChange={(ratio) => setCrossfader(ratio * 2 - 1)}
                    onReset={() => setCrossfader(0)}
                  />
                  <b>{!crossfaderEnabled || crossfader === 0 ? "CENTER" : crossfader < 0 ? `A ${Math.round(-crossfader * 100)}` : `B ${Math.round(crossfader * 100)}`}</b>
                </span>
                <span data-side="b">B</span>
                <span className="kd-performance-crossfader-spacer" aria-hidden="true" />
              </div>
            </>
          ) : null}
        </section>
        <DeckControls
          deck={viewDecks[1]} stemState={stems[1]} stemModel={stemModel} side={1} modules={modules} quantize={quantize}
          loopBeats={loopBeats[1]} setLoopBeats={(beats) => setLoopBeats((current) => [current[0], beats])}
          onSeek={handleManualSeek} onTogglePlay={handleManualTogglePlay} onMainCue={handleManualMainCue}
          syncLocked={syncLock !== null}
          syncEnabled={syncEnabled}
          onToggleSync={toggleSyncLock}
          onRateChange={handleDeckRateChange}
          onPreviewRate={previewDeckRate}
          hardwareUnit={tempoHardwareUnit[1]}
          onSoftwareTempoOverride={armTempoTakeover}
          onDownloadStemModel={onDownloadStemModel}
          onToggleStem={onToggleStem}
          onSetLoop={handleManualSetLoop} onClearLoop={handleManualClearLoop}
          onSaveCuePoints={onSaveCuePoints} onSaveMainCue={onSaveMainCue}
          stemMode={stemMode}
          stemLanesVisible={performanceStemLanesVisible(activeStemDisplayMask)}
        />
      </div>
    </div>
  );
}
