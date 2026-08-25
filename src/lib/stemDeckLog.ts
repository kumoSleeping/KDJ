export const KNOB_CENTER_RATIO = 0.01;

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
