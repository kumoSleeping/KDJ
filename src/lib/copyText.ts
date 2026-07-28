/**
 * 界面默认禁划选；需要把某一段字交给系统剪贴板时走这里（右键菜单）。
 * 不依赖当前文字选区，也不触发 document 的 copy 事件拦截。
 */
export async function copyText(text: string): Promise<void> {
  const value = text.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    /* 权限被拒或不安全上下文：退回 execCommand */
  }
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}
