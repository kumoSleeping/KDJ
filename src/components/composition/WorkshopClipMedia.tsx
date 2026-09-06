import { memo, useEffect, useState } from "react";
import type { WorkshopClip, WorkshopSource } from "../../types/workshop";
import type { Waveform } from "../../types";
import { api } from "../../lib/api";
import { loadWaveform } from "../../lib/waveformCache";
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
  useEffect(() => {
    if (source.video || !source.audio) return;
    let live = true;
    void loadWaveform(source.track_id, 2048, true)
      .then((w) => {
        if (live) setWave(w);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
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
  if (!wave?.amp.length) return null;
  const width = Math.max(1, hi - lo),
    count = Math.min(1200, Math.ceil(width / 2));
  const rangeStart = (wave.source_start ?? 0) * 1000,
    rangeEnd = (wave.source_end ?? wave.duration) * 1000;
  const bars = Array.from({ length: count }, (_, i) => {
    const t = sourceAt(clip, (lo + ((i + 0.5) * width) / count) / scale),
      index = Math.max(
        0,
        Math.min(
          wave.amp.length - 1,
          Math.floor(
            ((t - rangeStart) / Math.max(1, rangeEnd - rangeStart)) *
              wave.amp.length,
          ),
        ),
      );
    return {
      x: (i * width) / count,
      h: Math.max(1, wave.amp[index] * 28),
      color: `rgb(${wave.r[index] ?? 110},${wave.g[index] ?? 150},${wave.b[index] ?? 190})`,
    };
  });
  return (
    <svg
      className="vj-wave-strip"
      aria-hidden="true"
      style={{ left: lo, width }}
      viewBox={`0 0 ${width} 36`}
      preserveAspectRatio="none"
    >
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={18 - b.h / 2}
          width={Math.max(1, width / count - 1)}
          height={b.h}
          fill={b.color}
        />
      ))}
    </svg>
  );
}, (a, b) => a.project === b.project && a.source === b.source && a.clip === b.clip
  && a.scale === b.scale && a.viewport.left === b.viewport.left && a.viewport.width === b.viewport.width);
