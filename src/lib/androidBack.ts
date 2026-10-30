/**
 * Android 的返回键：先收起最上面那一层，没有可收的再交给系统（应用退到后台，和系统
 * 默认的返回一样，不结束 Activity）。
 *
 * 应用里“收起最上面那一层”一直是 Esc：抽屉（Drawer.tsx）、菜单（ContextMenu）、浮窗、
 * 预览、任务气泡各自接 Esc，接住了就 preventDefault。返回键在这里翻译成一次 Esc：
 * 有谁接住，返回键就算用掉了。一次只收一层。
 *
 * 有了这个监听，Tauri 不再自己处理返回键，所以没人接住时由 MainActivity 的
 * `kdjAndroid.leaveToBackground()` 退到后台。
 */

const EDITABLE = "input, textarea, select, [contenteditable='true']";

/** 把一次返回键当作 Esc 交给最上面那一层；有谁收起了什么就返回 true。 */
export function closeTopLayer(): boolean {
  const active = document.activeElement;
  let target: Element = active instanceof HTMLElement ? active : document.body;
  // 输入框里的 Esc 归输入框自己（抽屉和气泡都让着它）；返回键要的是收起那一层，
  // 所以先让输入框交出焦点。软键盘开着时，第一下返回键由系统收键盘，到不了这里。
  if (target instanceof HTMLElement && target.closest(EDITABLE)) {
    target.blur();
    target = document.body;
  }
  const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(escape);
  return escape.defaultPrevented;
}

interface AndroidActivity {
  leaveToBackground?(): void;
}

export async function installAndroidBack(): Promise<void> {
  if (window.kdj?.platform !== "android" || !window.__TAURI_INTERNALS__) return;
  const { onBackButtonPress } = await import("@tauri-apps/api/app");
  await onBackButtonPress(() => {
    if (closeTopLayer()) return;
    (window as unknown as { kdjAndroid?: AndroidActivity }).kdjAndroid?.leaveToBackground?.();
  });
}
