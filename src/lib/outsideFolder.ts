/** 侧栏「其他」：落在所有曲库根目录之外的曲目（非真实路径）。 */
export const OUTSIDE_FOLDER = "__kd_outside__";

export function isOutsideFolder(folder: string): boolean {
  return folder === OUTSIDE_FOLDER;
}
