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
