export const VIRTUAL_DISK_SIZE_OPTIONS = [1, 4, 8, 16, 32, 64] as const;

const GIB = 1024 ** 3;

export function virtualDiskSizeGib(totalBytes: number): number {
  return Math.max(1, Math.ceil(Math.max(0, totalBytes) / GIB));
}

export function virtualDiskGrowthOptions(totalBytes: number): number[] {
  const current = virtualDiskSizeGib(totalBytes);
  return VIRTUAL_DISK_SIZE_OPTIONS.filter((size) => size > current);
}
