import type { CSSProperties } from "react";
import type { CuePoint } from "../../types";
import {
  cueColor,
  cueNearTime,
  cueTitle,
  hotCueLabel,
  waveformLoopRegions,
} from "../../lib/cuePoints";

export function markerRatio(ms: number | null | undefined, totalSec: number): number | null {
  if (ms == null || totalSec <= 0) return null;
  return Math.min(1, Math.max(0, ms / 1000 / totalSec));
}

function timeRatio(timeSec: number, totalSec: number): number | null {
  if (!Number.isFinite(timeSec) || totalSec <= 0) return null;
  return Math.min(1, Math.max(0, timeSec / totalSec));
}

function loopRegionStyle(start: number, end: number, color: string): CSSProperties {
  return {
    left: `${start * 100}%`,
    width: `${Math.max(0, end - start) * 100}%`,
    "--kd-cue-color": color,
  } as CSSProperties;
}

function cueMarkerStyle(at: number, color: string): CSSProperties {
  return {
    left: `${at * 100}%`,
    "--kd-cue-color": color,
  } as CSSProperties;
}

/** 半透明 Loop 区间。Beat grid 应画在这层上面，Cue 三角竖线再盖上来。 */
export function WaveformLoopFills({
  total,
  cuePoints = [],
  loopStart = null,
  loopLength = null,
}: {
  total: number;
  cuePoints?: readonly CuePoint[];
  loopStart?: number | null;
  loopLength?: number | null;
}) {
  if (total <= 0) return null;
  return (
    <>
      {waveformLoopRegions(cuePoints, loopStart, loopLength).map((region) => {
        const start = timeRatio(region.startSec, total);
        const end = timeRatio(region.endSec, total);
        if (start === null || end === null || end <= start) return null;
        return (
          <span
            key={region.key}
            className="kd-wave-cue-loop"
            data-active={region.active || undefined}
            style={loopRegionStyle(start, end, region.color)}
            aria-hidden="true"
          />
        );
      })}
    </>
  );
}

/** Cue 点：上下三角 + 竖线。普通 Loop 只有色带，不画 Cue 锚点。 */
export function WaveformCueMarkers({
  total,
  cuePoints = [],
}: {
  total: number;
  cuePoints?: readonly CuePoint[];
}) {
  if (total <= 0) return null;
  return (
    <>
      {cuePoints.map((cue) => {
        const at = markerRatio(cue.start_ms, total);
        if (at === null) return null;
        const hot = hotCueLabel(cue.hot_cue);
        return (
          <span
            key={`cue:${cue.id}`}
            className="kd-wave-cue"
            data-kind={hot ? "hot" : "memory"}
            data-loop={cue.end_ms !== null ? "true" : undefined}
            style={cueMarkerStyle(at, cueColor(cue))}
            title={cueTitle(cue)}
            aria-hidden="true"
          />
        );
      })}
      {cuePoints.map((cue) => {
        if (cue.end_ms === null || cue.end_ms <= cue.start_ms) return null;
        const end = markerRatio(cue.end_ms, total);
        if (end === null || cueNearTime(cuePoints, cue.end_ms / 1_000) !== undefined) return null;
        return (
          <span
            key={`cue:${cue.id}:end`}
            className="kd-wave-cue"
            data-kind="loop-end"
            style={cueMarkerStyle(end, cueColor(cue))}
            aria-hidden="true"
          />
        );
      })}
    </>
  );
}

/** 校验起止点并生成 patch；不合法返回中文原因。 */
export function pointPatch(
  kind: "start" | "end",
  positionSec: number,
  cueMs: number | null | undefined,
  endMs: number | null | undefined,
): { cue_ms: number } | { end_ms: number } | string {
  const ms = Math.max(0, Math.round(positionSec * 1000));
  if (kind === "start") {
    if (endMs != null && ms >= endMs) return "开始点必须早于结束点";
    return { cue_ms: ms };
  }
  if (cueMs != null && ms <= cueMs) return "结束点必须晚于开始点";
  return { end_ms: ms };
}

