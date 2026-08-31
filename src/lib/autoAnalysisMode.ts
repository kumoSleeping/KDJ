import type { AutoAnalysisMode, Settings } from "../types";

/** Old servers/settings only exposed `auto_analyze`; treat enabled legacy state as Light. */
export function resolveAutoAnalysisMode(
  settings: Pick<Settings, "auto_analyze"> & Partial<Pick<Settings, "auto_analysis_mode">> | null,
): AutoAnalysisMode {
  if (!settings) return "light";
  if (!settings.auto_analyze) return "paused";
  return settings.auto_analysis_mode === "full" ? "full" : "light";
}

/** User-requested click order: Light → Full → Paused → Light. */
export function nextAutoAnalysisMode(mode: AutoAnalysisMode): AutoAnalysisMode {
  if (mode === "light") return "full";
  if (mode === "full") return "paused";
  return "light";
}
