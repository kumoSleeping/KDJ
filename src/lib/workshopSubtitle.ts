import type { WorkshopSubtitle } from "../types/workshop";

export const subtitleFonts = {
  system: {label: "系统字体", family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'},
  sans: {label: "无衬线", family: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif'},
  serif: {label: "衬线", family: 'Georgia, "Songti SC", SimSun, serif'},
  mono: {label: "等宽", family: 'Menlo, Consolas, monospace'},
} as const;
export const defaultSubtitle: WorkshopSubtitle = {
  text: "", font: "system", font_size: 64, bold: false, italic: false,
  color: "#ffffff", outline_color: "#000000", outline_width: 2, align: "center",
};
export function subtitleError(s: WorkshopSubtitle): string {
  if (!s.text.trim()) return "请输入字幕内容";
  if (s.text.length > 2000 || s.text.split("\n").length > 10) return "字幕最多 2000 字、10 行";
  if (!(s.font in subtitleFonts) || !["left", "center", "right"].includes(s.align)
    || !Number.isFinite(s.font_size) || s.font_size < 12 || s.font_size > 240
    || !Number.isFinite(s.outline_width) || s.outline_width < 0 || s.outline_width > 12
    || ![s.color, s.outline_color].every(v => /^#[0-9a-f]{6}$/i.test(v))) return "字幕参数无效";
  return "";
}
/** Render once using OS fonts; preview and FFmpeg consume these exact RGBA pixels. */
export async function rasterizeSubtitle(s: WorkshopSubtitle): Promise<Blob> {
  const error = subtitleError(s);
  if (error) throw new Error(error);
  const font = `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${s.font_size}px ${subtitleFonts[s.font].family}`;
  await document.fonts.load(font, s.text);
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法生成字幕画面");
  ctx.font = font;
  const lines = s.text.replace(/\r\n?/g, "\n").split("\n");
  const metrics = lines.map(line => ctx.measureText(line));
  const pad = Math.ceil(s.font_size * .3 + s.outline_width + 2);
  const lineHeight = s.font_size * 1.35;
  const textWidth = Math.max(...metrics.map(m => Math.max(m.width, m.actualBoundingBoxLeft + m.actualBoundingBoxRight)));
  canvas.width = Math.max(384, Math.ceil(textWidth + pad * 2));
  canvas.height = Math.max(128, Math.ceil(lines.length * lineHeight + pad * 2));
  if (canvas.width > 4096 || canvas.height > 4096 || canvas.width * canvas.height > 8_388_608)
    throw new Error("字幕画面过大，请换行或减小字号");
  ctx.font = font;
  ctx.textAlign = s.align;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = s.color;
  ctx.strokeStyle = s.outline_color;
  ctx.lineWidth = s.outline_width * 2;
  ctx.lineJoin = "round";
  const x = s.align === "left" ? pad : s.align === "right" ? canvas.width - pad : canvas.width / 2;
  const top = (canvas.height - lines.length * lineHeight) / 2;
  lines.forEach((line, i) => {
    const y = top + s.font_size + i * lineHeight;
    if (s.outline_width) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法生成字幕画面")), "image/png"));
  if (png.size > 2 * 1024 * 1024) throw new Error("字幕画面过大，请减少文字或字号");
  return png;
}
