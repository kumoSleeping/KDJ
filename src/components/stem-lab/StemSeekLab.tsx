import {
  ArrowLeft,
  FlaskConical,
  LoaderCircle,
  Pause,
  Play,
  Shuffle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { StemDebugAudio, type StemDebugGains } from "../../lib/stemDebugAudio";
import { selectSelectedTrack, useLibraryStore } from "../../stores/libraryStore";
import type {
  StemLabBackend,
  StemLabCatalog,
  StemLabSeekResponse,
  StemLabStageReport,
  Track,
} from "../../types";
import { Button, InlineNotice } from "../common";

const LANE_LABELS = ["鼓", "贝斯", "其他", "人声"] as const;
const LANE_KEYS = ["drums", "bass", "other", "vocals"] as const;
const LANE_COLORS = ["#e2554f", "#3f8cff", "#c7852f", "#41b06b"];

type AuditionMode = "original" | "instant" | "refined";

function trackLabel(track: Track): string {
  const title = track.title || track.filename;
  return track.artist ? `${title} — ${track.artist}` : title;
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

function stageTitle(stage: StemLabStageReport): string {
  switch (stage.stage) {
    case "instant":
      return "即时层 · HS-TasNet 最小窗";
    case "stream":
      return "流式跟随 · HS-TasNet 512 步进";
    case "reference":
      return "精修基准 · Spleeter4 完整上下文";
    case "spleeter-context":
      return "Spleeter4 上下文";
    case "hstasnet-window":
      return "HS-TasNet 窗口";
    case "hstasnet-self":
      return "HS-TasNet 自我收敛";
    default:
      return stage.stage;
  }
}

/** 单窗口 SNR 收敛折线（每 lane 一条）。 */
function ConvergenceChart({
  title,
  points,
}: {
  title: string;
  points: { x: number; snr: [number, number, number, number] }[];
}) {
  const width = 460;
  const height = 150;
  const pad = { left: 34, right: 8, top: 10, bottom: 22 };
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const xs = sorted.map((point) => point.x);
  const ys = sorted.flatMap((point) => point.snr);
  const xMax = Math.max(...xs, 0.001);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 1);
  const sx = (x: number) =>
    pad.left + (width - pad.left - pad.right) * (xMax === 0 ? 0 : x / xMax);
  const sy = (y: number) =>
    pad.top + (height - pad.top - pad.bottom) * (1 - (y - yMin) / Math.max(yMax - yMin, 1e-6));
  return (
    <div>
      <div className="kd-muted" style={{ fontSize: 12, margin: "10px 0 4px" }}>
        {title}
      </div>
      <svg width={width} height={height} role="img" aria-label={title}>
        <line x1={pad.left} y1={sy(yMin)} x2={width - pad.right} y2={sy(yMin)} stroke="#8884" />
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={sy(yMin)} stroke="#8884" />
        {sorted.map((point, index) => (
          <text
            key={`x${index}`}
            x={sx(point.x)}
            y={height - 8}
            fontSize={9}
            textAnchor="middle"
            fill="currentColor"
            opacity={0.6}
          >
            {point.x}s
          </text>
        ))}
        <text x={2} y={sy(yMax) + 8} fontSize={9} fill="currentColor" opacity={0.6}>
          {yMax.toFixed(0)}
        </text>
        <text x={2} y={sy(yMin)} fontSize={9} fill="currentColor" opacity={0.6}>
          {yMin.toFixed(0)}
        </text>
        {LANE_KEYS.map((_, lane) => (
          <polyline
            key={lane}
            fill="none"
            stroke={LANE_COLORS[lane]}
            strokeWidth={1.6}
            points={sorted.map((point) => `${sx(point.x)},${sy(point.snr[lane])}`).join(" ")}
          />
        ))}
        {sorted.map((point, index) =>
          LANE_KEYS.map((_, lane) => (
            <circle
              key={`${index}-${lane}`}
              cx={sx(point.x)}
              cy={sy(point.snr[lane])}
              r={2.4}
              fill={LANE_COLORS[lane]}
            >
              <title>
                {`${LANE_LABELS[lane]} ctx=${point.x}s SNR=${point.snr[lane].toFixed(1)}dB`}
              </title>
            </circle>
          )),
        )}
      </svg>
      <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
        {LANE_LABELS.map((label, lane) => (
          <span key={label} style={{ color: LANE_COLORS[lane] }}>
            ● {label}
          </span>
        ))}
        <span className="kd-muted">SNR / dB · 横轴上下文秒数</span>
      </div>
    </div>
  );
}

export function StemSeekLab({ onClose }: { onClose(): void }) {
  const tracks = useLibraryStore((state) => state.tracks);
  const selected = useLibraryStore(selectSelectedTrack);
  const [trackId, setTrackId] = useState<number | null>(() => selected?.id ?? null);
  const [catalog, setCatalog] = useState<StemLabCatalog | null>(null);
  const [seekSeconds, setSeekSeconds] = useState(30);
  const [backend, setBackend] = useState<StemLabBackend>("cpu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<StemLabSeekResponse | null>(null);
  const [audition, setAudition] = useState<AuditionMode>("instant");
  const [solo, setSolo] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<StemDebugAudio | null>(null);
  const sessionRef = useRef<string | null>(null);

  const choices = useMemo(() => {
    const map = new Map<number, Track>();
    if (selected) map.set(selected.id, selected);
    for (const track of tracks) map.set(track.id, track);
    return [...map.values()];
  }, [selected, tracks]);
  const chosen = choices.find((track) => track.id === trackId) ?? selected ?? null;

  useEffect(() => {
    if (trackId === null && selected) setTrackId(selected.id);
  }, [selected, trackId]);

  useEffect(() => {
    let active = true;
    void api.stemLabCatalog().then((status) => {
      if (active) setCatalog(status);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
    };
  }, []);

  const audio = useMemo(() => new StemDebugAudio(() => setPlaying(false)), []);
  useEffect(() => {
    audioRef.current = audio;
    return () => {
      void audio.dispose();
      if (sessionRef.current) void api.releaseStemLab(sessionRef.current);
    };
  }, [audio]);

  const applyAudition = useCallback(
    (mode: AuditionMode, soloLane: string | null, player: StemDebugAudio) => {
      const gains: StemDebugGains = {};
      for (const lane of LANE_KEYS) {
        const instantKey = `instant_${lane}`;
        const refinedKey = `refined_${lane}`;
        const instantOn = mode === "instant" && (!soloLane || soloLane === instantKey);
        const refinedOn = mode === "refined" && (!soloLane || soloLane === refinedKey);
        gains[instantKey] = instantOn ? 1 : 0;
        gains[refinedKey] = refinedOn ? 1 : 0;
      }
      player.setMode(mode === "original" ? "original" : "mix");
      player.setGains(gains);
    },
    [],
  );

  const run = useCallback(async () => {
    if (!chosen) return;
    setBusy(true);
    setError("");
    setResult(null);
    audio.pause();
    setPlaying(false);
    try {
      if (sessionRef.current) void api.releaseStemLab(sessionRef.current);
      sessionRef.current = null;
      const response = await api.runStemLabSeek(chosen.id, seekSeconds, backend);
      sessionRef.current = response.sessionId;
      setResult(response);
      await audio.load(response.audio);
      setSolo(null);
      setAudition("instant");
      applyAudition("instant", null, audio);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [chosen, seekSeconds, backend, audio, applyAudition]);

  const switchAudition = useCallback(
    (mode: AuditionMode) => {
      setAudition(mode);
      applyAudition(mode, solo, audio);
    },
    [audio, applyAudition, solo],
  );

  const toggleSolo = useCallback(
    (laneKey: string) => {
      const next = solo === laneKey ? null : laneKey;
      setSolo(next);
      applyAudition(audition, next, audio);
    },
    [audio, applyAudition, audition, solo],
  );

  const togglePlay = useCallback(() => {
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play(0).then(() => setPlaying(true)).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }
  }, [audio, playing]);

  const duration = chosen?.duration ?? null;
  const presets = [30, 60];
  const schedule = result?.report.schedule ?? null;
  const spleeterConvergence = (result?.report.stages ?? [])
    .filter((stage) => stage.stage === "spleeter-context" && stage.snrDb)
    .map((stage) => ({ x: stage.contextSeconds, snr: stage.snrDb! }));
  const hstasnetConvergence = (result?.report.stages ?? [])
    .filter((stage) => stage.stage === "hstasnet-self" && stage.snrDb)
    .map((stage) => ({ x: stage.contextSeconds, snr: stage.snrDb! }));

  return (
    <div className="kd-stem-lab">
      <header className="kd-stem-lab-head">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft size={15} /> 返回
        </Button>
        <h2>
          <FlaskConical size={17} /> Stem 跳转实验台
        </h2>
        {catalog ? (
          <span className="kd-muted" style={{ fontSize: 12 }}>
            HS-TasNet {catalog.hstasnet.ready ? "✓" : "✗"} · Spleeter4{" "}
            {catalog.spleeter4.ready ? "✓" : "✗"} · {catalog.sampleRate} Hz
          </span>
        ) : null}
      </header>

      <div className="kd-stem-lab-body">
        <div className="kd-lab-controls">
          <select
            value={trackId ?? ""}
            onChange={(event) => setTrackId(Number(event.target.value))}
            style={{ maxWidth: 320 }}
          >
            {choices.map((track) => (
              <option key={track.id} value={track.id}>
                {trackLabel(track)}
              </option>
            ))}
          </select>
          {presets.map((preset) => (
            <Button
              key={preset}
              variant={seekSeconds === preset ? "primary" : "ghost"}
              size="sm"
              onClick={() => setSeekSeconds(preset)}
            >
              {preset}s
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => duration && setSeekSeconds(Math.round(duration / 2))}
            disabled={!duration}
          >
            50%
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              duration &&
              setSeekSeconds(Math.round(5 + Math.random() * Math.max(duration - 13, 1)))
            }
            disabled={!duration}
            title="随机跳转位置"
          >
            <Shuffle size={13} />
          </Button>
          <input
            type="number"
            min={5}
            max={duration ? Math.max(duration - 8, 5) : undefined}
            value={seekSeconds}
            onChange={(event) => setSeekSeconds(Number(event.target.value) || 30)}
            style={{ width: 72 }}
          />
          <select
            value={backend}
            onChange={(event) => setBackend(event.target.value as StemLabBackend)}
          >
            <option value="cpu">ONNX Runtime CPU</option>
            <option value="coreml-gpu">CoreML CPU+GPU</option>
            <option value="coreml-all">CoreML All (含 ANE)</option>
          </select>
          <Button variant="primary" size="sm" onClick={() => void run()} disabled={busy || !chosen}>
            {busy ? <LoaderCircle className="kd-spin" size={14} /> : <Play size={13} />}
            开始实验
          </Button>
        </div>

        {error ? <InlineNotice text={error} block onDismiss={() => setError("")} /> : null}

        {result && schedule ? (
          <>
            <div className="kd-lab-cards">
              <div className="kd-lab-card">
                <span className="kd-lab-card-value">{schedule.firstOutputMs.toFixed(1)} ms</span>
                <span className="kd-muted">跳转后首个 Stem 输出（HS-TasNet 最小窗）</span>
              </div>
              <div className="kd-lab-card">
                <span className="kd-lab-card-value">
                  {schedule.streamStepP95Ms.toFixed(1)} / {schedule.streamHopMs.toFixed(1)} ms
                </span>
                <span className="kd-muted">流式跟随 p95 / hop 预算</span>
              </div>
              <div className="kd-lab-card">
                <span className="kd-lab-card-value">{ms(schedule.refinedTileWallMs)}</span>
                <span className="kd-muted">
                  Spleeter4 精修 tile（冷启动 {ms(schedule.firstTileWallMs)}）
                </span>
              </div>
              <div className="kd-lab-card">
                <span className="kd-lab-card-value">{ms(schedule.replaceMarginMs)}</span>
                <span className="kd-muted">精修落地时未播放余量（&gt;0 可无感替换）</span>
              </div>
            </div>

            {schedule.notes.map((note) => (
              <div key={note} className="kd-muted" style={{ fontSize: 12 }}>
                · {note}
              </div>
            ))}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
              {spleeterConvergence.length > 0 && (
                <ConvergenceChart
                  title="Spleeter4：上下文 → SNR（vs 完整上下文）"
                  points={spleeterConvergence}
                />
              )}
              {hstasnetConvergence.length > 0 && (
                <ConvergenceChart
                  title="HS-TasNet：上下文 → SNR（vs 自身最大窗口）"
                  points={hstasnetConvergence}
                />
              )}
            </div>

            <table className="kd-lab-table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>上下文</th>
                  <th>耗时</th>
                  <th>RTF</th>
                  <th>SNR 鼓/贝/他/声</th>
                </tr>
              </thead>
              <tbody>
                {result.report.stages
                  .filter((stage) => stage.stage !== "hstasnet-self")
                  .map((stage, index) => (
                    <tr key={index}>
                      <td>{stageTitle(stage)}</td>
                      <td>{stage.contextSeconds.toFixed(2)} s</td>
                      <td>
                        {stage.wallMs > 0 ? ms(stage.wallMs) : "—"}
                        {stage.wallP95Ms ? ` (p95 ${ms(stage.wallP95Ms)})` : ""}
                      </td>
                      <td>{stage.rtf > 0 ? stage.rtf.toFixed(2) : "—"}</td>
                      <td>
                        {stage.snrDb
                          ? stage.snrDb.map((value) => value.toFixed(1)).join(" / ")
                          : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>

            <div className="kd-lab-audition">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Button variant="ghost" size="sm" onClick={togglePlay}>
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                </Button>
                {(["original", "instant", "refined"] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant={audition === mode ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => switchAudition(mode)}
                  >
                    {mode === "original" ? "原曲" : mode === "instant" ? "即时层" : "精修层"}
                  </Button>
                ))}
                <span className="kd-muted" style={{ fontSize: 12 }}>
                  跳转点 {result.report.seekSeconds.toFixed(1)}s 起 {result.audio ? "≈3.9s" : ""}
                </span>
              </div>
              {audition !== "original" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  {LANE_KEYS.map((lane, index) => {
                    const key = `${audition}_${lane}`;
                    return (
                      <Button
                        key={key}
                        variant={solo === key ? "primary" : "ghost"}
                        size="sm"
                        onClick={() => toggleSolo(key)}
                      >
                        <span style={{ color: LANE_COLORS[index] }}>●</span> {LANE_LABELS[index]}
                      </Button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
