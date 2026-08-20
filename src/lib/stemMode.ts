import type { StemMode } from "../types";

/** The production separator is fixed; activation is per Deck, not a global model choice. */
export const STEM_MODE: StemMode = "mobile_net_two";

export function stemModeUsesTwoLanes(mode: StemMode): boolean {
  return mode === "mobile_net_two";
}

export function allStemMask(mode: StemMode): number {
  void mode;
  return 0b1100;
}

export function stemModeLaneKind(mode: StemMode): "none" | "two" {
  if (stemModeUsesTwoLanes(mode)) return "two";
  return "none";
}

export function stemModeLabel(mode: StemMode): string {
  switch (mode) {
    case "mobile_net_two":
      return "ByteDance-MobileNet-2-FP32";
    default:
      return "无";
  }
}

export function stemModelStatusLabel(id: string): string {
  if (id.startsWith("bytedance-mobilenet-")) return "ByteDance-MobileNet-2-FP32";
  return id || "STEM";
}
