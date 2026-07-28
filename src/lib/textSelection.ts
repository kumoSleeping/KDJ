/**
 * 点击式列表也要允许框选复制。鼠标拖完文字后浏览器仍会发 click；如果不挡，
 * 那次 click 会顺手播放/展开/切目录，看起来像“文字根本不能选”。
 */
export function hasTextSelectionWithin(container: Node): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  return Boolean(
    (selection.anchorNode && container.contains(selection.anchorNode)) ||
      (selection.focusNode && container.contains(selection.focusNode)),
  );
}

/** 拖拽起手时清掉选区，避免「拖一下变成全选文本」盖过真正的拖动。 */
export function clearTextSelection(): void {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}
