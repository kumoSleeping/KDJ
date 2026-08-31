import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AudioWaveform, LoaderCircle, PanelTopClose } from "lucide-react";
import type { FilterResonance, KeyNotation, Track } from "../../types";
import {
  channelFilterResonanceQ,
  type EqGraphValues,
} from "../../lib/eqGraph";
import { camelotColor } from "../../lib/camelot";
import { displayTransposedTrackKey, keyTextToCamelot } from "../../lib/keyDisplay";
import {
  managerControlView,
  reconcileManagerControlView,
  sameManagerControlView,
} from "../../lib/managerControlView";
import { usePlaybackPrefs, type TempoRange } from "../../lib/playbackPrefs";
import { channelFaderGain, eqBandDb } from "../../lib/performanceCues";
import { runtimePlayer, type UnifiedPlayerState } from "../../lib/unifiedPlayer";
import { performanceWaveformAmplitudeScale } from "../../lib/waveformRenderPolicy";
import { Panel } from "../common";
import {
  ArcKnob,
  EqSpectrumChart,
  type ManagerMixerValues,
} from "./ManagerMixerControls";
import { ManagerWaveform } from "./ManagerWaveform";

const DEFAULT_MIXER: ManagerMixerValues = {
  gain: 0,
  high: 0,
  mid: 0,
  low: 0,
  filter: 0,
  volume: 1,
};

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
}: {
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
        aria-label={`Tempo ${tempoPercentage >= 0 ? "+" : ""}${tempoPercentage.toFixed(1)}%`}
        onChange={(event) => onRate(Number(event.currentTarget.value))}
        onDoubleClick={() => onRate(1)}
      />
      <button
        type="button"
        aria-label="恢复原始 Tempo"
        title="点击恢复原始 Tempo"
        disabled={Math.abs(rate - 1) < 0.0005}
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
  filterResonance,
  onError,
}: {
  track: Track;
  keyNotation: KeyNotation;
  filterResonance: FilterResonance;
  onError(message: string): void;
}) {
  const player = useMemo(() => runtimePlayer(), []);
  const [controlState, setControlState] = useState(() =>
    managerControlView(player.state(), track.id),
  );
  const [mixer, setMixerState] = useState<ManagerMixerValues>({ ...DEFAULT_MIXER });
  const [tempoState, setTempoState] = useState(() => ({ owner: track.id, value: 1 }));
  const [pitchState, setPitchState] = useState(() => ({ owner: track.id, value: 0 }));
  const tempoRange = usePlaybackPrefs((state) => state.tempoRange);
  const detailWaveformVisible = usePlaybackPrefs((state) => state.detailWaveformVisible);
  const setDetailWaveformVisible = usePlaybackPrefs((state) => state.setDetailWaveformVisible);
  const setDetailControlVisible = usePlaybackPrefs((state) => state.setDetailControlVisible);
  const [detailWaveformLoad, setDetailWaveformLoad] = useState({
    owner: track.id,
    loading: detailWaveformVisible,
  });
  const mixerRef = useRef(mixer);
  const pendingTempoRef = useRef<number | null>(null);
  const pendingPitchRef = useRef<number | null>(null);

  mixerRef.current = mixer;

  const detailWaveformLoading = detailWaveformVisible && (
    detailWaveformLoad.owner !== track.id || detailWaveformLoad.loading
  );
  const handleDetailWaveformLoading = useCallback((loading: boolean) => {
    setDetailWaveformLoad((current) =>
      current.owner === track.id && current.loading === loading
        ? current
        : { owner: track.id, loading },
    );
  }, [track.id]);
  const toggleDetailWaveform = () => {
    const nextVisible = !detailWaveformVisible;
    if (nextVisible) {
      setDetailWaveformLoad({ owner: track.id, loading: true });
    }
    setDetailWaveformVisible(nextVisible);
  };

  useEffect(() => {
    const sync = (next: UnifiedPlayerState) => {
      setControlState((current) => {
        const selected = reconcileManagerControlView(current, next, track.id);
        return sameManagerControlView(current, selected) ? current : selected;
      });
    };
    sync(player.state());
    return player.subscribe(sync);
  }, [player, track.id]);

  // A detail component can survive a route-level song swap. Never paint the previous song's
  // control state for the one render before the subscription effect synchronizes the new owner.
  const control = controlState.owner === track.id
    ? controlState
    : managerControlView(player.state(), track.id);
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

  // Manager loads are intentionally song-scoped: every new song starts from neutral controls.
  useEffect(() => {
    const neutral = { ...DEFAULT_MIXER };
    mixerRef.current = neutral;
    pendingTempoRef.current = null;
    pendingPitchRef.current = null;
    setMixerState(neutral);
    if (side === null || player.state().decks[side].trackId !== track.id) return;
    void player.setDeckMixer(side, runtimeMixer(DEFAULT_MIXER)).catch((error: unknown) => {
      onError(`控制区复位失败：${error instanceof Error ? error.message : String(error)}`);
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

  if (side === null || !deck) return null;

  const applyMixer = (next: ManagerMixerValues) => {
    mixerRef.current = next;
    setMixerState(next);
    if (player.state().decks[side].trackId !== track.id) return;
    void player.setDeckMixer(side, runtimeMixer(next)).catch((error: unknown) => {
      onError(`播放控制失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const setMixer = (patch: Partial<ManagerMixerValues>) => {
    applyMixer({ ...mixerRef.current, ...patch });
  };

  const adjustEq = (delta: EqGraphValues) => {
    const current = mixerRef.current;
    applyMixer({
      ...current,
      low: clamp(current.low + delta.low, -1, 1),
      mid: clamp(current.mid + delta.mid, -1, 1),
      high: clamp(current.high + delta.high, -1, 1),
    });
  };

  const setRate = (rate: number) => {
    const bounded = clamp(rate, 0.5, 2);
    pendingTempoRef.current = bounded;
    setTempoDraft(bounded);
    if (player.state().decks[side].trackId !== track.id) return;
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
    if (player.state().decks[side].trackId !== track.id) return;
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
  const tempoPercentage = (tempoDraft - 1) * 100;
  const duration = deck.duration || track.duration || 0;

  return (
    <Panel
      heading="Control"
      padded={false}
      dense
      actions={
        <>
          <button
            type="button"
            className="kd-manager-panel-action"
            aria-pressed={detailWaveformVisible}
            aria-busy={detailWaveformLoading || undefined}
            aria-label={detailWaveformLoading
              ? "波形加载中，点击关闭"
              : detailWaveformVisible ? "隐藏细节波形" : "显示细节波形"}
            title={detailWaveformLoading
              ? "波形加载中，点击关闭"
              : detailWaveformVisible ? "隐藏细节波形" : "显示细节波形"}
            onClick={toggleDetailWaveform}
          >
            {detailWaveformLoading ? (
              <LoaderCircle className="kd-spin" size={13} strokeWidth={2.25} aria-hidden="true" />
            ) : (
              <AudioWaveform size={13} strokeWidth={2.25} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="kd-manager-panel-action"
            aria-label="收起 Control 面板"
            title="收起 Control 面板"
            onClick={() => setDetailControlVisible(false)}
          >
            <PanelTopClose size={13} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </>
      }
    >
      <div className="kd-manager-control" data-side={side === 0 ? "a" : "b"}>
        <div className="kd-manager-control-head">
          <div className="kd-manager-control-readout" data-kind="key">
            <span className="kd-manager-key-nudge" aria-label="音调半音调整">
              <button
                type="button"
                aria-label="升高一个半音"
                disabled={pitchDraft >= 12}
                onClick={() => setPitch(pitchDraft + 1)}
              >+</button>
              <button
                type="button"
                aria-label="降低一个半音"
                disabled={pitchDraft <= -12}
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
              <small>{tempoPercentage >= 0 ? "+" : ""}{tempoPercentage.toFixed(1)}%</small>
            </span>
            <strong>{effectiveBpm ? effectiveBpm.toFixed(1) : "—"}</strong>
          </div>
          <HeaderTempoControl rate={tempoDraft} range={tempoRange} onRate={setRate} />
        </div>

        <div className="kd-manager-mixer-layout">
          <div className="kd-manager-visual-stack">
            {detailWaveformVisible ? (
              <ManagerWaveform
                track={track}
                deck={side}
                duration={duration}
                amplitudeScale={performanceWaveformAmplitudeScale(mixer.gain)}
                playing={deck.playing || deck.desiredPlaying}
                onLoadingChange={handleDetailWaveformLoading}
              />
            ) : null}
            <div className="kd-manager-mixer-eq">
              <EqSpectrumChart
                side={side}
                values={mixer}
                filter={mixer.filter}
                resonanceQ={channelFilterResonanceQ(filterResonance)}
                playing={deck.playing}
                onAdjust={adjustEq}
                onReset={() => setMixer({ low: 0, mid: 0, high: 0 })}
              />
            </div>
          </div>
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
