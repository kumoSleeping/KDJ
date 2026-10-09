export interface WheelSample {
  deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean;
}

/** Wheel delta in pixels. Shift turns a vertical-only wheel into a horizontal one. */
export function wheelPixels(sample: WheelSample, lineHeight: number, pageWidth: number, pageHeight: number): { x: number; y: number } {
  const unitX = sample.deltaMode === 1 ? lineHeight : sample.deltaMode === 2 ? pageWidth : 1;
  const unitY = sample.deltaMode === 1 ? lineHeight : sample.deltaMode === 2 ? pageHeight : 1;
  const x = sample.deltaX * unitX;
  const y = sample.deltaY * unitY;
  return sample.shiftKey && !x ? { x: y, y: 0 } : { x, y };
}
