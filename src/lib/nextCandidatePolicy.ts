import type { PlayMode } from "./playMode";

export type NextCandidateRoute =
  | "stream-successor"
  | "harmonic-profile"
  | "repeat-current"
  | "local-start"
  | "order"
  | "shuffle"
  | "harmonic";

export interface PredictionPolicySnapshot {
  epoch: number;
  baseTrackId: number;
  mode: PlayMode;
  scope: string;
  folder: string;
  sort: string;
  order: string;
}

/** Old UI artwork may stay visible while recomputing, but it cannot be consumed under new rules. */
export function samePredictionPolicy(
  generated: PredictionPolicySnapshot,
  current: PredictionPolicySnapshot,
): boolean {
  return (
    generated.epoch === current.epoch &&
    generated.baseTrackId === current.baseTrackId &&
    generated.mode === current.mode &&
    generated.scope === current.scope &&
    generated.folder === current.folder &&
    generated.sort === current.sort &&
    generated.order === current.order
  );
}

/**
 * Selects the candidate source after explicit queue/preferred overrides have been handled.
 * A finite online search chain must fall back into the local library instead of leaving the
 * second deck empty when its final item is reached.
 */
export function nextCandidateRoute(
  currentIsStream: boolean,
  hasStreamSuccessor: boolean,
  mode: PlayMode,
  manual: boolean,
): NextCandidateRoute {
  if (mode === "one" && !manual) return "repeat-current";
  if (currentIsStream && hasStreamSuccessor) return "stream-successor";
  if (currentIsStream && mode === "harmonic") return "harmonic-profile";
  if (currentIsStream && (mode === "order" || mode === "one")) {
    return "local-start";
  }
  return mode === "one" ? "harmonic" : mode;
}
