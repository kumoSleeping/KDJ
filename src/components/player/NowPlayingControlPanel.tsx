import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { KeyNotation, Track } from "../../types";
import { camelotColor } from "../../lib/camelot";
import { displayTransposedTrackKey, keyTextToCamelot } from "../../lib/keyDisplay";
import {
  useManagerMixer,
  type ManagerMixerValues,
} from "../../lib/managerMixer";
import { usePlaybackPrefs, type TempoRange } from "../../lib/playbackPrefs";
import { channelFaderGain, eqBandDb } from "../../lib/performanceCues";
import { usePlayingDeck } from "./usePlayingDeck";
import { Panel } from "../common";
import { ArcKnob } from "./ManagerMixerControls";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function runtimeMixer(values: ManagerMixerValues) {
  return {
    channelGain: channelFaderGain(values.volume),
    trimDb: values.gain < 0 ? values.gain * 24 : values.gain * 6,
    lowDb: eqBandDb(values.low),
    midDb: eqBandDb(values.mid),
    highDb: eqBandDb(values.high),
    filter: values.filter,
  };
}

function HeaderTempoControl({
  rate,
  range,
  onRate,
  disabled = false,
}: {
  disabled?: boolean;
  rate: number;
  range: TempoRange;
  onRate(rate: number): void;
}) {
  const minRate = Math.max(0.5, 1 - range / 100);
  const maxRate = Math.min(2, 1 + range / 100);
  const tempoPercentage = (rate - 1) * 100;

  return (
    <div className="kd-manager-header-tempo">
      <span className="kd-manager-tempo-axis" aria-hidden="true">
        {Array.from({ length: 11 }, (_, index) => (
          <i
            key={index}
            data-center={index === 5 ? "true" : undefined}
            style={{ left: `${index * 10}%` }}
          />
        ))}
      </span>
      <input
        type="range"
        min={minRate}
        max={maxRate}
        step={0.001}
        value={clamp(rate, minRate, maxRate)}
        disabled={disabled}
        aria-label={`Tempo ${tempoPercentage >= 0 ? "+" : ""}${tempoPercentage.toFixed(1)}%`}
        onChange={(event) => onRate(Number(event.currentTarget.value))}
        onDoubleClick={() => onRate(1)}
      />
      <button
        type="button"
        aria-label="恢复原始 Tempo"
        title="点击恢复原始 Tempo"
        disabled={disabled || Math.abs(rate - 1) < 0.0005}
        onClick={() => onRate(1)}
      >
        TEMPO {tempoPercentage >= 0 ? "+" : ""}{tempoPercentage.toFixed(1)}%
      </button>
    </div>
  );
}

