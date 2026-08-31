/**
 * KDJ 运行时桥接层：正式环境走 Tauri，独立 Rust Web 调试走浏览器降级。
 * Electron 已停用，不再探测或兼容它的 preload 全局对象。
 */

import {
  addOverlayMovedListener,
  checkOverlayPermission,
  openLocalPath,
  pickLibraryFolder,
  requestOverlayPermission,
  savePngToGallery,
  startFileDrag,
  setLyricsOverlay,
  setLyricsPlaybackClock,
  setLyricsTimeline,
} from "tauri-plugin-native-audio-api";
import type {
  CliInstallStatus,
  KdjBridge,
  SavedLoginQr,
  UpdateInfo,
  UpdateProgress,
} from "../types";
import { djEngine } from "./djMix";

declare global {
  interface Window {
    /**
     * Tauri 2 注入的内部句柄。这里直接用它而不是 `@tauri-apps/api`：
     * 多一个 npm 依赖就多一份版本要和 Rust 侧对齐，而我们只需要 `invoke` 这一个函数，
     * `@tauri-apps/api/core` 的 invoke 本身也就是转发到这里。
     */
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<T>;
    };
  }
}

/** 关窗前同步静音：异步 import 会赶不上 webview 拆掉。 */
function silenceMediaForExit(): void {
  try {
    djEngine.silenceForExit();
    for (const node of document.querySelectorAll("audio, video")) {
      const media = node as HTMLMediaElement;
      media.muted = true;
      media.volume = 0;
      media.pause();
      // pause 不会取消 preload/Range；显式拆源，退出过程不再等待卡住的媒体管线。
      if (typeof MediaStream !== "undefined" && media.srcObject instanceof MediaStream) {
        for (const track of media.srcObject.getTracks()) track.stop();
        media.srcObject = null;
      }
      media.removeAttribute("src");
      for (const source of media.querySelectorAll("source")) source.removeAttribute("src");
      media.load();
    }
  } catch {
    /* 拆页途中 DOM / 音频图可能已半死 */
  }
}

/** `get_bridge_info` 的返回：Rust 侧启动 axum 之后才知道端口和 token。 */
interface BridgeInfo {
  baseUrl: string;
  authToken: string;
  mediaToken: string;
  platform: string;
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error(`不在 Tauri 环境里，无法调用 ${cmd}`));
  return internals.invoke<T>(cmd, args ?? {});
}

/**
 * Rust 侧的结构体如果忘了 `#[serde(rename_all = "camelCase")]`，serde 默认吐的是
 * `base_url`。两种都认一下，否则症状是前端拿到 `undefined/api/health` 这种
 * 极难一眼看出根因的 URL。
 */
