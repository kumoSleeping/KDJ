/**
 * 界面默认禁划选；需要把某一段字交给系统剪贴板时走这里（右键菜单）。
 * 不依赖当前文字选区，也不触发 document 的 copy 事件拦截。
 */
export function copyTextSelection(text: string): boolean {
  const value = text.trim();
  return copyTextSelectionValue(value);
}

function copyTextSelectionValue(value: string): boolean {
  if (
    !value
    || typeof document === "undefined"
    || !document.body
    || typeof document.execCommand !== "function"
  ) {
    return false;
  }

  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  // App 会拦截列表上的普通 copy 事件。这个临时输入框自己消费事件，
  // 避免右键菜单按钮仍然是 activeElement 时把程序化复制一起拦掉。
  textarea.addEventListener("copy", (event) => event.stopPropagation(), { once: true });
  document.body.appendChild(textarea);

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

export async function copyText(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    /* 权限被拒或不安全上下文：退回 execCommand */
  }
  return copyTextSelectionValue(value);
}
