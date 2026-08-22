import type { StemRuntimeStatus, TrackStemStatus } from "../types";
import { stemRuntimeStatusLabel } from "./stemMode";

export const KNOB_CENTER_RATIO = 0.01;

export interface StemDeckLog {
  job: string;
  runtime: string;
  title: string;
  error: boolean;
}

export function knobCenter(min: number, max: number): number { return (min + max) / 2; }
export function knobCenterDeadzone(min: number, max: number): number {
  return Math.abs(max - min) / 2 * KNOB_CENTER_RATIO;
}
export function snapKnobToCenter(value: number, min: number, max: number): number {
  const center = knobCenter(min, max);
  return Math.abs(value - center) <= knobCenterDeadzone(min, max) ? center : value;
}
export function knobBias(value: number, min: number, max: number): "boost" | "cut" | null {
  const snapped = snapKnobToCenter(value, min, max);
  const center = knobCenter(min, max);
  if (snapped > center) return "boost";
  if (snapped < center) return "cut";
  return null;
}

function formatScanSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0s";
  return value >= 10 ? Math.round(value) + "s" : value.toFixed(1) + "s";
}

export function stemJobLine(
  status: TrackStemStatus | null,
  runtimeStatus: StemRuntimeStatus | null,
  displaying = false,
): string {
  if (displaying && runtimeStatus?.state === "error") return runtimeStatus.diagnostics.lastError.trim();
  if (!status) return "";
  if (status.phase === "error" && status.error.trim()) return status.error.trim();
  if (status.state === "error" && status.error.trim()) return status.error.trim();
  if (status.phase === "waiting") {
    return status.waitingForDeck === 0 ? "WAIT DECK A" : status.waitingForDeck === 1 ? "WAIT DECK B" : "WAIT";
  }
  if (status.phase === "window") {
    const span = Math.max(0, (status.windowEnd ?? 0) - (status.windowStart ?? 0));
    return "NOW " + formatScanSeconds(status.windowCoveredSeconds ?? 0) + "/" + formatScanSeconds(span);
  }
  if (status.phase === "fill") return "FILL " + Math.round((status.progress ?? 0) * 100) + "%";
  if (status.phase === "done") return "READY";
  if (status.state === "queued") return "QUEUED";
  if (status.state === "separating") return "SEPARATING " + Math.round(status.progress * 100) + "%";
  return "";
}

export function stemRuntimeLine(status: StemRuntimeStatus | null): { text: string; title: string; error: boolean } {
  if (!status) return { text: "", title: "", error: false };
  const diagnostic = status.diagnostics;
  const name = [stemRuntimeStatusLabel(status.id), status.version].filter(Boolean).join(" " );
  const timings = [
    diagnostic.firstBlockMs == null ? "" : "F " + diagnostic.firstBlockMs + "ms",
    diagnostic.lastBlockMs == null ? "" : "B " + diagnostic.lastBlockMs + "ms",
    diagnostic.p95BlockMs == null ? "" : "P95 " + diagnostic.p95BlockMs + "ms",
  ].filter(Boolean);
  const error = Boolean(diagnostic.lastError.trim() || status.state === "error");
  const text = [name, diagnostic.runtime, diagnostic.provider, ...timings, error ? "ERR" : ""]
    .filter(Boolean).join(" · " );
  const title = [
    name,
    diagnostic.runtime ? "runtime: " + diagnostic.runtime : "",
    diagnostic.provider ? "provider: " + diagnostic.provider : "",
    diagnostic.chunkBudgetMs ? "tile budget: " + diagnostic.chunkBudgetMs + "ms" : "",
    diagnostic.initializationMs == null ? "" : "initialization: " + diagnostic.initializationMs + "ms",
    diagnostic.firstBlockMs == null ? "" : "first block: " + diagnostic.firstBlockMs + "ms",
    diagnostic.lastBlockMs == null ? "" : "last block: " + diagnostic.lastBlockMs + "ms",
    diagnostic.p95BlockMs == null ? "" : "p95: " + diagnostic.p95BlockMs + "ms",
    diagnostic.processedChunks ? "processed: " + diagnostic.processedChunks : "",
    diagnostic.lateChunks ? "late: " + diagnostic.lateChunks : "",
    diagnostic.outputUnderruns ? "output gaps: " + diagnostic.outputUnderruns : "",
    diagnostic.memoryErrors ? "memory errors: " + diagnostic.memoryErrors : "",
    diagnostic.lastError.trim() ? "error: " + diagnostic.lastError.trim() : "",
  ].filter(Boolean).join("\n");
  return { text, title, error };
}

export function stemDeckLog(
  status: TrackStemStatus | null,
  runtimeStatus: StemRuntimeStatus | null,
  displaying = false,
): StemDeckLog {
  const runtime = stemRuntimeLine(runtimeStatus);
  const job = stemJobLine(status, runtimeStatus, displaying);
  return {
    job,
    runtime: runtime.text,
    title: [job, runtime.title].filter(Boolean).join("\n"),
    error: runtime.error || status?.state === "error" || status?.phase === "error" || runtimeStatus?.state === "error",
  };
}
