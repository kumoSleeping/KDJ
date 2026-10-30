/**
 * Whether this window can export a visualizer, and why not. An export is drawn and encoded
 * here: workers draw the frames (OffscreenCanvas) and the WebView's own H.264 encoder
 * (WebCodecs) encodes them; there is no other encoder to fall back on. A system without one
 * (macOS 10.15's WebKit, most of Linux's WebKitGTK) keeps the visualizer's picture and
 * configuration, and its export keys are greyed with the reason.
 *
 * The sound is the server's: the song's own AAC is copied, or the system's AAC encoder makes
 * it. Where there is no such encoder (Linux) only an AAC song exports; the server says so
 * when such an export is started (studio.rs `NO_SOUND`).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { studioAvcCodec } from "./visualizerStudioFrames";
import { visualizerExportAvailable } from "./platformFeatures";

export const NO_VIDEO_ENCODER = "这台设备的系统没有可用的视频编码器，无法导出可视化";
export const NO_BACKGROUND_DRAWING = "这台设备的系统不能在后台绘制画面，无法导出可视化";

interface Support {
  /** Null while unknown or when export works; otherwise why it does not. */
  blocked: string | null;
  checked: boolean;
}

export const useVisualizerExportSupport = create<Support>(() => ({ blocked: null, checked: false }));

let checking: Promise<string | null> | undefined;

/** The reason this window cannot export, or null. Asked once; the answer does not change. */
export function checkVisualizerExportSupport(): Promise<string | null> {
  checking ??= probe().catch(() => NO_VIDEO_ENCODER).then(blocked => {
    useVisualizerExportSupport.setState({ blocked, checked: true });
    return blocked;
  });
  return checking;
}

async function probe(): Promise<string | null> {
  if (!visualizerExportAvailable()) return null;
  if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") return NO_BACKGROUND_DRAWING;
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return NO_VIDEO_ENCODER;
  // Any H.264 encoder the WebView has, hardware first, for the common 1080p30 canvas.
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    for (const profile of ["high", "main", "baseline"] as const) {
      const config: VideoEncoderConfig = { codec: studioAvcCodec(1920, 1080, 30, profile), width: 1920, height: 1080, framerate: 30,
        bitrate: 8_000_000, hardwareAcceleration, avc: { format: "annexb" } };
      if ((await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported) return null;
    }
  }
  return NO_VIDEO_ENCODER;
}

/** For an export key: why it is greyed, or null. Starts the check the first time it is shown. */
export function useVisualizerExportBlocked(): string | null {
  const blocked = useVisualizerExportSupport(state => state.blocked);
  useEffect(() => { void checkVisualizerExportSupport(); }, []);
  return blocked;
}
