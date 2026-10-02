import { useEffect, useState } from "react";
import { Copy, Crosshair, Repeat2 } from "lucide-react";
import { liveVjAge, liveVjClockNow, liveVjPosition, type LiveVjLog, type LiveVjMatch, type LiveVjView } from "../../lib/liveVj";

const inputNames = {waiting: "等待音频", buffering: "积累证据", receiving: "监听中", quiet: "输入静音", stalled: "输入中断"};
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(0)}`;
const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${(Math.max(0, seconds) % 60).toFixed(2).padStart(5, "0")}`;

/** Read-only snapshot display. No frame loop, recognition work or transport commands. */
function LocationStrip({match, current, windowSeconds, stopped}: {
  match: LiveVjMatch; current: LiveVjMatch | null; windowSeconds: number; stopped: boolean;
}) {
  const duration = Math.max(1, match.entry.duration);
  const position = stopped ? match.position : liveVjPosition(match);
  const x = (p: number) => 6 + Math.max(0, Math.min(1, p / duration)) * 288;
  const cursor = x(position), start = x(position - windowSeconds * match.rate);
  const old = current ? x(stopped ? current.position : liveVjPosition(current)) : null;
  return <div className="kd-live-vj-location">
    <svg viewBox="0 0 300 38" role="img" aria-label={`${match.entry.title} 定位时间轴`}>
      <path d="M6 20H294 M6 15V25 M78 17V23 M150 15V25 M222 17V23 M294 15V25" className="kd-live-vj-scale"/>
      <rect x={start} width={Math.max(1, cursor - start)} y="17" height="6" className="kd-live-vj-evidence"/>
      {current && old !== null && current.entry.id === match.entry.id && current.lock_revision !== match.lock_revision
        && <line x1={old} x2={old} y1="9" y2="31" className="kd-live-vj-previous"/>}
      <line x1={cursor} x2={cursor} y1="5" y2="35" className="kd-live-vj-needle"/>
    </svg>
    <div className="kd-live-vj-readout"><output>{time(position)}</output><span>{time(match.entry.duration)}</span></div>
  </div>;
}

