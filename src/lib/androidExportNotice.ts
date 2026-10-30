/** Android keeps a visualizer export alive in the background with a foreground service
 * (`ExportForeground` in the native-audio plugin): its notification shows this progress,
 * and the WebView is not paused while the service runs. Elsewhere these do nothing. */
interface AndroidExportBridge {
  exportProgress(title: string, fraction: number, status: string): void;
  exportFinished(title: string, ok: boolean, message: string, uri: string): void;
  exportIdle(): void;
}
function native(): AndroidExportBridge | undefined {
  return (window as unknown as { kdjAndroid?: Partial<AndroidExportBridge> }).kdjAndroid?.exportIdle
    ? (window as unknown as { kdjAndroid: AndroidExportBridge }).kdjAndroid : undefined;
}
let reported = { at: -Infinity, title: "" };
/** One notification update a second (Android drops faster ones); a new task's at once. */
export function reportAndroidExport(title: string, fraction: number, status: string): void {
  const bridge = native(), now = performance.now();
  if (!bridge || now - reported.at < 1000 && title === reported.title) return;
  reported = { at: now, title };
  bridge.exportProgress(title, Number.isFinite(fraction) ? fraction : 0, status);
}
export function finishAndroidExport(title: string, ok: boolean, message: string, uri = ""): void {
  native()?.exportFinished(title, ok, message, uri);
}
export function idleAndroidExport(): void {
  reported = { at: -Infinity, title: "" };
  native()?.exportIdle();
}
