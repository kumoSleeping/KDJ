import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
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
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useAppStore } from "../../stores/appStore";
import { streamAnalysisSnapshot, subscribeStreamAnalysis, trackWithStreamAnalysis } from "../../lib/streamAnalysis";
import { ArcKnob } from "./ManagerMixerControls";
import { usePlayerBarFace, usePlayerBarReadouts } from "../../lib/playerBarFace";
import "./PlayerEq.css";

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

/** Tempo as a short slider beside the BPM it changes; the offset is the reset control. */
function TempoControl({
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
  const percent = (rate - 1) * 100;
  const moved = Math.abs(rate - 1) >= 0.0005;
  const offset = `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
  return (
    <div className="kd-eq-tempo">
      <input
        type="range"
        min={minRate}
        max={maxRate}
        step={0.001}
        value={clamp(rate, minRate, maxRate)}
        disabled={disabled}
        aria-label={`Tempo ${offset}`}
        title={`Tempo ${offset}`}
        style={{ "--kd-eq-tempo-at": `${((clamp(rate, minRate, maxRate) - minRate) / (maxRate - minRate)) * 100}%` } as CSSProperties}
        onChange={(event) => onRate(Number(event.currentTarget.value))}
        onDoubleClick={() => onRate(1)}
      />
      <button
        type="button"
        className="kd-eq-tempo-offset"
        aria-label="恢复原始 Tempo"
        title="恢复原始 Tempo"
        data-moved={moved || undefined}
        disabled={disabled || !moved}
        onClick={() => onRate(1)}
      >{offset}</button>
    </div>
  );
}

/** How long after its acknowledgement a command may take to show up in the player's reports. */
const CONTROL_SETTLE_MS = 400;

/**
 * A deck value while the user is setting it.
 *
 * The player's reports lag the commands, so during a drag they carry older values. Matching
 * them against the value last sent let one of those take over whenever the drag passed the same
 * value twice, and the thumb then followed the stale reports. The user's value is shown from the
 * first command until the latest one has been acknowledged and reported; outside that window the
 * player's own value is shown, with no copy of it kept here.
 */
function useCommandedValue(owner: number, reported: number): [number, (value: number, send: (() => Promise<unknown>) | null) => Promise<void>] {
  const [draft, setDraft] = useState<{ owner: number; value: number } | null>(null);
  const request = useRef(0);
  const timer = useRef<number | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => () => { request.current += 1; clearTimer(); }, [owner]);
  const commit = (value: number, send: (() => Promise<unknown>) | null) => {
    const id = ++request.current;
    clearTimer();
    setDraft({ owner, value });
    const release = (delay: number) => {
      if (request.current !== id) return;
      timer.current = window.setTimeout(() => {
        if (request.current === id) setDraft(null);
      }, delay);
    };
    // Nothing to send (the deck is between songs): keep the value until the deck reports again.
    if (!send) return Promise.resolve();
    return send().then(
      () => release(CONTROL_SETTLE_MS),
      (error: unknown) => { release(0); throw error; },
    );
  };
  return [draft && draft.owner === owner ? draft.value : reported, commit];
}

function NowPlayingControls({
  track,
  keyNotation,
  onError,
  readoutsTo,
}: {
  track: Track;
  keyNotation: KeyNotation;
  onError(message: string): void;
  /** Where the readouts go instead of ending the knobs' row (a tall window's title row). */
  readoutsTo: HTMLElement | null;
}) {
  const subscribeAnalysis = useCallback((listener: () => void) => subscribeStreamAnalysis(track.id, listener), [track.id]);
  const readAnalysis = useCallback(() => streamAnalysisSnapshot(track.id), [track.id]);
  const analysis = useSyncExternalStore(subscribeAnalysis, readAnalysis, readAnalysis);
  const analyzedTrack = trackWithStreamAnalysis(track, analysis);
  const { player, control } = usePlayingDeck(track.id);
  const mixer = useManagerMixer((state) => state.values);
  const setMixerState = useManagerMixer((state) => state.setValues);
  const tempoRange = usePlaybackPrefs((state) => state.tempoRange);
  const mixerRef = useRef(mixer);

  mixerRef.current = mixer;

  const side = control.side;
  const deck = control.deck;
  const [tempoDraft, commitTempo] = useCommandedValue(track.id, deck?.rate ?? 1);
  const [pitchDraft, commitPitch] = useCommandedValue(track.id, deck?.pitchSemitones ?? 0);
  const loadedSide = () => side !== null && player.state().decks[side].trackId === track.id ? side : null;

  // Tempo and pitch are song-owned, but the Manager mixer is one continuous session strip.
  // Restore the retained mixer to the active native side on every song instead of painting
  // or sounding a neutral frame.
  useEffect(() => {
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
    void commitTempo(bounded, () => player.setDeckRate(side, bounded)).catch((error: unknown) => {
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
    const target = loadedSide();
    void commitTempo(bounded, target === null ? null : () => player.setDeckRate(target, bounded)).catch((error: unknown) => {
      onError(`Tempo 调整失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const setPitch = (semitones: number) => {
    const bounded = Math.round(clamp(semitones, -12, 12));
    const target = loadedSide();
    void commitPitch(bounded, target === null ? null : () => player.setDeckPitch(target, bounded)).catch((error: unknown) => {
      onError(`Key 调整失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const currentKey = displayTransposedTrackKey(analyzedTrack, keyNotation, pitchDraft);
  const currentCamelot = keyTextToCamelot(currentKey);
  const baseBpm = analyzedTrack.bpm && Number.isFinite(analyzedTrack.bpm) ? analyzedTrack.bpm : null;
  const confidence = analyzedTrack.bpm_confidence;
  const analysisWarning = analyzedTrack.analysis_error || analysis.error || analysis.result?.errors.join("；") || "";
  const effectiveBpm = baseBpm ? baseBpm * tempoDraft : null;
  const readouts = (node: ReactNode) => readoutsTo ? createPortal(node, readoutsTo) : node;

  return (
    <div className="kd-manager-control" data-side={side === null ? undefined : side === 0 ? "a" : "b"} aria-busy={!ready}>
      {/* Controls first, readouts after on the same row; a tall window draws the readouts in the
          title row instead (readoutsTo, PlayerBar's BarNowKeys). */}
      <div className="kd-manager-knob-stack">
        <ArcKnob size="xs" label="GAIN" value={mixer.gain} onChange={(gain) => setMixer({ gain })} onReset={() => setMixer({ gain: 0 })}
          format={value => { const db = value < 0 ? value * 24 : value * 6; return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`; }} />
        <ArcKnob size="xs" label="FILTER" value={mixer.filter} onChange={(filter) => setMixer({ filter })} onReset={() => setMixer({ filter: 0 })} />
        <ArcKnob size="xs" label="LOW" value={mixer.low} onChange={(low) => setMixer({ low })} onReset={() => setMixer({ low: 0 })} />
        <ArcKnob size="xs" label="MID" value={mixer.mid} onChange={(mid) => setMixer({ mid })} onReset={() => setMixer({ mid: 0 })} />
        <ArcKnob size="xs" label="HIGH" value={mixer.high} onChange={(high) => setMixer({ high })} onReset={() => setMixer({ high: 0 })} />
        {/* Tempo ends the knobs' row, so the readouts' row is the two readouts alone. */}
        <TempoControl rate={tempoDraft} range={tempoRange} onRate={setRate} disabled={!ready} />
      </div>

      {readouts(<div className="kd-eq-readouts">
        {/* The readout with its two steps as a small vertical pair on its right: raise above,
            lower below (placed by PlayerEq.css; the order here is the keyboard's). */}
        <div className="kd-eq-key" role="group" aria-label="音调">
          <button type="button" className="kd-eq-step" data-step="down" aria-label="降低一个半音" title="降低一个半音"
            disabled={!ready || pitchDraft <= -12} onClick={() => setPitch(pitchDraft - 1)}>
            <ChevronDown size={12} strokeWidth={2.6} aria-hidden="true" />
          </button>
          <span className="kd-eq-value" title={pitchDraft === 0 ? undefined : `${pitchDraft > 0 ? "+" : ""}${pitchDraft} 个半音`}>
            <small>KEY{pitchDraft === 0 ? null : <i>{pitchDraft > 0 ? "+" : ""}{pitchDraft}</i>}</small>
            <strong
              style={currentCamelot
                ? ({ "--kd-key-color": camelotColor(currentCamelot) } as CSSProperties)
                : undefined}
            >{currentKey || "—"}</strong>
          </span>
          <button type="button" className="kd-eq-step" data-step="up" aria-label="升高一个半音" title="升高一个半音"
            disabled={!ready || pitchDraft >= 12} onClick={() => setPitch(pitchDraft + 1)}>
            <ChevronUp size={12} strokeWidth={2.6} aria-hidden="true" />
          </button>
        </div>
        <span className="kd-eq-value" data-kind="bpm" data-warn={analysisWarning ? "true" : undefined}
          title={analysisWarning || (confidence != null ? `节拍置信度 ${Math.round(confidence * 100)}%` : undefined)}>
          <small>BPM</small>
          <strong>{effectiveBpm ? effectiveBpm.toFixed(1) : "—"}</strong>
        </span>
      </div>)}
    </div>
  );
}

/** The loaded deck's pitch, tempo and channel strip, docked in the player bar. */
export function PlayerEq({ onError }: { onError(message: string): void }) {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const keyNotation = useAppStore(state => state.settings?.key_notation ?? "camelot");
  // The face that is not shown is still mounted; only the face on screen sends its readouts up.
  const face = usePlayerBarFace(state => state.face);
  const slot = usePlayerBarReadouts(state => state.slot);
  const readoutsTo = face === "eq" ? slot : null;
  return <div className="kd-player-eq" role="group" aria-label="EQ / 播放控制">
    {track && <NowPlayingControls track={track} keyNotation={keyNotation} onError={onError} readoutsTo={readoutsTo} />}
  </div>;
}
