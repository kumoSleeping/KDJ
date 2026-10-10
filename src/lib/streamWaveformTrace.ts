import type { StreamWaveformProgress } from "../types";
import { streamDurationsAgree } from "./streamWaveformExtent";

/**
 * The dev trace of an online song's waveform (`stream-waveform` in the native log, beside the
 * other `kdj_ui_trace` lines): what the server reported and how the rail laid it out. A waveform
 * that sits in the front of the rail can then be read from the log: a prefix that is still
 * loading (`covered` short of `bar`, status partial), a finished decode shorter than the bar's
 * duration (`place` prefix with status ready: nothing vouched for it), or a finished picture
 * kept over a new capture's prefix.
 *
 * `place` is the decision: `full` — the finished waveform spans the rail (`rail` differs from
 * `bar` when the decode overruled the transport's duration); `prefix` — it lies under the first
 * `covered` seconds of `rail`; `kept-finished` — the cache held the finished waveform and did
 * not trade it for this prefix; `none` — nothing to draw yet.
 */
export type StreamWaveformPlace = "none" | "prefix" | "full" | "kept-finished";

export interface StreamWaveformTrace {
  /** Changes when a line is worth writing; the poll compares it with the last one written. */
  signature: string;
  detail: Record<string, number | string | null>;
}

/** The decoded part of a loading song is news each time it enters another step this long. */
const COVERED_STEP_SECONDS = 5;
const tenth = (value: number): number => Math.round((Number.isFinite(value) ? value : 0) * 10) / 10;

/**
 * One line for the poll's latest answer. `bar` is the duration the poll projected against,
 * `rail` and `finished` what the stream cache holds after the merge.
 */
export function streamWaveformTrace(
  trackId: number,
  platform: string,
  progress: StreamWaveformProgress,
  complete: boolean,
  bar: number,
  rail: number,
  finished: boolean,
): StreamWaveformTrace {
  const covered = progress.waveform ? Math.max(0, progress.covered_seconds) : 0;
  const probed = progress.analysis_status === "ready" ? progress.analysis?.duration ?? 0 : 0;
  const place: StreamWaveformPlace = !progress.waveform
    ? "none"
    : finished && !complete
      ? "kept-finished"
      : complete && (covered >= rail || streamDurationsAgree(covered, rail))
        ? "full"
        : "prefix";
  const status = progress.waveform_status ?? (complete ? "ready" : progress.waveform ? "partial" : "waiting");
  // A song that is loading alternates between analysing and partial with every pass, and its
  // lease flag follows: neither is news. Its progress is, in steps, and its arrival at the end.
  const loading = status === "analyzing" || status === "partial";
  const step = rail > 0 && streamDurationsAgree(covered, rail)
    ? "end"
    : Math.floor(covered / COVERED_STEP_SECONDS);
  return {
    signature: [
      loading ? "loading" : status, progress.complete, loading ? "" : progress.active,
      tenth(bar), tenth(rail), tenth(probed), place, step,
    ].join("|"),
    detail: {
      track: trackId,
      platform,
      status,
      complete: String(progress.complete),
      active: String(progress.active),
      revision: progress.revision,
      covered: tenth(covered),
      bytes: `${progress.cached_bytes ?? 0}/${progress.total_bytes ?? 0}`,
      bar: tenth(bar),
      rail: tenth(rail),
      probed: tenth(probed),
      place,
    },
  };
}
