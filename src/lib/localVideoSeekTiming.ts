import type { PreparedLocalVideoSeek } from "./localVideoSeekBridge";

export type LocalVideoSeekResult = "activated" | "fallback" | "stale";

interface LocalVideoSeekActions {
  commitAudio(): void | Promise<void>;
  publishVideoSeek(): void;
  isCurrent(): boolean;
}

/**
 * Starts the audible transport edge synchronously, then lets the muted picture catch up.
 * The ordering is deliberate: video decode latency must never delay the Rust audio seek.
 */
export function coordinateLocalVideoSeek(
  prepareVideo: () => Promise<PreparedLocalVideoSeek | null>,
  actions: LocalVideoSeekActions,
): Promise<LocalVideoSeekResult> {
  const audioReady = actions.commitAudio();
  return Promise.resolve(audioReady)
    .then(() => {
      if (!actions.isCurrent()) return null;
      return prepareVideo();
    })
    .then((prepared) => {
      if (!actions.isCurrent()) {
        prepared?.cancel();
        return "stale" as const;
      }
      const activated = prepared?.activate() ?? false;
      actions.publishVideoSeek();
      return activated ? ("activated" as const) : ("fallback" as const);
    })
    .catch(() => {
      if (!actions.isCurrent()) return "stale" as const;
      actions.publishVideoSeek();
      return "fallback" as const;
    });
}
