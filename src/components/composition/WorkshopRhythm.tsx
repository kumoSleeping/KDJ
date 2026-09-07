import { useEffect, useMemo } from "react";
import { useWorkshopRhythmStore, watchWorkshopRhythm, analyzeWorkshopRhythm } from "../../stores/workshopRhythmStore";
import { useWorkshopStore } from "../../stores/workshopStore";
import { rhythmKey, workshopGrid } from "../../lib/workshopRhythm";
import { projectBeats } from "../../lib/workstation";
import { spacedRulerBeats, spacedRulerLabels, selectedBarCount, formatBarCount } from "../../lib/workstationRuler";
import { clipDuration, outputAt, sourceAt, speedAt, formatTime } from "../../lib/workshop";
import type { WorkshopLayer, WorkshopSource } from "../../types/workshop";

export function WorkshopRhythmSource({ source }: { source: WorkshopSource }) {
  useEffect(() => watchWorkshopRhythm(source), [source.track_id, source.signature]);
  return null;
}

export function WorkshopRhythmControls({ source, layer, position }: {source: WorkshopSource; layer: WorkshopLayer; position: number}) {
  const results = useWorkshopRhythmStore(s => s.results);
  const key = rhythmKey(source), response = results[key];
  const error = useWorkshopRhythmStore(s => s.errors[key]);
  const requesting = useWorkshopRhythmStore(s => s.requesting[key]);
  const selected = useWorkshopStore(s => s.selectedId);
  const grid = useMemo(() => workshopGrid(layer, source, results), [layer.grid, source, results]);
  const busy = requesting || ["queued", "analyzing"].includes(response?.status?.phase ?? "");
  const clip = layer.clips.find(c => position >= c.start_ms && position < c.start_ms + clipDuration(c));
  const time = clip ? sourceAt(clip, position - clip.start_ms) : 0;
  const segment = grid?.segments.find(s => time >= s.start_seconds * 1000 && time < s.end_seconds * 1000);
  const bpm = segment && clip ? segment.bpm * speedAt(clip.speed, time) : undefined;
  const selection = layer.clips.find(c => c.id === selected);
  const count = useMemo(() => grid && selection ? formatBarCount(selectedBarCount(layer, grid,
    [[selection.start_ms, selection.start_ms + clipDuration(selection)]])) : null, [layer, grid, selection]);
  return <div className="vj-rhythm-controls">
    <button type="button" disabled={busy} onClick={() => void analyzeWorkshopRhythm(source)} title="全曲精确分析拍点与小节首拍">BPM 分析</button>
    {busy && <span role="status">{response?.status?.phase === "queued" ? "等待分析" : "精确分析中"}</span>}
    {bpm !== undefined && <span>{bpm.toFixed(2)} BPM</span>}
    {count && <span>选中 {count} 小节</span>}
    {grid && grid.downbeat_confidence < .25 && <span title="自动识别的小节首拍置信度偏低，接点需试听确认">首拍置信度低</span>}
    {error && <span className="vj-error" role="status">{error}</span>}
  </div>;
}

/** The same source beat mapping drives the preview ruler and edit snapping. */
export function WorkshopRhythmRuler({ source, layer, scale, left, width }: {
  source: WorkshopSource; layer: WorkshopLayer; scale: number; left: number; width: number;
}) {
  const results = useWorkshopRhythmStore(s => s.results);
  const grid = useMemo(() => workshopGrid(layer, source, results), [layer.grid, source, results]);
  const start = left / scale, end = (left + width) / scale;
  const beats = useMemo(() => grid ? spacedRulerBeats(projectBeats(layer, grid, start, end), start, end, width) : [], [grid, layer, start, end, width]);
  const tempos = useMemo(() => {
    if (!grid) return [];
    const regions = layer.clips.flatMap(c => grid.segments.flatMap(s => {
      const a = Math.max(c.source_in_ms, s.start_seconds * 1000), b = Math.min(c.source_out_ms, s.end_seconds * 1000);
      if (b <= a) return [];
      const first = s.bpm * speedAt(c.speed, a), last = s.bpm * speedAt(c.speed, b);
      return [{time: c.start_ms + outputAt(c, a), end: c.start_ms + outputAt(c, b),
        label: c.speed.preset === "constant" ? `${first.toFixed(2)} BPM` : `${first.toFixed(2)} → ${last.toFixed(2)} BPM`}];
    })).sort((a, b) => a.time - b.time);
    return regions.filter((s, i) => s.end > start && s.time < end && (!i || s.label !== regions[i - 1].label
      || Math.abs(s.time - regions[i - 1].end) > .01 || s.time <= start))
      .map(s => ({...s, time: Math.max(start, s.time)}));
  }, [grid, layer, start, end]);
  const tempoLabels = useMemo(() => spacedRulerLabels(tempos, start, end, width), [tempos, start, end, width]);
  const bars = useMemo(() => spacedRulerLabels(beats.filter(b => b.downbeat).map(b => ({time: b.time, label: String(b.bar)})), start, end, width, tempoLabels), [beats, start, end, width, tempoLabels]);
  if (!grid) return null;
  return <div className="vj-rhythm-ruler" aria-label={`${source.title} 小节线`} style={{left, width}}>
    {beats.map(b => <i key={b.time} data-bar={b.downbeat || undefined} style={{left: (b.time - start) * scale}} />)}
    {bars.map(b => <span className="vj-bar-number" key={b.time} style={{left: b.left}}>{b.label}</span>)}
    {tempoLabels.map(s => <span className="vj-tempo-label" key={s.time} style={{left: s.left}} title={`${formatTime(s.time)} · ${s.label}`}>{s.label}</span>)}
  </div>;
}
