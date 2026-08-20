import type { StemModelStatus, TrackStemStatus } from "../types";
import { stemModelStatusLabel } from "./stemMode";

/**
 * 中位死区：半行程的 ±1%。Pioneer 台子靠实体卡口回中；软件没有卡口时，
 * 1% 够用手扭回 0，又不会把扫频吃掉。7-bit MIDI 中心是 64/127，本来就对不齐精确 0。
 */
export const KNOB_CENTER_RATIO = 0.01;

export interface StemDeckLog {
  job: string;
  runtime: string;
  title: string;
  error: boolean;
}

export function knobCenter(min: number, max: number): number {
  return (min + max) / 2;
}

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
  return value >= 10 ? `${Math.round(value)}s` : `${value.toFixed(1)}s`;
}

/** 第一行：这一侧正在做的 STEM 活。空着就是空着，不写提示语。 */
export function stemJobLine(
  status: TrackStemStatus | null,
  model: StemModelStatus | null,
  displaying = false,
): string {
  if (model?.state === "error" && model.error.trim()) return model.error.trim();
  if (model?.state === "queued" || model?.state === "downloading") {
    return `MODEL ${Math.round(model.progress * 100)}%`;
  }
  if (displaying && model?.state === "unsupported") return "UNSUPPORTED";
  if (displaying && (model?.state === "missing" || !model)) return "MODEL MISSING";
  if (!status) return "";
  if (status.phase === "error" && status.error.trim()) return status.error.trim();
  if (status.state === "error" && status.error.trim()) return status.error.trim();
  if (status.phase === "waiting") {
    return status.waitingForDeck === 0 ? "WAIT DECK A" : status.waitingForDeck === 1 ? "WAIT DECK B" : "WAIT";
  }
  if (status.phase === "window") {
    const span = Math.max(0, (status.windowEnd ?? 0) - (status.windowStart ?? 0));
    return `NOW ${formatScanSeconds(status.windowCoveredSeconds ?? 0)}/${formatScanSeconds(span)}`;
  }
  if (status.phase === "fill") return `FILL ${Math.round((status.progress ?? 0) * 100)}%`;
  if (status.phase === "done") return "READY";
  if (status.state === "missing") return "";
  if (status.state === "downloadingModel") return `MODEL ${Math.round(status.progress * 100)}%`;
  if (status.state === "loadingModel") return "LOADING MODEL";
  if (status.state === "queued") return "QUEUED";
  if (status.state === "separating") return `SEPARATING ${Math.round(status.progress * 100)}%`;
  return "";
}

/** 第二行：模型名 + 实际选中的 runtime / CPU·GPU。pending 不当作成绩。 */
export function stemRuntimeLine(model: StemModelStatus | null): { text: string; title: string; error: boolean } {
  if (!model?.supported || model.state === "unsupported") {
    return { text: "", title: "", error: false };
  }
  const diagnostic = model.diagnostics;
  const modelName = stemModelStatusLabel(model.id);
  const name = [modelName, model.version].filter(Boolean).join(" ");
  const runtime = diagnostic?.runtime && diagnostic.runtime !== "unsupported" ? diagnostic.runtime : "";
  const provider = diagnostic?.provider && diagnostic.provider !== "pending" ? diagnostic.provider : "";
  const timings = [
    diagnostic?.firstBlockMs == null ? "" : `F ${diagnostic.firstBlockMs}ms`,
    diagnostic?.lastBlockMs == null ? "" : `B ${diagnostic.lastBlockMs}ms`,
    diagnostic?.p95BlockMs == null ? "" : `P95 ${diagnostic.p95BlockMs}ms`,
    diagnostic?.instantP95HopMs == null ? "" : `I95 ${diagnostic.instantP95HopMs}ms`,
  ].filter(Boolean);
  const error = Boolean(diagnostic?.lastError.trim() || (model.state === "error" && model.error.trim()));
  const text = [name, runtime, provider, ...timings, error ? "ERR" : ""].filter(Boolean).join(" · ");
  const title = [
    name,
    runtime ? `runtime: ${runtime}` : "",
    provider ? `provider: ${provider}` : "",
    diagnostic?.chunkBudgetMs ? `tile budget: ${diagnostic.chunkBudgetMs}ms` : "",
    diagnostic?.modelLoadMs == null ? "" : `model load: ${diagnostic.modelLoadMs}ms`,
    diagnostic?.firstBlockMs == null ? "" : `first block: ${diagnostic.firstBlockMs}ms`,
    diagnostic?.lastBlockMs == null ? "" : `last block: ${diagnostic.lastBlockMs}ms`,
    diagnostic?.p95BlockMs == null ? "" : `p95: ${diagnostic.p95BlockMs}ms`,
    diagnostic?.instantAvailable ? `instant ready Deck mask: ${diagnostic.instantReadyDecks}` : "",
    diagnostic?.instantPcmPreloadMs == null ? "" : `instant PCM preload: ${diagnostic.instantPcmPreloadMs}ms`,
    diagnostic?.instantFirstHopMs == null ? "" : `instant first hop: ${diagnostic.instantFirstHopMs}ms`,
    diagnostic?.instantLastHopMs == null ? "" : `instant last hop: ${diagnostic.instantLastHopMs}ms`,
    diagnostic?.instantP95HopMs == null ? "" : `instant p95: ${diagnostic.instantP95HopMs}ms`,
    diagnostic?.instantLateHops ? `instant late: ${diagnostic.instantLateHops}` : "",
    diagnostic?.instantFailures ? `instant failures: ${diagnostic.instantFailures}` : "",
    diagnostic?.refinementDeferred ? `refinement deferred: ${diagnostic.refinementDeferred}` : "",
    diagnostic?.processedChunks ? `processed: ${diagnostic.processedChunks}` : "",
    diagnostic?.lateChunks ? `late: ${diagnostic.lateChunks}` : "",
    diagnostic?.outputUnderruns ? `output gaps: ${diagnostic.outputUnderruns}` : "",
    diagnostic?.memoryErrors ? `memory errors: ${diagnostic.memoryErrors}` : "",
    diagnostic?.lastError.trim() ? `error: ${diagnostic.lastError.trim()}` : "",
    model.error.trim() ? `error: ${model.error.trim()}` : "",
  ].filter(Boolean).join("\n");
  return { text, title, error };
}

export function stemDeckLog(
  status: TrackStemStatus | null,
  model: StemModelStatus | null,
  displaying = false,
): StemDeckLog {
  const runtime = stemRuntimeLine(model);
  const job = stemJobLine(status, model, displaying);
  return {
    job,
    runtime: runtime.text,
    title: [job, runtime.title].filter(Boolean).join("\n"),
    error: runtime.error || (status?.state === "error") || (status?.phase === "error") || (model?.state === "error"),
  };
}
