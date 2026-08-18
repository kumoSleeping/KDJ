export type WorkMode = "manager" | "dj";

export const WORK_MODE_STORAGE_KEY = "kd-work-mode-v1";

export function parseWorkMode(value: unknown): WorkMode {
  return value === "dj" ? "dj" : "manager";
}

/**
 * Dual-deck session: full DJ work mode, or manager with the Performance panel
 * popped open. The library chrome can stay in manager; playback must not.
 */
export function isDualDeckSession(mode: WorkMode, performanceOpen = false): boolean {
  return mode === "dj" || performanceOpen;
}

/** Manager has one canonical track owner; a dual-deck session has two independent Decks. */
export function shouldReconcileSingleTrackOwner(mode: WorkMode, performanceOpen = false): boolean {
  return !isDualDeckSession(mode, performanceOpen);
}

/** Global play/pause owns one front track only; Performance uses side-addressed Deck commands. */
export function shouldDriveGlobalTransport(mode: WorkMode, performanceOpen = false): boolean {
  return !isDualDeckSession(mode, performanceOpen);
}

export function readWorkMode(storage: Pick<Storage, "getItem"> = window.localStorage): WorkMode {
  try {
    return parseWorkMode(storage.getItem(WORK_MODE_STORAGE_KEY));
  } catch {
    return "manager";
  }
}

export function writeWorkMode(
  mode: WorkMode,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(WORK_MODE_STORAGE_KEY, mode);
  } catch {
    // 隐私模式或系统存储不可用时仍允许本次会话切换。
  }
}