function normalizeInfo(raw: unknown): BridgeInfo {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const str = (...keys: string[]): string => {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  const baseUrl = str("baseUrl", "base_url");
  const authToken = str("authToken", "auth_token");
  const mediaToken = str("mediaToken", "media_token");
  if (!baseUrl || !authToken || !mediaToken) {
    // 不把 raw 串进错误：它包含本进程 bearer，错误可能进入 UI 或诊断日志。
    throw new Error("get_bridge_info 返回不完整（缺少地址或认证信息）");
  }
  return { baseUrl, authToken, mediaToken, platform: str("platform") || "unknown" };
}

async function createTauriBridge(): Promise<KdjBridge> {
  const info = normalizeInfo(await tauriInvoke<unknown>("get_bridge_info"));
  const desktop = ["darwin", "win32", "linux"].includes(info.platform);
  const cliSupported = ["darwin", "win32"].includes(info.platform);
  // 只认 Rust 报的平台名。iOS 沙盒里不存在系统级浮层，那边这些命令没有实现，
  // 靠 UA 猜会在 iPhone 上调到不存在的插件命令。
  const android = info.platform === "android";
  return {
    ...info,
    cliInstallStatus: cliSupported
      ? () => tauriInvoke<CliInstallStatus>("cli_install_status")
      : undefined,
    installCli: cliSupported
      ? () => tauriInvoke<CliInstallStatus>("install_cli")
      : undefined,
    mintYoutubeGvsPoToken: info.platform === "darwin"
      ? (options) => tauriInvoke<string>("youtube_mint_gvs_po_token", options)
      : undefined,
    runYoutubePlayer: info.platform === "darwin"
      ? (options) => tauriInvoke<string>("youtube_run_player", options)
      : undefined,
    youtubeEmbed: info.platform === "darwin"
      ? {
          prewarm: () => tauriInvoke<void>("youtube_embed_prewarm"),
          open: (options) => tauriInvoke<void>("youtube_embed_open", options),
          setBounds: (options) => tauriInvoke<void>("youtube_embed_set_bounds", options),
          status: (videoId) =>
            tauriInvoke<{
              ready: boolean;
              playing: boolean;
              buffering: boolean;
              ended: boolean;
              position: number;
              duration: number;
              hasError: boolean;
            }>("youtube_embed_status", { videoId }),
          control: (videoId, action, value) =>
            tauriInvoke<void>("youtube_embed_control", { videoId, action, value }),
          close: (videoId) => tauriInvoke<void>("youtube_embed_close", { videoId }),
        }
      : undefined,
    bilibiliEmbed: info.platform === "darwin"
      ? {
          open: (options) => tauriInvoke<void>("bilibili_embed_open", options),
          setBounds: (options) => tauriInvoke<void>("bilibili_embed_set_bounds", options),
          status: (bvid, page) =>
            tauriInvoke<{
              ready: boolean;
              playing: boolean;
              buffering: boolean;
              ended: boolean;
              position: number;
              duration: number;
              hasError: boolean;
            }>("bilibili_embed_status", { bvid, page }),
          control: (bvid, page, action, value) =>
            tauriInvoke<void>("bilibili_embed_control", { bvid, page, action, value }),
          close: (bvid, page) =>
            tauriInvoke<void>("bilibili_embed_close", { bvid, page }),
        }
      : undefined,
    // 安卓：opener 的 reveal 不支持，open_path 也打不开 file://；走 MediaStore / FileProvider。
    openPath: (path: string) =>
      android ? openLocalPath(path) : tauriInvoke<void>("open_path", { path }),
    revealPath: (path: string) =>
      android ? openLocalPath(path) : tauriInvoke<void>("reveal_path", { path }),
    startFileDrag: android
      ? async ({ paths, label }) => {
          await startFileDrag(paths, label);
        }
      : ["darwin", "win32"].includes(info.platform)
        ? ({ paths, label: _label, dragImage }) =>
            tauriInvoke<void>("start_native_file_drag", { paths, dragImage })
        : undefined,
    startLinkDrag: info.platform === "darwin"
      ? ({ url, label: _label, text, dragImage, includeArtwork }) =>
          tauriInvoke<void>("start_native_link_drag", {
            url,
            text,
            dragImage,
            includeArtwork,
          })
      : undefined,
    writeShareClipboard: info.platform === "darwin"
      ? (options) => tauriInvoke<void>("write_share_clipboard", options)
      : undefined,
    saveLoginQr: (options) =>
      android
        ? savePngToGallery({
            platform: options.platform,
            label: options.label,
            image: options.image,
          })
        : tauriInvoke<SavedLoginQr>("save_login_qr", {
            platform: options.platform,
            label: options.label,
            image: options.image,
          }),
    openExternal: (url: string) => tauriInvoke<void>("open_external", { url }),
    openSoundcloudOAuth: desktop
      ? (url: string) => tauriInvoke<void>("open_soundcloud_oauth_window", { url })
      : undefined,
    openSoundcloudWebLogin: desktop
      ? () => tauriInvoke<void>("open_soundcloud_web_login_window")
      : undefined,
    // 检查也必须走 updater 本身，不能先问 GitHub releases/latest：Release 先建、
    // 三平台包后到的窗口里，后者会谎报"可更新"，真正安装时才发现 latest.json
    // 或当前 bundle 的签名包还不存在。
    checkUpdate: desktop
      ? () => tauriInvoke<UpdateInfo>("check_desktop_update")
      : null,
    // 一键更新只在桌面存在。不要靠 UA 猜 Android：Tauri 已经把 Rust 平台名
    // 放在 get_bridge_info 里，这是不会被 WebView UA 变化影响的权威值。
    applyUpdate: desktop
      ? async (onProgress) => {
          // 走 Rust 侧命令而不是 @tauri-apps/plugin-updater 的 JS 包：
          // 少一个要和 Rust 版本对齐的 npm 依赖（同 tauriInvoke 的理由）。
          // apply_update 是长 invoke；旁边短轮询只读 Rust Mutex，不碰下载任务。
          let polling = false;
          const poll = async () => {
            if (polling || !onProgress) return;
            polling = true;
            try {
              onProgress(await tauriInvoke<UpdateProgress>("get_update_progress"));
            } catch {
              // 进程进入安装/重启后 IPC 会先断；这是成功路径，不在这里报假错误
            } finally {
              polling = false;
            }
          };
          await poll();
          const timer = window.setInterval(() => void poll(), 250);
          try {
            await tauriInvoke<void>("apply_update");
          } finally {
            window.clearInterval(timer);
          }
        }
      : null,
    pickFolder: async () => {
      // 安卓 dialog 没有 folder picker；走系统 ACTION_OPEN_DOCUMENT_TREE。
      if (android) {
        return pickLibraryFolder();
      }
      const picked = await tauriInvoke<unknown>("pick_folder");
      // 用户取消时 Tauri 的对话框返回 null，契约要求的也是 null
      return typeof picked === "string" && picked ? picked : null;
    },
    pickFolders: async () => {
      if (android) {
        const path = await pickLibraryFolder();
        return path ? [path] : [];
      }
      const picked = await tauriInvoke<unknown>("pick_folders");
      return Array.isArray(picked) ? picked.filter((p): p is string => typeof p === "string") : [];
    },
    // 安卓：查询是否已授予媒体读取权限（供扫描 0 首时区分「没权限」和「真没歌」）。
    mediaPermissionGranted: android
      ? () => tauriInvoke<boolean>("media_permission_granted")
      : () => Promise.resolve(true),
    // 契约里 windowControl 是同步的（Electron 走 ipcRenderer.send 不等回包），
    // 改成 async 会波及所有窗口控制入口，所以这里 fire-and-forget 保持签名不变
    windowControl: (action) => {
      // 自绘关闭键：先静音再关窗，否则 webview 拆掉时 MediaElement 会硬断爆音
      if (action === "close") silenceMediaForExit();
      void tauriInvoke("window_control", { action }).catch(() => {});
    },
    setWindowBackground: (theme) => {
      void tauriInvoke("set_window_background", { theme }).catch(() => {});
    },
    desktopLyrics: desktop
      ? // 颜色和不透明度不进 Rust：它们不影响窗口尺寸或层级，歌词窗口那个
        // WebView 自己读 lyricsPrefs（localStorage + lyrics-prefs-changed 广播）。
        (options) =>
          tauriInvoke<void>("set_desktop_lyrics", {
            visible: options.visible,
            position: options.position,
            locked: options.locked,
            fontScale: options.fontScale,
            reposition: options.reposition,
            x: options.x,
            y: options.y,
          })
      : android
        ? async (options) => {
            const result = await setLyricsOverlay({
              visible: options.visible,
              position: options.position,
              locked: options.locked,
              fontScale: options.fontScale,
              accent: options.accent,
              accentEnd: options.accentEnd,
              accentMode: options.accentMode,
              secondaryAccent: options.secondaryAccent,
              secondaryAccentEnd: options.secondaryAccentEnd,
              secondaryMode: options.secondaryMode,
              dim: options.dim,
              dimEnd: options.dimEnd,
              dimMode: options.dimMode,
              stroke: options.stroke,
              strokeEnd: options.strokeEnd,
              strokeMode: options.strokeMode,
              opacity: options.opacity,
              reposition: options.reposition,
              // 浮层满宽，水平坐标没有意义；只有垂直偏移会用到。
              y: options.y,
            });
            // 想开却挂不上：多数是权限或国产 ROM 第二道门，不能让开关假亮着。
            if (options.visible && !result.visible) {
              throw new Error(
                result.granted
                  ? "悬浮歌词未能显示。部分系统还需允许「后台弹出界面」。"
                  : "悬浮歌词需要「显示在其他应用上层」权限。",
              );
            }
          }
        : null,
    lyricsTimeline: android ? (payload) => setLyricsTimeline(payload) : null,
    // 兼容旧浏览器在线 owner 的外部时钟入口。当前 Android 正式在线播放已进入
    // Rust coordinator，streamTrack 会拒绝重复镜像；保留命令只用于旧会话清理。
    lyricsPlaybackClock: android ? (payload) => setLyricsPlaybackClock(payload) : null,
    overlayPermission: android
      ? {
          check: async () => (await checkOverlayPermission()).granted,
          request: async () => {
            await requestOverlayPermission();
          },
          onMoved: (handler) => addOverlayMovedListener((moved) => handler(moved.y)),
        }
      : undefined,
    // 纯 Rust 版没有 sidecar 子进程，日志直接落在 Rust 侧，这里给个空退订函数
    onSidecarLog: () => () => {},
  };
}

/**
 * 浏览器降级：`npx vite --config vite.rust.config.ts` 那套预览。
 *
 * 配置里注入的 `window.kdj` 是内联 `<script>`，而 index.html 的 CSP 是
 * `script-src 'self'`（没有 'unsafe-inline'），所以那段 shim 有可能被浏览器直接拦掉。
 * 这里兜底给出同样的默认值，预览就不依赖那段注入能不能落地。
 */
function createBrowserBridge(): KdjBridge {
  const port =
    (import.meta.env.VITE_KDJ_PORT as string | undefined) ??
    (import.meta.env.VITE_KDJ_PORT as string | undefined) ??
    "8788";
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    authToken: (import.meta.env.VITE_KDJ_AUTH_TOKEN as string | undefined) ?? "",
    mediaToken: (import.meta.env.VITE_KDJ_MEDIA_TOKEN as string | undefined) ?? "",
    platform: "browser",
    // 浏览器里没有原生对话框和文件管理器，只能降级成提示
    openPath: async (path: string) => {
      console.info("[browser] openPath", path);
    },
    revealPath: async (path: string) => {
      console.info("[browser] revealPath", path);
    },
    // 浏览器/桌面无安卓媒体权限概念
    mediaPermissionGranted: async () => true,
    saveLoginQr: async ({ platform, label, image }) => {
      const safe = (label.trim() || platform).replace(/[\\/:*?"<>|]/g, "-");
      const filename = `KDJ-登录二维码-${safe}.png`;
      const anchor = document.createElement("a");
      anchor.href = image;
      anchor.download = filename;
      anchor.click();
      return { path: filename, location: "downloads" };
    },
    pickFolder: async () => window.prompt("输入要添加的目录绝对路径") || null,
    pickFolders: async () => {
      const value = window.prompt("输入目录绝对路径（多个用换行分隔）") || "";
      return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
    // 浏览器里"外链"就是开新标签页
    openExternal: async (url: string) => {
      window.open(url, "_blank", "noopener");
    },
    checkUpdate: null,
    applyUpdate: null,
    windowControl: () => {},
    setWindowBackground: () => {},
    onSidecarLog: () => () => {},
  };
}

function detect(): Promise<KdjBridge> {
  if (window.__TAURI_INTERNALS__) return createTauriBridge();
  return Promise.resolve(createBrowserBridge());
}

let current: KdjBridge | null = null;
let pending: Promise<KdjBridge> | null = null;

/**
 * 初始化桥接层。Tauri 下 baseUrl/token 要等 Rust 起完 axum 才知道，
 * 所以必须在 React 挂载之前 await 一次（见 `src/main.tsx`）——
 * `api.audioUrl` / `coverUrl` / WebSocket 都是同步读 baseUrl 的。
 *
 * 重复调用返回同一个 Promise：并发调用不会打两次 `get_bridge_info`。
 */
export function initBridge(): Promise<KdjBridge> {
  if (!pending) {
    pending = detect().then((resolved) => {
      current = resolved;
      if (window.kdj !== resolved) {
        Object.defineProperty(window, "kdj", {
          value: resolved,
          writable: false,
          configurable: true,
        });
      }
      // theme-init.js 已在首帧前写好 data-theme；桥一通就立刻对齐原生底色，
      // 不必等 settings 异步回来再 applyTheme，缩短 show 与主题同步之间的空隙。
      const theme = document.documentElement.dataset.theme;
      if (theme === "dark" || theme === "light") {
        resolved.setWindowBackground(theme);
      }
      return resolved;
    });
    // 失败就把缓存清掉，否则一个 rejected Promise 会被永久记住，重试也没用
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * 同步取桥接层。调用点全部发生在 React 挂载之后，此时 `initBridge` 已经 resolve。
 *
 * 没初始化时不静默降级：Electron 下 preload 本来就是同步可用的，直接兜底；
 * 其余情况宁可抛出来，也好过悄悄连到一个错的 baseUrl 上排查半天。
 */
export function getBridge(): KdjBridge {
  if (current) return current;
  if (typeof window !== "undefined" && window.kdj) return window.kdj;
  throw new Error("桥接层尚未初始化：main.tsx 必须先 await initBridge()");
}
