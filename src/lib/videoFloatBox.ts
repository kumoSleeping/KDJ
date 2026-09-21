export const VIDEO_FLOAT_MIN_WIDTH = 240;
export const VIDEO_FLOAT_MARGIN = 8;

export interface VideoFloatBox {
  x: number;
  y: number;
  w: number;
}

export function videoFloatHeight(width: number, ratio = 16 / 9): number {
  return width / ratio;
}

export function maxVideoFloatWidth(
  viewportWidth: number,
  viewportHeight: number,
  ratio = 16 / 9,
): number {
  const availableWidth = Math.max(1, viewportWidth - VIDEO_FLOAT_MARGIN * 2);
  const availableHeight = Math.max(1, viewportHeight - VIDEO_FLOAT_MARGIN * 2);
  return Math.min(availableWidth, availableHeight * ratio);
}

export function clampVideoFloatWidth(
  width: number,
  viewportWidth: number,
  viewportHeight: number,
  ratio = 16 / 9,
): number {
  const maximum = maxVideoFloatWidth(viewportWidth, viewportHeight, ratio);
  const minimum = Math.min(VIDEO_FLOAT_MIN_WIDTH, maximum);
  return Math.min(maximum, Math.max(minimum, width));
}

export function clampVideoFloatBox(
  box: VideoFloatBox,
  viewportWidth: number,
  viewportHeight: number,
  ratio = 16 / 9,
): VideoFloatBox {
  const width = clampVideoFloatWidth(box.w, viewportWidth, viewportHeight, ratio);
  const height = videoFloatHeight(width, ratio);
  const maxX = Math.max(VIDEO_FLOAT_MARGIN, viewportWidth - width - VIDEO_FLOAT_MARGIN);
  const maxY = Math.max(VIDEO_FLOAT_MARGIN, viewportHeight - height - VIDEO_FLOAT_MARGIN);
  return {
    w: width,
    x: Math.min(maxX, Math.max(VIDEO_FLOAT_MARGIN, box.x)),
    y: Math.min(maxY, Math.max(VIDEO_FLOAT_MARGIN, box.y)),
  };
}
