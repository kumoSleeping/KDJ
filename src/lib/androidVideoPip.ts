/** Android PiP presents the Activity, not a detached HTMLVideoElement. Keep the shared video
 * host/clock mounted; only the Activity's presentation changes. */
interface AndroidVideoBridge {
  canVideoPip(): boolean;
  configureVideoPip(active: boolean, playing: boolean, ratio: number): void;
  enterVideoPip(): void;
}
function native(): AndroidVideoBridge | undefined {
  return (window as unknown as { kdjAndroid?: AndroidVideoBridge }).kdjAndroid;
}
export function canAndroidVideoPip(): boolean { return Boolean(native()?.canVideoPip?.()); }
export function configureAndroidVideoPip(active: boolean, playing: boolean, ratio: number): void {
  native()?.configureVideoPip?.(active, playing, ratio || 16 / 9);
}
export function enterAndroidVideoPip(): Promise<boolean> {
  if (!canAndroidVideoPip()) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (entered: boolean) => {
      window.clearTimeout(timer);
      window.removeEventListener("kdj:android-pip", changed);
      resolve(entered);
    };
    const changed = (event: Event) => finish(Boolean((event as CustomEvent<boolean>).detail));
    const timer = window.setTimeout(() => finish(false), 3000);
    window.addEventListener("kdj:android-pip", changed);
    native()!.enterVideoPip();
  });
}
