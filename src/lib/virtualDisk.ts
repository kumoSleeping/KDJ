export const VIRTUAL_DISK_SIZE_OPTIONS = [1, 4, 8, 16, 32, 64] as const;
export const VIRTUAL_DISK_MIN_SIZE_GIB = 1;
export const VIRTUAL_DISK_MAX_SIZE_GIB = 64;
export const VIRTUAL_DISK_DEFAULT_NAME = "KDJ";
export const VIRTUAL_DISK_NAME_MAX_LENGTH = 11;
export const VIRTUAL_DISK_RESERVE_BYTES = 256 * 1024 ** 2;

const MIB = 1024 ** 2;
const SIZE_INPUT = /^\d+(?:\.\d)?$/;
const INVALID_VOLUME_NAME = /["*/:<>?\\|\u0000-\u001f\u007f]/;

export function virtualDiskSizeGib(totalBytes: number): number {
  return Math.max(VIRTUAL_DISK_MIN_SIZE_GIB, Math.ceil(Math.max(0, totalBytes) / MIB) / 1024);
}

export function virtualDiskGrowthOptions(totalBytes: number): number[] {
  const current = virtualDiskSizeGib(totalBytes);
  return VIRTUAL_DISK_SIZE_OPTIONS.filter((size) => size > current);
}

export function virtualDiskChangeOptions(currentBytes: number, minimumBytes: number): number[] {
  const currentMib = Math.ceil(Math.max(0, currentBytes) / MIB);
  const minimumMib = Math.ceil(Math.max(0, minimumBytes) / MIB);
  return VIRTUAL_DISK_SIZE_OPTIONS.filter((size) => {
    const sizeMib = virtualDiskSizeMib(size);
    return sizeMib !== currentMib && sizeMib >= minimumMib;
  });
}

export function defaultVirtualDiskChangeSizeGib(
  currentBytes: number,
  options: readonly number[],
): number {
  const current = virtualDiskSizeGib(currentBytes);
  return options.find((size) => size > current)
    ?? options.at(-1)
    ?? current;
}

/** macOS 与 Windows 的共同创建粒度是 1 MiB。 */
export function virtualDiskSizeMib(sizeGib: number): number {
  return Math.round(sizeGib * 1024);
}

export function parseVirtualDiskSizeGib(input: string): number | null {
  const value = input.trim();
  if (!SIZE_INPUT.test(value)) return null;
  const size = Number(value);
  return Number.isFinite(size) ? size : null;
}

export function virtualDiskSizeInputError(
  input: string,
  minimumBytes = 0,
): string {
  const value = input.trim();
  if (!value) return "请输入容量";
  if (!SIZE_INPUT.test(value)) return "容量最多保留 1 位小数";
  const size = Number(value);
  if (size < VIRTUAL_DISK_MIN_SIZE_GIB || size > VIRTUAL_DISK_MAX_SIZE_GIB) {
    return `容量必须在 ${VIRTUAL_DISK_MIN_SIZE_GIB}–${VIRTUAL_DISK_MAX_SIZE_GIB} GB 之间`;
  }
  const minimumMib = Math.ceil(Math.max(0, minimumBytes) / MIB);
  if (minimumMib > 0 && virtualDiskSizeMib(size) < minimumMib) {
    return `当前数据至少需要 ${(minimumMib / 1024).toFixed(1)} GB`;
  }
  return "";
}

export function normalizeVirtualDiskName(input: string): string {
  return input.trim();
}

export function virtualDiskNameInputError(input: string): string {
  const name = normalizeVirtualDiskName(input);
  if (!name) return "请输入磁盘名称";
  if (name.length > VIRTUAL_DISK_NAME_MAX_LENGTH) {
    return `磁盘名称不能超过 ${VIRTUAL_DISK_NAME_MAX_LENGTH} 个字符`;
  }
  if (INVALID_VOLUME_NAME.test(name)) {
    return '磁盘名称不能包含 " * / : < > ? \\ | 或控制字符';
  }
  return "";
}
