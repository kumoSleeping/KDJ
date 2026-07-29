import { useEffect, useRef } from "react";
import { isEditable } from "./useLibraryClipboard";

/** 普通快进/快退步长（秒）。和多数桌面播放器的默认一致。 */
const SEEK_STEP = 5;
/** 按住 Shift 时的大步（秒）。 */
const SEEK_STEP_LARGE = 15;
/** 方向键调音量的步进。 */
const VOLUME_STEP = 0.05;

export interface PlayerShortcutHandlers {
  togglePlay(): void;
  /** 相对当前位置跳转；正数快进，负数快退。 */
  seekBy(delta: number): void;
  nudgeVolume(delta: number): void;
  goNext(): void;
  goPrevious(): void;
}

/**
 * 播放器全局快捷键。
 *
 * 挂在 PlayerBar：走带状态和引擎都在那里，这里只负责键位映射。
 * 输入框 / 下拉 / contenteditable 里一律不拦——搜索、改文件名时按空格要出空格。
 *
 * 键位尽量贴近常见播放器（PotPlayer / VLC / 网页视频）：
 * - 空格 / 媒体键：播放暂停
 * - ← → / 小键盘 4·6：快退快进 5 秒；Shift 加持变 15 秒
 * - ↑ ↓：音量
 * - 媒体上一曲 / 下一曲
 */
export function usePlayerShortcuts(handlers: PlayerShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target)) return;
      // 菜单打开时方向键留给菜单自己；空格也不要隔空切走带。
      if ((event.target as HTMLElement | null)?.closest?.('[role="menu"]')) return;

      const api = handlersRef.current;
      const key = event.key;
      const code = event.code;
      const shift = event.shiftKey;
      const seekAmount = shift ? SEEK_STEP_LARGE : SEEK_STEP;

      if (key === " " || key === "MediaPlayPause") {
        event.preventDefault();
        api.togglePlay();
        return;
      }

      const rewind =
        key === "ArrowLeft" ||
        key === "MediaRewind" ||
        code === "Numpad4" ||
        code === "NumpadLeft";
      const forward =
        key === "ArrowRight" ||
        key === "MediaFastForward" ||
        code === "Numpad6" ||
        code === "NumpadRight";
      if (rewind || forward) {
        event.preventDefault();
        api.seekBy(rewind ? -seekAmount : seekAmount);
        return;
      }

      if (key === "ArrowUp") {
        event.preventDefault();
        api.nudgeVolume(VOLUME_STEP);
        return;
      }
      if (key === "ArrowDown") {
        event.preventDefault();
        api.nudgeVolume(-VOLUME_STEP);
        return;
      }

      if (key === "MediaTrackNext") {
        event.preventDefault();
        api.goNext();
        return;
      }
      if (key === "MediaTrackPrevious") {
        event.preventDefault();
        api.goPrevious();
        return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
