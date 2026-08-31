/** Keep development acceptance errors safe for the page, accessibility tree and JSON report. */
export function sanitizeYoutubePlaybackE2eError(reason: unknown): string {
  const value = reason instanceof Error ? reason.message : String(reason || "未知错误");
  return value
    .replace(/https?:\/\/\S+/gi, "[地址已隐藏]")
    .replace(
      /(?:authorization|visitor_data|po[_ -]?token|cookie|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
      "[敏感字段]=[已隐藏]",
    )
    .replace(/(?:authorization|visitor_data|po[_ -]?token|cookie|token)/gi, "[敏感字段]")
    .slice(0, 240);
}
