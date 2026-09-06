import type { PreparedLocalVideoSeek } from "./localVideoSeekBridge";

export type LocalVideoSeekResult = "activated" | "fallback" | "stale" | "canceled";

interface LocalVideoSeekActions {
  /** false = the native landing failed/timed out; never decode or publish a guessed target. */
  commitAudio(): void | boolean | Promise<void | boolean>;
  publishVideoSeek(): void;
  isCurrent(): boolean;
  cancelVideo?(): void;
}

/** Audio owns the landing; video decode and presentation follow that accepted source clock. */
export async function coordinateLocalVideoSeek(
  prepareVideo: () => Promise<PreparedLocalVideoSeek | null>,
  actions: LocalVideoSeekActions,
): Promise<LocalVideoSeekResult> {
  try {
    const committed = await actions.commitAudio();
    if (!actions.isCurrent()) return "stale";
    if (committed === false) {
      actions.cancelVideo?.();
      return "canceled";
    }
  } catch {
    if (!actions.isCurrent()) return "stale";
    actions.cancelVideo?.();
    return "canceled";
  }

  let prepared: PreparedLocalVideoSeek | null = null;
  try {
    prepared = await prepareVideo();
    if (!actions.isCurrent()) { prepared?.cancel(); return "stale"; }
    if (prepared?.activate()) return "activated";
  } catch {
    if (!actions.isCurrent()) { prepared?.cancel(); return "stale"; }
  }
  // Only decode failure falls back. A successful slot already follows the device clock;
  // publishing the original gesture target would rewind and flush its freshly decoded frame.
  actions.cancelVideo?.();
  actions.publishVideoSeek();
  return "fallback";
}