export function NowPlayingControlPanel({
  track,
  keyNotation,
  onError,
}: {
  track: Track;
  keyNotation: KeyNotation;
  onError(message: string): void;
}) {
  const { player, control } = usePlayingDeck(track.id);
  const mixer = useManagerMixer((state) => state.values);
  const setMixerState = useManagerMixer((state) => state.setValues);
  const [tempoState, setTempoState] = useState(() => ({ owner: track.id, value: 1 }));
  const [pitchState, setPitchState] = useState(() => ({ owner: track.id, value: 0 }));
  const tempoRange = usePlaybackPrefs((state) => state.tempoRange);
  const mixerRef = useRef(mixer);
  const pendingTempoRef = useRef<number | null>(null);
  const pendingPitchRef = useRef<number | null>(null);

  mixerRef.current = mixer;

  const side = control.side;
  const deck = control.deck;
  const tempoDraft = tempoState.owner === track.id ? tempoState.value : deck?.rate ?? 1;
  const pitchDraft = pitchState.owner === track.id ? pitchState.value : deck?.pitchSemitones ?? 0;
  const setTempoDraft = (value: number) => setTempoState({ owner: track.id, value });
  const setPitchDraft = (value: number) => setPitchState({ owner: track.id, value });

  useEffect(() => {
    if (!deck) return;
    if (pendingTempoRef.current === null) {
      setTempoDraft(deck.rate);
    } else if (Math.abs(deck.rate - pendingTempoRef.current) < 0.0005) {
      pendingTempoRef.current = null;
      setTempoDraft(deck.rate);
    }
    if (pendingPitchRef.current === null) {
      setPitchDraft(deck.pitchSemitones);
    } else if (Math.abs(deck.pitchSemitones - pendingPitchRef.current) < 0.0005) {
      pendingPitchRef.current = null;
      setPitchDraft(deck.pitchSemitones);
    }
  }, [deck?.rate, deck?.pitchSemitones, deck?.trackId]);

  // Tempo and pitch are song-owned, but the Manager mixer is one continuous session strip. The
  // playback panel is keyed by track and may remount on every song, so restore the retained mixer
  // to the active native side instead of painting or sounding a neutral frame.
  useEffect(() => {
    pendingTempoRef.current = null;
    pendingPitchRef.current = null;
    if (side === null || player.state().decks[side].trackId !== track.id) return;
    void player.setDeckMixer(side, runtimeMixer(mixerRef.current)).catch((error: unknown) => {
      onError(`控制区恢复失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [track.id, side]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (side === null || !deck || player.state().decks[side].trackId !== track.id) return;
    const bounded = clamp(
      deck.rate,
      Math.max(0.5, 1 - tempoRange / 100),
      Math.min(2, 1 + tempoRange / 100),
    );
    if (Math.abs(deck.rate - bounded) < 0.0005) return;
    pendingTempoRef.current = bounded;
    setTempoDraft(bounded);
    void player.setDeckRate(side, bounded).catch((error: unknown) => {
      pendingTempoRef.current = null;
      setTempoDraft(player.state().decks[side].rate);
      onError(`Tempo 范围应用失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [tempoRange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track/Deck publications are not atomic. Keep the surface mounted during handoff.
  const ready = side !== null && deck !== null;

  const applyMixer = (next: ManagerMixerValues) => {
    mixerRef.current = next;
    setMixerState(next);
    if (side === null || player.state().decks[side].trackId !== track.id) return;
    void player.setDeckMixer(side, runtimeMixer(next)).catch((error: unknown) => {
      onError(`播放控制失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const setMixer = (patch: Partial<ManagerMixerValues>) => {
    applyMixer({ ...mixerRef.current, ...patch });
  };

  const setRate = (rate: number) => {
    const bounded = clamp(rate, 0.5, 2);
    pendingTempoRef.current = bounded;
    setTempoDraft(bounded);
    if (side === null || player.state().decks[side].trackId !== track.id) return;
    void player.setDeckRate(side, bounded).catch((error: unknown) => {
      pendingTempoRef.current = null;
      setTempoDraft(player.state().decks[side].rate);
      onError(`Tempo 调整失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const setPitch = (semitones: number) => {
    const bounded = Math.round(clamp(semitones, -12, 12));
    pendingPitchRef.current = bounded;
    setPitchDraft(bounded);
    if (side === null || player.state().decks[side].trackId !== track.id) return;
    void player.setDeckPitch(side, bounded).catch((error: unknown) => {
      pendingPitchRef.current = null;
      setPitchDraft(player.state().decks[side].pitchSemitones);
      onError(`Key 调整失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const currentKey = displayTransposedTrackKey(track, keyNotation, pitchDraft);
  const currentCamelot = keyTextToCamelot(currentKey);
  const baseBpm = track.bpm && Number.isFinite(track.bpm) ? track.bpm : null;
  const effectiveBpm = baseBpm ? baseBpm * tempoDraft : null;

  return (
    <Panel
      heading="EQ / 播放控制"
      className="kd-playing-control-panel"
      padded={false}
      dense
    >
      <div className="kd-manager-control" data-side={side === null ? undefined : side === 0 ? "a" : "b"} aria-busy={!ready}>
        <div className="kd-manager-control-head">
          <div className="kd-manager-control-readout" data-kind="key">
            <span className="kd-manager-key-nudge" aria-label="音调半音调整">
              <button
                type="button"
                aria-label="升高一个半音"
                disabled={!ready || pitchDraft >= 12}
                onClick={() => setPitch(pitchDraft + 1)}
              >+</button>
              <button
                type="button"
                aria-label="降低一个半音"
                disabled={!ready || pitchDraft <= -12}
                onClick={() => setPitch(pitchDraft - 1)}
              >−</button>
            </span>
            <span className="kd-manager-control-label">
              <span>KEY</span>
              <small>{pitchDraft === 0 ? "ORG" : `${pitchDraft > 0 ? "+" : ""}${pitchDraft} st`}</small>
            </span>
            <strong
              style={currentCamelot
                ? ({ "--kd-key-color": camelotColor(currentCamelot) } as CSSProperties)
                : undefined}
            >{currentKey || "—"}</strong>
          </div>
          <div className="kd-manager-control-readout" data-kind="bpm">
            <span className="kd-manager-control-label">
              <span>BPM</span>
            </span>
            <strong>{effectiveBpm ? effectiveBpm.toFixed(1) : "—"}</strong>
          </div>
          <HeaderTempoControl rate={tempoDraft} range={tempoRange} onRate={setRate} disabled={!ready} />
        </div>

        <div className="kd-manager-mixer-layout">
          <div className="kd-manager-knob-stack">
            <ArcKnob size="xs" label="GAIN" value={mixer.gain} onChange={(gain) => setMixer({ gain })} onReset={() => setMixer({ gain: 0 })} />
            <ArcKnob size="xs" label="FILTER" value={mixer.filter} onChange={(filter) => setMixer({ filter })} onReset={() => setMixer({ filter: 0 })} />
            <ArcKnob size="xs" label="LOW" value={mixer.low} onChange={(low) => setMixer({ low })} onReset={() => setMixer({ low: 0 })} />
            <ArcKnob size="xs" label="MID" value={mixer.mid} onChange={(mid) => setMixer({ mid })} onReset={() => setMixer({ mid: 0 })} />
            <ArcKnob size="xs" label="HIGH" value={mixer.high} onChange={(high) => setMixer({ high })} onReset={() => setMixer({ high: 0 })} />
          </div>
        </div>
      </div>
    </Panel>
  );
}
