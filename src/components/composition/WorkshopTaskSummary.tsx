import { memo } from "react";
import { MarqueeText } from "../common/MarqueeText";
import { Layers2 } from "lucide-react";
import { QueueCover } from "../queue/QueuePrimitives";
import { api } from "../../lib/api";
import { clipDuration, formatTime, projectDuration, isImageSource, isVisualSource } from "../../lib/workshop";
import type { CompositionProject, WorkshopLayer } from "../../types/workshop";

function timing(layer: WorkshopLayer): string {
  const clips = [...layer.clips].sort((a, b) => a.start_ms - b.start_ms);
  if (!clips.length) return "";
  if (clips.some(c => c.speed.preset !== "constant")) return "曲线变速 · 分段定位";
  // An offset is only constant for a constant-speed segment. Keep distinct
  // mappings visible after splitting instead of presenting the first as global.
  const offsets = [...new Set(clips.map(c => Math.round(c.start_ms - c.source_in_ms / c.speed.start)))];
  const label = (ms: number) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(3)} s`;
  return `Offset ${offsets.map(label).join(" / ")}${offsets.length > 1 ? " · 分段" : ""}`;
}

function soundLabel(p: CompositionProject): string {
  const audible = p.layers.filter(l => l.clips.some(c => p.sources.find(s => s.id === c.source_id)?.audio && !c.sound.muted && c.sound.gain > 0));
  if (!audible.length) return "静音";
  if (audible.length === 1) {
    const source = p.sources.find(s => s.id === audible[0].source_id);
    return source?.video ? "视频原声" : "独立音轨";
  }
  const overlaps = audible.some((l, i) => audible.slice(i + 1).some(other => l.clips.some(a => !a.sound.muted && a.sound.gain > 0 && other.clips.some(b => !b.sound.muted && b.sound.gain > 0 && a.start_ms < b.start_ms + clipDuration(b) && b.start_ms < a.start_ms + clipDuration(a)))));
  return overlaps ? `${audible.length} 路混音` : `${audible.length} 路声音顺接`;
}

export const WorkshopTaskSummary = memo(function WorkshopTaskSummary({ project: p }: { project: CompositionProject }) {
  const pair = p.layers.length === 2;
  // Preserve the old pair convention: video at left, music/overlay at right.
  // For two videos the lower picture is the base and the upper is the overlay.
  const layers = pair ? [...p.layers].sort((a, b) => {
    const av = Boolean(p.sources.find(s => s.id === a.source_id)?.video);
    const bv = Boolean(p.sources.find(s => s.id === b.source_id)?.video);
    return av !== bv ? Number(bv) - Number(av) : p.layers.indexOf(b) - p.layers.indexOf(a);
  }) : p.layers;
  const visibleLayers = layers.filter(layer => p.sources.some(s => s.id === layer.source_id)).slice(0, 3);
  const hiddenLayers = layers.length - visibleLayers.length;
  const duration = Math.max(1, projectDuration(p));
  const videos = p.layers.filter(l => isVisualSource(p.sources.find(s => s.id === l.source_id)) && l.clips.length).length;
  const hasImages = p.sources.some(isImageSource);
  return <div className={`vj-task-summary ${pair ? "vj-task-pair" : "vj-task-mix"}`} aria-label={pair ? "双素材详情" : "素材混合详情"}>
    <div className="vj-task-overview">
    <div className="vj-task-media-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, visibleLayers.length)}, minmax(0, 1fr))` }}>
      {visibleLayers.map(layer => {
        const source = p.sources.find(s => s.id === layer.source_id);
        if (!source) return null;
        const clips = [...layer.clips].sort((a, b) => a.start_ms - b.start_ms);
        const start = clips[0]?.start_ms ?? 0;
        const end = Math.max(start, ...clips.map(c => c.start_ms + clipDuration(c)));
        const gains = [...new Set(clips.map(c => c.sound.muted ? 0 : Math.round(c.sound.gain * 100)))];
        return <div className="vj-task-media" key={layer.id}>
          <QueueCover artwork={api.coverUrl(source.track_id)} video={source.video} />
          <div className="vj-task-media-info">
            <span className="vj-task-media-title" title={source.path}>{source.title}</span>
            <small>{source.kind === "gif" ? "GIF" : isImageSource(source) ? "图片" : source.video ? "视频" : "音频"} · {clips.length} 段{source.audio && gains.length ? ` · 音量 ${gains.join(" / ")}%` : ""}</small>
          </div>
          {clips.length > 0 && <MarqueeText className="vj-task-timing"
            text={`${!isImageSource(source) ? `${timing(layer)} · ` : ""}${formatTime(start)} — ${formatTime(end)}`} />}
        </div>;
      })}
    </div>
    <div className="vj-task-mini-tracks" aria-label="素材叠加区间">
      {visibleLayers.map(layer => {
        const source = p.sources.find(s => s.id === layer.source_id)!;
        return <div className="vj-task-mini-track" key={layer.id} aria-label={`${source.title} 的作品区间`}>
          {layer.clips.map(c => <span key={c.id} data-video={isVisualSource(source) || undefined}
            style={{left: `${c.start_ms / duration * 100}%`, width: `${clipDuration(c) / duration * 100}%`}}
            title={`${source.title}；作品 ${formatTime(c.start_ms)} — ${formatTime(c.start_ms + clipDuration(c))}；素材 ${formatTime(c.source_in_ms)} — ${formatTime(c.source_out_ms)}`} />)}
        </div>;
      })}
    </div>
    </div>
    {p.layers.length > 0 && <div className="vj-task-mix-facts"><Layers2 size={12} aria-hidden="true" />
      {hiddenLayers > 0 && <span title={`另有 ${hiddenLayers} 轨，编辑中查看全部`}>+{hiddenLayers}</span>}
      <span>{hasImages ? `${p.layers.length} 轨合成` : pair ? videos === 2 ? "双视频叠加" : videos === 1 ? "音视频合成" : "音频合成" : `${p.layers.length} 轨合成`}</span>
      <span>{soundLabel(p)}</span>
      {videos > 1 && <span>上层覆盖下层</span>}
      <span>{p.layers.reduce((n, l) => n + l.clips.length, 0)} 段</span>
    </div>}
  </div>;
});
