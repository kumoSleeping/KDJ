export const ONE_LIBRARY_COVER_TARGET_ATTR = "data-kd-onelibrary-cover-target";
export const ONE_LIBRARY_COVER_DEVICE_ATTR = "data-kd-onelibrary-cover-device";
export const ONE_LIBRARY_COVER_CONTENT_ATTR = "data-kd-onelibrary-cover-content";
export const ONE_LIBRARY_COVER_DROP_EVENT = "kd:onelibrary-cover-drop";

export type OneLibraryCoverSource =
  | { kind: "local"; ids: number[] }
  | { kind: "onelibrary"; devicePath: string; ids: number[] };

export interface OneLibraryCoverDropDetail {
  source: OneLibraryCoverSource;
  targetDevicePath: string;
  targetContentId: number;
}

export function dispatchOneLibraryCoverDrop(detail: OneLibraryCoverDropDetail): void {
  if (!detail.targetDevicePath || !Number.isFinite(detail.targetContentId) || detail.source.ids.length === 0) return;
  window.dispatchEvent(new CustomEvent<OneLibraryCoverDropDetail>(ONE_LIBRARY_COVER_DROP_EVENT, { detail }));
}
