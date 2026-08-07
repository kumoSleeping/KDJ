/**
 * 文件夹树刷新时，只自动展开本次运行里第一次出现的曲库根目录。
 *
 * `expanded` 同时保存根目录和子目录的用户状态；刷新只按根路径判断“新增”，
 * 不能用“不在 expanded 里”判断，否则用户主动收起的根会被当成新根再次展开。
 */
export function expandNewRootPaths(
  expanded: Set<string>,
  seenRootPaths: ReadonlySet<string>,
  rootPaths: readonly string[],
): Set<string> {
  let next = expanded;
  for (const path of rootPaths) {
    if (seenRootPaths.has(path) || next.has(path)) continue;
    if (next === expanded) next = new Set(expanded);
    next.add(path);
  }
  return next;
}
