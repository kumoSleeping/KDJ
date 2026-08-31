import { useEffect, useRef } from "react";
import {
  resolveArrowKeyAction,
  useArrowKeyControl,
  type ArrowKeyControlPrefs,
} from "./arrowKeyControl";
import { shouldIgnorePlayerShortcut } from "./playerShortcutPolicy";

/** 普通快进/快退步长（秒）。和多数桌面播放器的默认一致。 */
const SEEK_STEP = 5;
/** 按住 Shift 时的大步（秒）。 */
const SEEK_STEP_LARGE = 15;
/** 方向键调音量的步进。 */
const VOLUME_STEP = 0.05;

export interface PlayerShortcutHandlers {
  togglePlay(source?: "media-key"): void;
  /** 相对当前位置跳转；正数快进，负数快退。 */
  seekBy(delta: number): void;
  nudgeVolume(delta: number): void;
  moveListSelection(delta: -1 | 1): void;
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
 * - 方向键：按设置映射为歌内跳转 / 换歌 / 列表位置 / 音量
 * - 小键盘 4·6：固定快退快进 5 秒；Shift 加持变 15 秒
 * - 媒体上一曲 / 下一曲
 */
export function usePlayerShortcuts(handlers: PlayerShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const arrowKeyPrefs: ArrowKeyControlPrefs = {
    enabled: useArrowKeyControl((state) => state.enabled),
    horizontalMode: useArrowKeyControl((state) => state.horizontalMode),
    verticalMode: useArrowKeyControl((state) => state.verticalMode),
  };
  const arrowKeyPrefsRef = useRef(arrowKeyPrefs);
  arrowKeyPrefsRef.current = arrowKeyPrefs;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      const code = event.code;
      if (shouldIgnorePlayerShortcut(event.target, key, code)) return;
      // 菜单打开时方向键留给菜单自己；空格也不要隔空切走带。
      if ((event.target as HTMLElement | null)?.closest?.('[role="menu"]')) return;

      const api = handlersRef.current;
      const shift = event.shiftKey;
      const seekAmount = shift ? SEEK_STEP_LARGE : SEEK_STEP;

      if (key === " " || key === "Spacebar" || code === "Space" || key === "MediaPlayPause") {
        event.preventDefault();
        if (event.repeat) return;
        api.togglePlay(key === "MediaPlayPause" ? "media-key" : undefined);
        return;
      }

      const arrowAction = resolveArrowKeyAction(key, arrowKeyPrefsRef.current);
      if (arrowAction) {
        event.preventDefault();
        if (arrowAction === "seek-backward" || arrowAction === "seek-forward") {
          api.seekBy(arrowAction === "seek-backward" ? -seekAmount : seekAmount);
        } else if (arrowAction === "previous-track" || arrowAction === "next-track") {
          if (event.repeat) return;
          if (arrowAction === "previous-track") api.goPrevious();
          else api.goNext();
        } else if (arrowAction === "list-up" || arrowAction === "list-down") {
          api.moveListSelection(arrowAction === "list-up" ? -1 : 1);
        } else {
          api.nudgeVolume(arrowAction === "volume-up" ? VOLUME_STEP : -VOLUME_STEP);
        }
        return;
      }

      const rewind =
        key === "MediaRewind" ||
        code === "Numpad4" ||
        code === "NumpadLeft";
      const forward =
        key === "MediaFastForward" ||
        code === "Numpad6" ||
        code === "NumpadRight";
      if (rewind || forward) {
        event.preventDefault();
        api.seekBy(rewind ? -seekAmount : seekAmount);
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
