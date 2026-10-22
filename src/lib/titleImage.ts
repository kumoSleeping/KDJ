/**
 * A title (字幕) of a `.kdjv` 2 project is a picture of its text over the whole frame
 * (docs/kdjv.md, "格式 2"): drawn here once, kept by the server (`/api/kdjv/title-image`), and then
 * played, previewed and rendered like any image clip. The frame is 1920×1080; the text sits
 * centred across it, its middle at `y` of the height.
 */
import type { LaneTitle } from "./lanes";

export const TITLE_FRAME = { width: 1920, height: 1080 };
export const TITLE_DEFAULTS = { size: 64, color: "#ffffff", outline: true, y: 0.85 } as const;

export type TitleLook = Pick<LaneTitle, "text"> & Partial<Pick<LaneTitle, "size" | "color" | "outline" | "y">>;

/** The title drawn as a PNG, base64 without its `data:` head. */
export function drawTitle(look: TitleLook): string {
  const canvas = document.createElement("canvas");
  canvas.width = TITLE_FRAME.width;
  canvas.height = TITLE_FRAME.height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("无法画字幕");
  const size = look.size ?? TITLE_DEFAULTS.size;
  const lines = look.text.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 6);
  g.font = `600 ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  const lineHeight = size * 1.3;
  const middle = (look.y ?? TITLE_DEFAULTS.y) * TITLE_FRAME.height;
  lines.forEach((line, n) => {
    const y = middle + (n - (lines.length - 1) / 2) * lineHeight;
    if (look.outline ?? TITLE_DEFAULTS.outline) {
      g.lineWidth = Math.max(2, size / 8);
      g.strokeStyle = "rgba(0, 0, 0, 0.85)";
      g.strokeText(line, TITLE_FRAME.width / 2, y, TITLE_FRAME.width * 0.92);
    }
    g.fillStyle = look.color ?? TITLE_DEFAULTS.color;
    g.fillText(line, TITLE_FRAME.width / 2, y, TITLE_FRAME.width * 0.92);
  });
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
