import type { FileOp, LibraryPasteMode, Settings } from "../types";

/** 设置里没写或旧配置时，粘贴默认走链接。 */
export function libraryPasteMode(settings: Settings | null | undefined): LibraryPasteMode {
  return settings?.library_paste === "copy" ? "copy" : "link";
}

/**
 * 解析一次曲库落盘操作：
 * - `forceMove`（Option/Alt）：始终移动
 * - 剪切板是 move（Cmd/Ctrl+X）：移动
 * - 否则用设置里的链接 / 复制
 */
export function resolveLibraryPasteOp(options: {
  settings: Settings | null | undefined;
  forceMove?: boolean;
  clipboardOp?: FileOp | null;
}): FileOp {
  if (options.forceMove) return "move";
  if (options.clipboardOp === "move") return "move";
  return libraryPasteMode(options.settings);
}
