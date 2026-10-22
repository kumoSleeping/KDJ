/**
 * What the report's description starts with: three prompts the user fills in after the colon.
 * The problem is filled in already when the report was asked for from an error's notice or the
 * crash page. A prompt left as it was is not sent (`reportNote`).
 */
export const REPORT_PROMPTS = [
  "做了什么操作：",
  "遇到了什么问题：",
  "当时的环境（网络 / 代理、外接设备、曲库在移动硬盘上等，可不写）：",
] as const;

export function reportTemplate(problem = ""): string {
  const filled = problem.replace(/\s+/g, " ").trim().slice(0, 600);
  return REPORT_PROMPTS.map((prompt, index) => index === 1 ? `${prompt}${filled}` : prompt).join("\n");
}

/** The description as it is sent: prompts with nothing after them are left out. */
export function reportNote(text: string): string {
  return text.split("\n")
    .filter(line => !REPORT_PROMPTS.some(prompt => line.trim() === prompt || line.trim() === prompt.slice(0, -1)))
    .join("\n")
    .trim();
}
