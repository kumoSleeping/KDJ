import type { StemMode } from "../types";

/** The production separator is fixed and model-free; activation remains per Deck. */
export const STEM_RUNTIME_ID = "classical-redress-v1";
export const STEM_MODE: StemMode = "classical_two";

export function stemModeUsesTwoLanes(_mode: StemMode): boolean { return true; }

export function allStemMask(_mode?: StemMode): number {
  return 0b1100;
}

export function stemModeLaneKind(_mode?: StemMode): "two" {
  return "two";
}

export function stemRuntimeStatusLabel(id: string): string {
  return id === STEM_RUNTIME_ID ? "Redress" : id || "STEM";
}
