/**
 * 歌词后台调度：不挡播放。当前曲一开播就搜；右侧唱盘「下一首」一并预取。
 * 右栏与桌面悬浮歌词各自由自己的按钮控制，不再由设置项自动弹出。
 */

import { useEffect, useRef } from "react";
import { useLyricsPrefs } from "../../lib/lyricsPrefs";
import { ensureLyrics } from "../../stores/lyricsStore";
import { useAppStore } from "../../stores/appStore";
import type { Track } from "../../types";

export function LyricsHost({
  current,
  next,
  allowDesktop,
}: {
  current: Track | null;
  next: Track | null;
  /** 视频/VJ 模式只使用视频小窗，绝不同时拉起桌面歌词。 */
  allowDesktop: boolean;
}) {
  const prefsEpoch = useLyricsPrefs((state) => state.prefsEpoch);
  const desktopEnabled = useLyricsPrefs((state) => state.desktopEnabled);
  const desktopPosition = useLyricsPrefs((state) => state.desktopPosition);
  const desktopLocked = useLyricsPrefs((state) => state.desktopLocked);
  const desktopFontScale = useLyricsPrefs((state) => state.desktopFontScale);
  const desktopPositionX = useLyricsPrefs((state) => state.desktopPositionX);
  const desktopPositionY = useLyricsPrefs((state) => state.desktopPositionY);
  const showLyrics = useAppStore((state) => state.showLyrics);
  const prevDesktopWindow = useRef({ enabled: false, position: desktopPosition });

  // 右栏或独立桌面歌词任一路径正在使用时搜词并预取。
  // prefsEpoch：引擎偏好变更后清缓存再重搜。
  useEffect(() => {
    if (!showLyrics && !(desktopEnabled && allowDesktop)) return;
    void ensureLyrics(current);
    if (!next || next.id === current?.id) return;
    const timer = window.setTimeout(() => {
      void ensureLyrics(next);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [showLyrics, desktopEnabled, allowDesktop, prefsEpoch, current?.id, next?.id]);

  // 桌面悬浮窗由播放条自己的按钮独立控制；无曲目时隐藏。
  useEffect(() => {
    const control = window.kdj?.desktopLyrics;
    if (!control) return;
    const visible = desktopEnabled && allowDesktop && Boolean(current);
    const previous = prevDesktopWindow.current;
    const reposition = visible && (!previous.enabled || previous.position !== desktopPosition);
    prevDesktopWindow.current = { enabled: visible, position: desktopPosition };
    void control({
      visible,
      position: desktopPosition,
      locked: desktopLocked,
      fontScale: desktopFontScale,
      reposition,
      x: desktopPositionX,
      y: desktopPositionY,
    }).catch((error) => console.error("桌面歌词窗口更新失败", error));
  }, [
    desktopEnabled,
    allowDesktop,
    desktopPosition,
    desktopLocked,
    desktopFontScale,
    desktopPositionX,
    desktopPositionY,
    current?.id,
  ]);


  return null;
}
