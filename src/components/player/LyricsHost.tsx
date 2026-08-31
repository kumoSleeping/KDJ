/**
 * 歌词后台调度：不挡播放。只有用户打开歌词界面时才读取当前曲，不预取下一首。
 * 右栏与悬浮歌词各自由自己的按钮控制，不再由设置项自动弹出。
 *
 * 悬浮歌词有两种实现，这里都由同一份偏好驱动：桌面是独立透明置顶窗口，
 * 那个窗口自己订阅 store；Android 是原生浮层，词必须从这里推下去。
 */

import { useEffect, useRef } from "react";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  accentPaint,
  dimPaint,
  resolvedSecondaryPaint,
  strokePaint,
  useLyricsPrefs,
} from "../../lib/lyricsPrefs";
import { buildOverlayTimeline } from "../../lib/lyricsOverlay";
import { setNativeStreamLyricsClockEnabled } from "../../lib/streamTrack";
import {
  ensureLyrics,
  publishedLyricsEntry,
  useLyricsStore,
} from "../../stores/lyricsStore";
import { useAppStore } from "../../stores/appStore";
import type { Track } from "../../types";

export function LyricsHost({
  current,
  allowDesktop,
}: {
  current: Track | null;
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
  const prefs = useLyricsPrefs();
  const desktopOpacity = prefs.desktopOpacity;
  const lyricExtra = useLyricsPrefs((state) => state.lyricExtra);
  const setDesktopCoordinates = useLyricsPrefs((state) => state.setDesktopCoordinates);
  const setDesktopVerticalOffset = useLyricsPrefs((state) => state.setDesktopVerticalOffset);
  const showLyrics = useAppStore((state) => state.showLyrics);
  const entry = useLyricsStore((state) => state.get(current?.id));
  const prevDesktopWindow = useRef({ enabled: false });

  const overlayOn = desktopEnabled && allowDesktop;
  const accent = accentPaint(prefs);
  const secondary = resolvedSecondaryPaint(prefs);
  const dim = dimPaint(prefs);
  const stroke = strokePaint(prefs);

  // 只有 Android 原生浮层可见时才同步浏览器在线试听的时钟。关闭时必须清掉，
  // 否则下一首本地曲目的歌词有机会读到上一首流媒体的外推位置。
  useEffect(() => {
    setNativeStreamLyricsClockEnabled(overlayOn);
    return () => setNativeStreamLyricsClockEnabled(false);
  }, [overlayOn]);

  // 只有用户打开右栏或悬浮歌词时才取当前曲；下一首不提前跨平台搜索。
  // ensure 自带同歌并发去重，不会阻塞播放或产生重复请求。
  useEffect(() => {
    if (!showLyrics && !overlayOn) return;
    void ensureLyrics(current);
  }, [showLyrics, overlayOn, prefsEpoch, current?.id]);

  // 桌面歌词是另一张 WebView。在线请求只由主窗口拥有，结果通过 Tauri 事件推送；
  // 这样悬浮窗挂载、StrictMode 重挂载都不会再补打一条 /lyrics。
  useEffect(() => {
    if (!current?.id) return;
    void emitTo(
      "lyrics-overlay",
      "lyrics-entry-changed",
      publishedLyricsEntry(current.id, entry),
    ).catch(() => undefined);
  }, [current?.id, entry]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    void listen("lyrics-state-request", () => {
      if (!current?.id) return;
      void emitTo(
        "lyrics-overlay",
        "lyrics-entry-changed",
        publishedLyricsEntry(current.id, entry),
      ).catch(() => undefined);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [current?.id, entry]);

  // 悬浮窗由播放条自己的按钮独立控制；无曲目时隐藏。
  useEffect(() => {
    const control = window.kdj?.desktopLyrics;
    if (!control) return;
    const visible = overlayOn && Boolean(current);
    const previous = prevDesktopWindow.current;
    // 顶/底开关已去掉；只在重新打开时带坐标吸附，平时改样式不挪位置。
    const reposition = visible && !previous.enabled;
    prevDesktopWindow.current = { enabled: visible };
    void control({
      visible,
      position: desktopPosition,
      locked: desktopLocked,
      fontScale: desktopFontScale,
      reposition,
      x: desktopPositionX,
      y: desktopPositionY,
      accent: accent.start,
      accentEnd: accent.end,
      accentMode: accent.mode === "none" || accent.mode === "follow" ? "solid" : accent.mode,
      secondaryAccent: secondary.start,
      secondaryAccentEnd: secondary.end,
      secondaryMode:
        secondary.mode === "none" || secondary.mode === "follow" ? "solid" : secondary.mode,
      dim: dim.start,
      dimEnd: dim.end,
      dimMode:
        dim.mode === "black" ||
        dim.mode === "white" ||
        dim.mode === "gray" ||
        dim.mode === "solid" ||
        dim.mode === "gradient"
          ? dim.mode
          : "gray",
      stroke: stroke.start,
      strokeEnd: stroke.end,
      strokeMode: stroke.mode === "follow" ? "none" : stroke.mode,
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
    accent.start,
    accent.end,
    accent.mode,
    secondary.start,
    secondary.end,
    secondary.mode,
    dim.start,
    dim.end,
    dim.mode,
    stroke.start,
    stroke.end,
    stroke.mode,
    desktopOpacity,
    current?.id,
  ]);

  /**
   * Android：把整首歌的时间轴交给原生侧；本地曲目读 coordinator，浏览器试听
   * 读上面的限频时钟镜像。换歌、词搜到、切附加层各推一次，中间不再有逐行
   * 前端参与——WebView 进后台会被冻结，而息屏看歌词恰恰是这个功能存在的理由。
   */
  useEffect(() => {
    const push = window.kdj?.lyricsTimeline;
    if (!push || !overlayOn) return;
    void push(
      buildOverlayTimeline({
        trackId: current?.id ?? null,
        duration: current?.duration ?? 0,
        entry,
        extra: lyricExtra,
      }),
    ).catch((error) => console.error("悬浮歌词时间轴推送失败", error));
  }, [overlayOn, current?.id, entry, lyricExtra]);

  // 桌面歌词是另一张 WebView；坐标必须回传主窗落盘，不能只写歌词窗自己的 storage。
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: UnlistenFn | null = null;
    let timer: number | null = null;
    let latest: { x: number; y: number } | null = null;
    void listen<{ x: number; y: number }>("desktop-lyrics-moved", (event) => {
      latest = event.payload;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (latest) setDesktopCoordinates(latest.x, latest.y);
      }, 220);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [setDesktopCoordinates]);

  // Android 原生浮层被拖动后把新位置写回偏好，下次打开落在同一处。
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
