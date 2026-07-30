/**
 * 歌词后台调度：不挡播放。当前曲一开播就搜；右侧唱盘「下一首」一并预取。
 * 右栏与悬浮歌词各自由自己的按钮控制，不再由设置项自动弹出。
 *
 * 悬浮歌词有两种实现，这里都由同一份偏好驱动：桌面是独立透明置顶窗口，
 * 那个窗口自己订阅 store；Android 是原生浮层，词必须从这里推下去。
 */

import { useEffect, useRef } from "react";
import { useLyricsPrefs } from "../../lib/lyricsPrefs";
import { buildOverlayTimeline } from "../../lib/lyricsOverlay";
import { ensureLyrics, useLyricsStore } from "../../stores/lyricsStore";
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
  const desktopAccent = useLyricsPrefs((state) => state.desktopAccent);
  const desktopOpacity = useLyricsPrefs((state) => state.desktopOpacity);
  const lyricExtra = useLyricsPrefs((state) => state.lyricExtra);
  const setDesktopVerticalOffset = useLyricsPrefs((state) => state.setDesktopVerticalOffset);
  const showLyrics = useAppStore((state) => state.showLyrics);
  const entry = useLyricsStore((state) => state.get(current?.id));
  const prevDesktopWindow = useRef({ enabled: false, position: desktopPosition });

  const overlayOn = desktopEnabled && allowDesktop;

  // 右栏或独立悬浮歌词任一路径正在使用时搜词并预取。
  // prefsEpoch：引擎偏好变更后清缓存再重搜。
  useEffect(() => {
    if (!showLyrics && !overlayOn) return;
    void ensureLyrics(current);
    if (!next || next.id === current?.id) return;
    const timer = window.setTimeout(() => {
      void ensureLyrics(next);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [showLyrics, overlayOn, prefsEpoch, current?.id, next?.id]);

  // 悬浮窗由播放条自己的按钮独立控制；无曲目时隐藏。
  useEffect(() => {
    const control = window.kdj?.desktopLyrics;
    if (!control) return;
    const visible = overlayOn && Boolean(current);
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
      accent: desktopAccent,
      opacity: desktopOpacity,
    }).catch((error) => {
      console.error("悬浮歌词窗口更新失败", error);
      // Android 挂窗失败时把开关扳回去，避免按钮亮着却什么都没有。
      if (visible) useLyricsPrefs.getState().setDesktopEnabled(false);
    });
  }, [
    overlayOn,
    desktopPosition,
    desktopLocked,
    desktopFontScale,
    desktopPositionX,
    desktopPositionY,
    desktopAccent,
    desktopOpacity,
    current?.id,
  ]);

  /**
   * Android：把整首歌的时间轴交给原生侧，之后由它读 ExoPlayer 位置自己滚。
   * 换歌、词搜到、切附加层各推一次，中间不再有前端参与——WebView 进后台会被
   * 冻结，而息屏看歌词恰恰是这个功能存在的理由。
   */
  useEffect(() => {
    const push = window.kdj?.lyricsTimeline;
    if (!push || !overlayOn) return;
    void push(
      buildOverlayTimeline({
        trackId: current?.id ?? null,
        title: current?.title || current?.filename || "",
        duration: current?.duration ?? 0,
        entry,
        extra: lyricExtra,
      }),
    ).catch((error) => console.error("悬浮歌词时间轴推送失败", error));
  }, [overlayOn, current?.id, entry, lyricExtra]);

  // 原生浮层被拖动后把新位置写回偏好，下次打开落在同一处。
  useEffect(() => {
    const control = window.kdj?.overlayPermission;
    if (!control) return;
    let dispose: (() => void) | null = null;
    let disposed = false;
    void control
      .onMoved((y) => setDesktopVerticalOffset(y))
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [setDesktopVerticalOffset]);

  return null;
}
