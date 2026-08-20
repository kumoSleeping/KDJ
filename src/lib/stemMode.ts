import type { StemMode } from "../types";

export function stemModeUsesTwoLanes(mode: StemMode): boolean {
  return mode === "mobile_net_two";
}

export function stemModeUsesFourLanes(mode: StemMode): boolean {
  return mode === "four";
}

export function allStemMask(mode: StemMode): number {
  return stemModeUsesTwoLanes(mode) ? 0b1100 : 0b1111;
}

export function stemModeLaneKind(mode: StemMode): "none" | "two" | "four" {
  if (stemModeUsesTwoLanes(mode)) return "two";
  if (stemModeUsesFourLanes(mode)) return "four";
  return "none";
}

export function stemModeLabel(mode: StemMode): string {
  switch (mode) {
    case "four":
      return "Spleeter-4-FP16";
    case "mobile_net_two":
      return "ByteDance-MobileNet-2-FP32";
    default:
      return "无";
  }
}

export function stemModelStatusLabel(id: string): string {
  if (id.startsWith("bytedance-mobilenet-")) return "ByteDance-MobileNet-2-FP32";
  if (id.startsWith("spleeter4-")) return "Spleeter-4-FP16";
  return id || "STEM";
}
