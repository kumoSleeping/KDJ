import { memo, useEffect, useState } from "react";
import type { WorkshopClip, WorkshopSource } from "../../types/workshop";
import type { Waveform } from "../../types";
import { api } from "../../lib/api";
import { loadReleaseOverviewById, isPlaybackDeferredWaveformError, isSupersededWaveformError, deferredOverviewRetryDelay } from "../../lib/waveformCache";
import { clipDuration, sourceAt, isVisualSource } from "../../lib/workshop";
import { acquireCoverThumbnail } from "../../lib/coverThumbnailQueue";

function FrameImage({ url, left }: { url: string; left: number }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    let lease: ReturnType<typeof acquireCoverThumbnail> | undefined;
    // Wait for zoom/trim to settle; obsolete and off-screen requests never enter
    // the shared two-request artwork lane. Release also aborts active fetches.
    const timer = setTimeout(() => {
      lease = acquireCoverThumbnail(`vj-frame:${url}`, url, 2);
      void lease.promise.then(value => { if (live) setSrc(value); }).catch(() => {});
    }, 160);
    return () => { live = false; clearTimeout(timer); lease?.release(); };
  }, [url]);
  return <img src={src} draggable={false} decoding="async" alt="" style={{ left, width: 80 }} />;
}

export const WorkshopClipMedia = memo(function WorkshopClipMedia({
  project,
  source,
  clip,
  scale,
  viewport,
}: {
  project: string;
  source: WorkshopSource;
  clip: WorkshopClip;
  scale: number;
  viewport: { left: number; width: number };
}) {
  const [wave, setWave] = useState<Waveform | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setWave(null); setError("");
    if (source.video || !source.audio) return;
    let live = true, attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const value = await loadReleaseOverviewById(source.track_id);
        if (live) setWave(value);
      } catch (error) {
        if (!live) return;
        if (isPlaybackDeferredWaveformError(error) || isSupersededWaveformError(error))
          timer = setTimeout(() => void load(), deferredOverviewRetryDelay(attempts++));
        else setError(String(error));
      }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [source.track_id, source.signature, source.video, source.audio]);
  const pixels = clipDuration(clip) * scale;
  const lo = Math.max(0, viewport.left - clip.start_ms * scale - 164),
    hi = Math.min(
      pixels,
      viewport.left + viewport.width - clip.start_ms * scale,
    );
  if (hi <= lo) return null;
  if (isVisualSource(source)) {
    const start = Math.max(0, Math.floor(lo / 80) - 1),
      end = Math.min(Math.ceil(pixels / 80), Math.ceil(hi / 80) + 1);
    return (
      <div className="vj-filmstrip" aria-hidden="true">
        {Array.from({ length: Math.min(64, end - start) }, (_, n) => {
          const tile = start + n,
            ms = sourceAt(
              clip,
              Math.min(clipDuration(clip) - 1, (tile * 80 + 40) / scale),
            );
          return (
            <FrameImage
              key={`${source.signature}:${tile}`}
              left={tile * 80}
              url={api.workshopFrameUrl(
                project,
                source.id,
                Math.round(ms / 200) * 200,
              )}
            />
          );
        })}
      </div>
    );
  }
  if (error) return <span className="vj-wave-error" role="status">{error}</span>;
  if (!wave?.amp.length) return null;
  const width = Math.max(1, hi - lo),
    count = Math.min(1200, Math.ceil(width / 2));
  const rangeStart = (wave.source_start ?? 0) * 1000,
    rangeEnd = (wave.source_end ?? wave.duration) * 1000;
  const bars = Array.from({ length: count }, (_, i) => {
    const fromTime = sourceAt(clip, (lo + i * width / count) / scale),
      toTime = sourceAt(clip, (lo + (i + 1) * width / count) / scale);
    const indexAt = (time: number) => Math.max(0, Math.min(wave.amp.length - 1,
      Math.floor((time - rangeStart) / Math.max(1, rangeEnd - rangeStart) * wave.amp.length)));
    const from = indexAt(fromTime), to = Math.max(from + 1, Math.ceil((toTime - rangeStart) / Math.max(1, rangeEnd - rangeStart) * wave.amp.length));
    const values: number[] = [];
    let red = 0, green = 0, blue = 0, weight = 0;
    for (let j = from; j < Math.min(wave.amp.length, to); j++) {
      const value = wave.amp[j], w = value + .001;
      values.push(value); red += wave.r[j] * w; green += wave.g[j] * w; blue += wave.b[j] * w; weight += w;
    }
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const amplitude = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    return {
      x: (i * width) / count,
      h: Math.max(1, Math.min(1, amplitude) * 44),
      color: `rgb(${Math.round(red / weight)},${Math.round(green / weight)},${Math.round(blue / weight)})`,
    };
  });
  return (
    <svg
      className="vj-wave-strip"
      aria-hidden="true"
      style={{ left: lo, width }}
      viewBox={`0 0 ${width} 60`}
      preserveAspectRatio="none"
    >
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={60 - b.h}
          width={Math.max(1, width / count - 1)}
          height={b.h}
          fill={b.color}
        />
      ))}
    </svg>
  );
}, (a, b) => a.project === b.project && a.source === b.source && a.clip === b.clip
  && a.scale === b.scale && a.viewport.left === b.viewport.left && a.viewport.width === b.viewport.width);
