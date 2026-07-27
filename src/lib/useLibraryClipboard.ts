import { useEffect } from "react";
import { api } from "./api";
import { useLibraryStore } from "../stores/libraryStore";
import { useQueueStore } from "../stores/queueStore";

/**
 * 曲目表的复制 / 剪切 / 粘贴快捷键。
 *
 * 为什么要有它：文件夹栏底下那两颗「新建 / 粘贴」按钮删掉之后，
 * `copyToClipboard` 在界面上**一个入口都不剩**了——store 里的能力还在，
 * 用户却碰不到。右键菜单补了「粘贴」，复制/剪切只能走键盘。
 *
 * Mac 用 Cmd、其它平台用 Ctrl，两个都认（`metaKey || ctrlKey`）——
 * 判平台的话，在 Mac 上跑的 Windows 键盘、以及浏览器预览都会判错。
 *
 * 正在输入时一律不接管：搜索框里按 Cmd+C 要复制的是选中的文字，
 * 不是曲目。`isEditable` 把 input/textarea/contenteditable 全挡掉。
 */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

export function useLibraryClipboard(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (isEditable(event.target)) return;
      const store = useLibraryStore.getState();
      const key = event.key.toLowerCase();

      if (key === "c" || key === "x") {
        // 页面文字选区优先于“曲目剪贴板”。否则用户明明框住了标题/路径/错误
        // 文案，Cmd+C 却被 preventDefault 后悄悄复制成曲目操作，体感就是全站
        // 文字都不能复制。没有文字选区时才把快捷键解释为复制/剪切曲目。
        const textSelection = window.getSelection();
        if (textSelection && !textSelection.isCollapsed && textSelection.toString()) return;
        // 没选中就什么都不做——别把一个空剪贴板盖掉用户上一次复制的内容
        if (store.selectedIds.length === 0) return;
        event.preventDefault();
        store.copyToClipboard(key === "x" ? "move" : "link");
        return;
      }
      if (key === "v") {
        if (store.queueView && store.clipboard) {
          event.preventDefault();
          const ids = store.clipboard.ids;
          void Promise.allSettled(ids.map((id) => api.track(id))).then((results) => {
            const tracks = results.flatMap((result) =>
              result.status === "fulfilled" ? [result.value] : [],
            );
            if (tracks.length > 0) useQueueStore.getState().add(tracks);
          });
          return;
        }
        // 粘到"当前正在看的那个文件夹"。没选文件夹时无处可粘，
        // 静默忽略比弹一句"请先选文件夹"更省事——用户下一步自然会去点一个
        const dest = store.filter.folder;
        if (!store.clipboard || !dest) return;
        event.preventDefault();
        void store.paste(dest);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
