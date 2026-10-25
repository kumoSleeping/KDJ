/** Product capabilities, not codec guesses. Keep mobile omissions out of actions and jobs. */
export function mediaProductionAvailable(platform = typeof window === "undefined" ? "browser" : window.kdj?.platform): boolean {
  return platform !== "android" && platform !== "ios";
}

export function androidPlatform(): boolean {
  return typeof window !== "undefined" && window.kdj?.platform === "android";
}
