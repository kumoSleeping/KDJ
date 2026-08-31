/** QQ 草稿实测可保持为小图的实际像素尺寸；以后换规格只改这一处。 */
export const SHARE_ARTWORK_SIZE = 64;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 富文本只承载文字；封面必须作为独立 PNG 剪贴板项目，否则 QQ 发送时无法上传。 */
export function buildShareClipboardTextHtml(text: string): string {
  const lines = text.trim().split(/\r?\n/).map(escapeHtml);
  return lines.map((line) => `<div>${line || "<br>"}</div>`).join("");
}
