export interface PreparedLocalVideoSeek {
  readonly target: number;
  /** Returns false when a newer seek or a session change made this preparation stale. */
  activate(): boolean;
  cancel(): void;
}

export interface LocalVideoSeekPresenter {
  preview(target: number): void;
  hold(): void;
  prepare(target: number): Promise<PreparedLocalVideoSeek | null>;
  cancel(): void;
}

interface RegisteredPresenter {
  token: symbol;
  presenter: LocalVideoSeekPresenter;
}

const presenters = new Map<number, RegisteredPresenter>();

/** The visible local-video surface registers the one decoder pair that may prepare seeks. */
export function registerLocalVideoSeekPresenter(
  trackId: number,
  presenter: LocalVideoSeekPresenter,
): () => void {
  const token = Symbol(`local-video-seek:${trackId}`);
  presenters.set(trackId, { token, presenter });
  return () => {
    if (presenters.get(trackId)?.token === token) presenters.delete(trackId);
  };
}

export function previewLocalVideoSeek(trackId: number, target: number): boolean {
  const registered = presenters.get(trackId);
  if (!registered || !Number.isFinite(target)) return false;
  registered.presenter.preview(Math.max(0, target));
  return true;
}

export function cancelLocalVideoSeekPreview(trackId: number): void {
  presenters.get(trackId)?.presenter.cancel();
}

export function hasLocalVideoSeekPresenter(trackId: number): boolean {
  return presenters.has(trackId);
}

/** Pins the target UI while audio gets an uncontended head start, without starting video I/O. */
export function holdLocalVideoSeekPosition(trackId: number): void {
  presenters.get(trackId)?.presenter.hold();
}

/** null = no visible dual-video presenter, so the caller should use its existing seek path. */
export function prepareLocalVideoSeek(
  trackId: number,
  target: number,
): Promise<PreparedLocalVideoSeek | null> | null {
  const registered = presenters.get(trackId);
  if (!registered || !Number.isFinite(target)) return null;
  return registered.presenter.prepare(Math.max(0, target));
}
