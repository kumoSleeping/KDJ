/**
 * 主界面字号是本机显示偏好，不随下载、帐号等服务端配置同步。
 *
 * 独立悬浮歌词已有自己的字号控制，因此不会调用这里的 apply 函数。
 */
export const APP_FONT_SCALE_MIN = 75;
export const APP_FONT_SCALE_MAX = 150;
/** 滑条显示四个边界刻度，实际可按 1% 微调。 */
export const APP_FONT_SCALE_TICKS = [75, 100, 125, 150] as const;

export type AppFontScale = number;

export const DEFAULT_APP_FONT_SCALE: AppFontScale = 106;

const STORAGE_KEY = "kd-app-font-scale";

export function normalizeAppFontScale(value: unknown): AppFontScale {
  const scale = typeof value === "number" ? value : Number(value);
  return Number.isInteger(scale) && scale >= APP_FONT_SCALE_MIN && scale <= APP_FONT_SCALE_MAX
    ? scale
    : DEFAULT_APP_FONT_SCALE;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readAppFontScale(): AppFontScale {
  try {
    return normalizeAppFontScale(storage()?.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_APP_FONT_SCALE;
  }
}

export function applyAppFontScale(scale: AppFontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = `${scale}%`;
}

export function setAppFontScale(scale: AppFontScale): void {
  const next = normalizeAppFontScale(scale);
  applyAppFontScale(next);
  try {
    storage()?.setItem(STORAGE_KEY, String(next));
  } catch {
    // 存储不可用时仍让本次会话立刻生效。
  }
}
