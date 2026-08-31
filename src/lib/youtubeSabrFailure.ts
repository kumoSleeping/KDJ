/** Reduce an untrusted SABR/library error to a fixed renderer-safe category. */
export function sanitizeYoutubeSabrFailure(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  const status = message.match(/\b(?:HTTP|returned)\s+([45]\d{2})\b/i)?.[1];
  if (status) return `YouTube SABR 上游返回 HTTP ${status}`;
  if (/\b(?:abort(?:ed)?|cancel(?:led)?)\b|中止|取消/i.test(message)) {
    return "YouTube SABR 媒体会话已中止";
  }
  if (/\b(?:stall(?:ed)?|timeout|timed\s*out)\b|超时/i.test(message)) {
    return "YouTube SABR 媒体会话超时";
  }
  // Never reflect a GoogleVideo URL, proof, request body or upstream response into the renderer,
  // spool error state or console. A fixed category is sufficient for this one failed request.
  return "YouTube SABR 媒体会话失败";
}
