import {
  ArrowLeft,
  CircleStop,
  FlaskConical,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import {
  StemDebugAudio,
  type StemDebugAuditionMode,
  type StemDebugGains,
} from "../../lib/stemDebugAudio";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import type {
  StemDebugLane,
  StemDebugModelCatalog,
  StemDebugModelId,
  StemDebugRender,
  StemDebugWaveforms,
  Track,
} from "../../types";
import { Button, InlineNotice } from "../common";

type StemDebugDb = Record<string, number>;

function dbToGain(db: number): number {
  return db <= -59.9 ? 0 : 10 ** (db / 20);
}

function gainsFromDb(values: StemDebugDb): StemDebugGains {
  return Object.fromEntries(Object.entries(values).map(([lane, db]) => [lane, dbToGain(db)]));
}

function statusText(error: number): string {
  if (error === 0) return "−∞ dBFS";
  if (!Number.isFinite(error) || error < 0) return "—";
  return `${(20 * Math.log10(Math.max(error, 1e-15))).toFixed(1)} dBFS`;
}

function trackLabel(track: Track): string {
  const title = track.title || track.filename;
  return track.artist ? `${title} — ${track.artist}` : title;
}

export function StemDebugWorkspace({ onClose }: { onClose(): void }) {
  const tracks = useLibraryStore((state) => state.tracks);
  const selected = useLibraryStore(selectSelectedTrack);
  const [trackId, setTrackId] = useState<number | null>(() => selected?.id ?? null);
  const [catalog, setCatalog] = useState<StemDebugModelCatalog | null>(null);
  const [modelId, setModelId] = useState<StemDebugModelId>("scnet-tran");
  const [result, setResult] = useState<StemDebugRender | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<StemDebugAuditionMode>("sum");
  const [stemDb, setStemDb] = useState<StemDebugDb>({});
  const [fullSong, setFullSong] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const audioRef = useRef<StemDebugAudio | null>(null);
  const sessionRef = useRef<string | null>(null);

  const choices = useMemo(() => {
    const map = new Map<number, Track>();
    if (selected) map.set(selected.id, selected);
    for (const track of tracks) map.set(track.id, track);
    return [...map.values()];
  }, [selected, tracks]);
  const chosen = choices.find((track) => track.id === trackId) ?? selected ?? null;
  const model = catalog?.models.find((candidate) => candidate.id === modelId) ?? null;
  const visibleLanes = result?.lanes ?? model?.lanes ?? [];

  useEffect(() => {
    if (trackId === null && selected) setTrackId(selected.id);
  }, [selected, trackId]);

  useEffect(() => {
    let active = true;
    void api.stemDebugModelCatalog().then((status) => {
      if (!active) return;
      setCatalog(status);
      if (!status.models.some((candidate) => candidate.id === "scnet-tran" && candidate.ready)) {
        const ready = status.models.find((candidate) => candidate.ready);
        if (ready) setModelId(ready.id);
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.setMode(mode);
    audio.setGains(gainsFromDb(stemDb));
  }, [mode, stemDb]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio) setPosition(audio.position());
    }, 33);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    void audioRef.current?.dispose();
    audioRef.current = null;
    if (session) void api.releaseStemDebug(session);
  }, []);

  const releaseCurrent = useCallback(async () => {
    setPlaying(false);
    setPosition(0);
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) await audio.dispose();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) await api.releaseStemDebug(session).catch(() => undefined);
  }, []);

  const render = useCallback(async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    await releaseCurrent();
    try {
      const next = await api.renderStemDebug(chosen.id, modelId, fullSong ? 0 : 30);
      sessionRef.current = next.sessionId;
      const unity = Object.fromEntries(next.lanes.map((lane) => [lane.id, 0]));
      setStemDb(unity);
      setLoadingAudio(true);
      const audio = new StemDebugAudio(() => {
        setPlaying(false);
        setPosition(next.duration);
      });
      audio.setMode(mode);
      audio.setGains(gainsFromDb(unity));
      await audio.load(next.audio);
      audio.setMode(mode);
      audio.setGains(gainsFromDb(unity));
      audioRef.current = audio;
      setResult(next);
      setPosition(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void api.releaseStemDebug(session);
    } finally {
      setLoadingAudio(false);
      setBusy(false);
    }
  }, [busy, chosen, fullSong, mode, modelId, releaseCurrent]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.isPlaying) {
      audio.pause();
      setPosition(audio.position());
      setPlaying(false);
      return;
    }
    try {
      await audio.play(position);
      setPlaying(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [position]);

  const seek = useCallback(async (seconds: number) => {
    const audio = audioRef.current;
    setPosition(seconds);
    if (!audio) return;
    try {
      await audio.seek(seconds);
      setPlaying(audio.isPlaying);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const close = useCallback(() => {
    void releaseCurrent().finally(onClose);
  }, [onClose, releaseCurrent]);

  const processing = busy || loadingAudio;
  const reconstructionPass = Boolean(result && result.reconstructionPeakError <= 1e-6);

  return (
    <section className="kd-stem-debug">
      <header className="kd-stem-debug-head">
        <button type="button" aria-label="返回 KDJ" title="返回 KDJ" onClick={close}>
          <ArrowLeft size={17} />
        </button>
        <FlaskConical size={15} aria-hidden="true" />
        <strong>STEM DEBUG</strong>
        <span>{model?.ready ? `${model.name} · ${model.sha256.slice(0, 8)}` : model?.error ?? ""}</span>
      </header>

      <div className="kd-stem-debug-body">
        <div className="kd-stem-debug-source">
          <select
            aria-label="分离模型"
            value={modelId}
            disabled={processing}
            onChange={(event) => {
              const next = event.currentTarget.value as StemDebugModelId;
              void releaseCurrent().then(() => {
                setResult(null);
                setStemDb({});
                setModelId(next);
              });
            }}
          >
            {catalog?.models.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={!candidate.ready}>
                {candidate.name} · {candidate.lanes.length} TRACK
              </option>
            ))}
          </select>
          <select
            aria-label="调试歌曲"
            value={trackId ?? ""}
            disabled={processing}
            onChange={(event) => setTrackId(Number(event.currentTarget.value) || null)}
          >
            {choices.map((track) => <option key={track.id} value={track.id}>{trackLabel(track)}</option>)}
          </select>
          <Button
            variant="primary"
            disabled={!chosen || !model?.ready || processing}
            onClick={() => void render()}
          >
            {processing ? <LoaderCircle className="kd-spin" size={14} /> : <FlaskConical size={14} />}
            {busy ? "分离中" : loadingAudio ? "载入中" : "生成"}
          </Button>
          {model ? (
            <span className="kd-stem-debug-model-meta">
              <b>{model.lanes.map((lane) => lane.label).join(" / ")}</b>
              <i>{model.license}</i>
            </span>
          ) : null}
          <div className="kd-stem-debug-length" role="group" aria-label="调试长度">
            <button
              type="button"
              disabled={processing}
              data-active={!fullSong ? "true" : undefined}
              onClick={() => setFullSong(false)}
            >30 SEC</button>
            <button
              type="button"
              disabled={processing}
              data-active={fullSong ? "true" : undefined}
              onClick={() => setFullSong(true)}
            >FULL</button>
          </div>
          {result ? (
            <span className="kd-stem-debug-track">
              <b>{result.title}</b>
              <i>{result.artist}</i>
            </span>
          ) : null}
        </div>

        <InlineNotice text={error || model?.error || ""} block />

        <div className="kd-stem-debug-wave-shell" data-ready={result ? "true" : undefined}>
          {result ? (
            <StemDebugWaveCanvas
              waveforms={result.waveforms}
              lanes={result.lanes}
              position={position}
              duration={result.duration}
              onSeek={(next) => void seek(next)}
            />
          ) : null}
        </div>

        <div className="kd-stem-debug-console">
          <div className="kd-stem-debug-transport">
            <button
              type="button"
              className="kd-stem-debug-play"
              disabled={!result}
              aria-label={playing ? "暂停" : "播放"}
              onClick={() => void togglePlay()}
            >
              {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
            </button>
            <button
              type="button"
              disabled={!result}
              aria-label="停止"
              onClick={() => {
                audioRef.current?.pause();
                setPlaying(false);
                void seek(0);
              }}
            >
              <CircleStop size={16} />
            </button>
            <time>{formatDuration(position)} / {formatDuration(result?.duration ?? 0)}</time>
            <div className="kd-stem-debug-ab" role="group" aria-label="试听信号">
              {([
                ["original", "ORG"],
                ["sum", "Σ"],
                ["mix", "MIX"],
              ] as const).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  disabled={!result}
                  data-active={mode === id ? "true" : undefined}
                  aria-pressed={mode === id}
                  onClick={() => setMode(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div
            className="kd-stem-debug-knobs"
            aria-label="Stem 音量"
            style={{ "--kd-debug-lanes": Math.max(2, visibleLanes.length) } as CSSProperties}
          >
            {visibleLanes.map(({ id, label }) => (
              <StemDebugKnob
                key={id}
                stem={id}
                label={label}
                value={stemDb[id] ?? 0}
                disabled={!result}
                onChange={(value) => {
                  setMode("mix");
                  setStemDb((current) => ({ ...current, [id]: value }));
                }}
              />
            ))}
            <button
              type="button"
              className="kd-stem-debug-reset"
              disabled={!result}
              title="全部轨道归零"
              aria-label="全部轨道归零"
              onClick={() => setStemDb(Object.fromEntries(visibleLanes.map((lane) => [lane.id, 0])))}
            >
              <RotateCcw size={14} />
            </button>
          </div>

          <dl className="kd-stem-debug-metrics">
            <div><dt>ANALYSIS</dt><dd>{result ? `${(result.analysisTotalMs / 1000).toFixed(2)} s` : "—"}</dd></div>
            <div><dt>AUDIO</dt><dd>{result ? `${result.duration.toFixed(2)} s` : "—"}</dd></div>
            <div><dt>REALTIME</dt><dd>{result ? `${result.realtimeFactor.toFixed(3)}×` : "—"}</dd></div>
            <div data-pass={result ? String(reconstructionPass) : undefined}>
              <dt>RECON</dt>
              <dd>{result ? (reconstructionPass ? "FLOAT MATCH" : "MISMATCH") : "—"}</dd>
            </div>
            <div><dt>RMS ERROR</dt><dd>{result ? statusText(result.reconstructionRmsError) : "—"}</dd></div>
            <div><dt>PEAK ERROR</dt><dd>{result ? statusText(result.reconstructionPeakError) : "—"}</dd></div>
            <div><dt>ORT TOTAL</dt><dd>{result ? `${(result.inferenceTotalMs / 1000).toFixed(2)} s` : "—"}</dd></div>
            <div><dt>ORT P95</dt><dd>{result ? `${result.inferenceP95Ms.toFixed(2)} ms` : "—"}</dd></div>
            <div><dt>CHUNKS</dt><dd>{result?.inferenceChunks ?? "—"}</dd></div>
          </dl>
        </div>
      </div>
    </section>
  );
}

function StemDebugKnob({
  stem,
  label,
  value,
  disabled,
  onChange,
}: {
  stem: string;
  label: string;
  value: number;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    position: number;
  } | null>(null);
  const position = value <= 0 ? value / 60 : value / 6;
  const angle = Math.min(1, Math.max(-1, position)) * 135;
  const update = (next: number) => onChange(Math.round(Math.min(6, Math.max(-60, next)) * 2) / 2);
  const finish = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.removeAttribute("data-dragging");
  };
  return (
    <div className="kd-stem-debug-knob-wrap" data-stem={stem}>
      <label
        className="kd-performance-knob kd-stem-debug-knob"
        title={`${label} ${value.toFixed(1)} dB`}
        onDoubleClick={() => !disabled && update(0)}
      >
        <span style={{ "--kd-knob-angle": `${angle}deg` } as CSSProperties}>
          <i />
        </span>
        <input
          type="range"
          min={-60}
          max={6}
          step={0.5}
          value={value}
          disabled={disabled}
          aria-label={`${label} 音量`}
          onChange={(event) => update(Number(event.currentTarget.value))}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            event.preventDefault();
            drag.current = {
              pointer: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              position,
            };
            event.currentTarget.dataset.dragging = "true";
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointer !== event.pointerId) return;
            const travel = (event.clientX - current.x) - (event.clientY - current.y);
            const nextPosition = Math.min(1, Math.max(-1, current.position + travel / 90));
            update(nextPosition <= 0 ? nextPosition * 60 : nextPosition * 6);
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
        <b>{label}</b>
        <em>{value <= -59.9 ? "−∞" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`} dB</em>
      </label>
    </div>
  );
}

function StemDebugWaveCanvas({
  waveforms,
  lanes,
  position,
  duration,
  onSeek,
}: {
  waveforms: StemDebugWaveforms;
  lanes: StemDebugLane[];
  position: number;
  duration: number;
  onSeek(seconds: number): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  const reference = useMemo(() => {
    const sorted = waveforms.original.filter(Number.isFinite).sort((a, b) => a - b);
    return Math.max(1e-6, sorted[Math.floor(sorted.length * 0.99)] ?? 1);
  }, [waveforms]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawStemDebugWave(canvas, waveforms, lanes, positionRef.current, duration, reference);
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [duration, lanes, reference, waveforms]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawStemDebugWave(canvas, waveforms, lanes, position, duration, reference);
  }, [duration, lanes, position, reference, waveforms]);

  return (
    <canvas
      ref={canvasRef}
      className="kd-stem-debug-wave"
      aria-label="原曲、模型输出轨道与 Unity 和波形"
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - 42) / Math.max(1, rect.width - 48)));
        onSeek(ratio * duration);
      }}
    />
  );
}

function drawStemDebugWave(
  canvas: HTMLCanvasElement,
  waves: StemDebugWaveforms,
  modelLanes: StemDebugLane[],
  position: number,
  duration: number,
  reference: number,
) {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const cssWidth = width / scale;
  const cssHeight = height / scale;
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#0c0f13";
  context.fillRect(0, 0, cssWidth, cssHeight);

  const lanes: Array<{ label: string; values: number[]; color: string }> = [
    { label: "ORG / Σ", values: waves.original, color: "#b7bec9" },
    ...modelLanes.map((lane) => ({
      label: lane.label,
      values: waves.lanes[lane.id] ?? [],
      color: stemLaneColor(lane.id),
    })),
  ];
  const left = 42;
  const right = cssWidth - 6;
  const laneHeight = cssHeight / lanes.length;
  context.font = "700 8px ui-monospace, monospace";
  context.textAlign = "right";
  context.textBaseline = "middle";
  lanes.forEach((lane, index) => {
    const top = index * laneHeight;
    const middle = top + laneHeight / 2;
    context.strokeStyle = "rgba(255,255,255,.08)";
    context.beginPath();
    context.moveTo(left, top + laneHeight);
    context.lineTo(right, top + laneHeight);
    context.stroke();
    context.fillStyle = lane.color;
    context.fillText(lane.label, left - 5, middle);
    drawPeakLane(context, lane.values, left, right, middle, laneHeight * 0.42, reference, lane.color, 0.64);
    if (index === 0) {
      drawPeakLane(context, waves.sum, left, right, middle, laneHeight * 0.42, reference, "#ff5d67", 0.42, true);
    }
  });
  const playhead = left + Math.min(1, Math.max(0, position / Math.max(duration, 1e-9))) * (right - left);
  context.strokeStyle = "#ffd166";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(playhead, 0);
  context.lineTo(playhead, cssHeight);
  context.stroke();
}

function stemLaneColor(lane: string): string {
  if (lane === "drums") return "#d59d6b";
  if (lane === "bass") return "#d08088";
  if (lane === "other" || lane === "instrumental") return "#93a3d8";
  if (lane === "vocals") return "#82c49e";
  return "#b7bec9";
}

function drawPeakLane(
  context: CanvasRenderingContext2D,
  values: number[],
  left: number,
  right: number,
  middle: number,
  halfHeight: number,
  reference: number,
  color: string,
  alpha: number,
  outline = false,
) {
  if (values.length === 0) return;
  const point = (index: number) => {
    const x = left + index / Math.max(1, values.length - 1) * (right - left);
    const y = Math.min(1, Math.max(0, values[index] / reference)) * halfHeight;
    return { x, y };
  };
  context.beginPath();
  const first = point(0);
  context.moveTo(first.x, middle - first.y);
  for (let index = 1; index < values.length; index += 1) {
    const next = point(index);
    context.lineTo(next.x, middle - next.y);
  }
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const next = point(index);
    context.lineTo(next.x, middle + next.y);
  }
  context.closePath();
  context.globalAlpha = alpha;
  if (outline) {
    context.strokeStyle = color;
    context.lineWidth = 0.8;
    context.stroke();
  } else {
    context.fillStyle = color;
    context.fill();
  }
  context.globalAlpha = 1;
}