export function LiveVjDiagnostics({view, logs}: {view: LiveVjView | null; logs: LiveVjLog[]}) {
  const [copyState, setCopyState] = useState("");
  useEffect(() => setCopyState(""), [view?.session]);
  if (!view?.session) return null;
  const stopped = view.phase === "stopped" || view.phase === "failed";
  const {input, rescue, tracking, matched, output} = view;
  const target = view.candidate ?? matched;
  const now = liveVjClockNow();
  const feedbackFresh = now !== null && output !== null && now - output.reported_at_ms < 2000;
  const metrics = feedbackFresh || stopped ? output?.metrics : null;
  const error = metrics?.error_ms;
  const phaseX = error == null ? null : 150 - Math.max(-1, Math.min(1, error / 250)) * 138;
  const locating = view.candidate !== null || view.phase === "searching" || !matched;
  const rescueState = stopped ? "已停止" : view.phase === "indexing" ? "准备索引"
    : view.candidate ? "确认位置" : output?.state === "loading" ? "定位画面"
    : locating ? "搜索位置" : "已定位";
  const correcting = metrics && Math.abs(metrics.playback_rate - metrics.base_rate) >= 0.003;
  const followState = stopped ? "已停止" : matched && liveVjAge(matched) >= 1500 ? "沿用时钟"
    : correcting ? "速度补偿" : metrics ? "跟随" : "等待反馈";
  const step = view.candidate ? 1 : output?.state === "loading" || output?.state === "ready" ? 2
    : output?.state === "visible" && !locating ? 3 : 0;
  const copy = async () => {
    try {
      const summary = [
        `实时 VJ · ${view.session} · ${view.phase}`,
        matched && `${matched.entry.title} · ${time(matched.position)} · ${matched.rate.toFixed(3)}×`,
        rescue && `救场 ${rescue.elapsed_ms.toFixed(2)} ms · ${rescue.runs} 轮`,
        tracking && `跟随 ${tracking.elapsed_ms.toFixed(2)} ms · ${tracking.runs} 轮`,
        metrics && `画面 ${metrics.error_ms === null ? "无帧反馈" : signed(metrics.error_ms) + " ms"} · ${metrics.playback_rate.toFixed(3)}×`,
        ...logs.map(log => `${new Date(log.at_ms).toISOString()} [${log.stage}/${log.level}] ${log.message}`),
      ].filter(Boolean).join("\n");
      await navigator.clipboard.writeText(summary); setCopyState("已复制");
    } catch (e) { setCopyState(`复制失败：${String(e)}`); }
  };
  return <section className="kd-live-vj-diagnostics" aria-label="实时 VJ 定位仪表" data-stopped={stopped || undefined}>
    {input && <div className="kd-live-vj-input">
      <span>{stopped ? "采集已结束" : inputNames[input.state]}</span>
      {input.channels.map(channel => <span className="kd-live-vj-channel" key={channel.name}>
        <span>{channel.name}</span><meter min={-70} max={0} value={channel.rms_dbfs} aria-label={`${channel.name} 声道电平`}/>
      </span>)}
    </div>}
    <div className="kd-live-vj-instruments">
      <section className="kd-live-vj-instrument" aria-label="救场定位">
        <header><Crosshair size={14}/><strong>救场定位</strong><span>{rescueState}</span></header>
        {target && <>
          <div className="kd-live-vj-instrument-title" title={target.entry.title}>{target.entry.title}</div>
          <LocationStrip match={target} current={matched} windowSeconds={rescue?.query_seconds ?? 0} stopped={stopped}/>
        </>}
        <div className="kd-live-vj-stages" aria-label="救场进度">
          {["搜索", "确认", "定位", "接管"].map((name, i) => <span key={name} data-active={!stopped && step === i || undefined}>{name}</span>)}
        </div>
        {rescue && rescue.runs > 0 && <div className="kd-live-vj-readout">
          <span>检索校验 {rescue.elapsed_ms.toFixed(1)} ms</span>
          {metrics && <span>准备 {metrics.preparation_ms.toFixed(0)} ms</span>}
        </div>}
        {output?.state === "failed" && output.error && <div className="kd-live-vj-instrument-error">{output.error}</div>}
      </section>
      <section className="kd-live-vj-instrument" aria-label="循环跟随">
        <header><Repeat2 size={14}/><strong>循环跟随</strong><span>{followState}</span></header>
        {matched && <div className="kd-live-vj-tempo">
          <span>音乐 <b>{matched.rate.toFixed(3)}×</b></span>
          {metrics && <span>视频 <b>{metrics.playback_rate.toFixed(3)}×</b></span>}
        </div>}
        {metrics && <div className="kd-live-vj-phase">
          <svg viewBox="0 0 300 44" role="img" aria-label={error == null ? "无有效帧反馈" : `视频${error > 0 ? "落后" : "超前"} ${Math.abs(error).toFixed(0)} 毫秒`}>
            <path d="M12 23H288 M12 19V27 M81 20V26 M219 20V26 M288 19V27" className="kd-live-vj-scale"/>
            <line x1="150" x2="150" y1="6" y2="40" className="kd-live-vj-target"/>
            {phaseX !== null && <g className="kd-live-vj-phase-cursor" style={{transform: `translateX(${phaseX}px)`}}>
              <path d="M-4 9L0 14L4 9 M0 14V35" className="kd-live-vj-needle"/>
            </g>}
          </svg>
          <div className="kd-live-vj-readout"><span>落后</span>
            {error != null && <output>{Math.abs(error) < 0.5 ? "0" : signed(error)} ms</output>}<span>超前</span></div>
        </div>}
        {correcting && <div className="kd-live-vj-readout"><span>基准 {metrics.base_rate.toFixed(3)}×</span></div>}
      </section>
    </div>
    <details className="kd-live-vj-details">
      <summary>诊断</summary>
      <div className="kd-live-vj-input"><span>救场 / 跟随</span><button onClick={() => void copy()} title="复制诊断"><Copy size={12}/>复制</button></div>
      {copyState && <div role="status">{copyState}</div>}
      {input && <div>{input.source} · {input.sample_rate / 1000} kHz → 8 kHz · 断流 {input.gaps}</div>}
      {input?.packet_age_ms != null && <div>音频包龄 {input.packet_age_ms.toFixed(1)} ms</div>}
      {rescue && <div>救场 {rescue.runs} 轮 · 证据窗 {rescue.query_seconds.toFixed(2)} s</div>}
      {tracking && <div>跟随 {tracking.elapsed_ms.toFixed(2)} ms · {tracking.runs} 轮</div>}
      {matched && <div>位置版本 {matched.lock_revision} · 相似度 {matched.confidence.toFixed(3)}</div>}
      {metrics && <><div>最大帧间隔 {metrics.frame_gap_ms.toFixed(1)} ms · seek {metrics.seek_ms.toFixed(1)} ms</div>
        <div>定位 {metrics.seeks} 次 · 变速 {metrics.rate_changes} 次</div></>}
    </details>
  </section>;
}
