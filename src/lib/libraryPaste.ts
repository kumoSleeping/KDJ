import type { FileOp } from "../types";

/**
 * 解析一次曲库落盘操作：
 * - `forceMove`（Option/Alt）：始终移动
 * - 剪切板是 move（Cmd/Ctrl+X）：移动
 * - 其它本地文件夹分类操作：复制一份真实文件
 *
 * 不再提供链接模式：文件夹里的每个条目都是独立的本地文件。
 */
export function resolveLibraryPasteOp(options: {
  forceMove?: boolean;
  clipboardOp?: FileOp | null;
}): FileOp {
  if (options.forceMove) return "move";
  if (options.clipboardOp === "move") return "move";
  return "copy";
}
