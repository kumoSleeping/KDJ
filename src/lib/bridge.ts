/**
 * KDJ 运行时桥接层：正式环境走 Tauri，独立 Rust Web 调试走浏览器降级。
 * Electron 已停用，不再探测或兼容它的 preload 全局对象。
 */

import type { KdjBridge, UpdateInfo, UpdateProgress } from "../types";
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
    }
  } catch {
    /* 拆页途中 DOM / 音频图可能已半死 */
  }
}

/** `get_bridge_info` 的返回：Rust 侧启动 axum 之后才知道端口和 token。 */
interface BridgeInfo {
  baseUrl: string;
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
  if (!baseUrl) {
    throw new Error(`get_bridge_info 返回不完整：${JSON.stringify(raw)}`);
  }
  return { baseUrl, platform: str("platform") || "unknown" };
}

async function createTauriBridge(): Promise<KdjBridge> {
  const info = normalizeInfo(await tauriInvoke<unknown>("get_bridge_info"));
  const desktop = ["darwin", "win32", "linux"].includes(info.platform);
  return {
    ...info,
    openPath: (path: string) => tauriInvoke<void>("open_path", { path }),
    revealPath: (path: string) => tauriInvoke<void>("reveal_path", { path }),
    openExternal: (url: string) => tauriInvoke<void>("open_external", { url }),
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
      const picked = await tauriInvoke<unknown>("pick_folder");
      // 用户取消时 Tauri 的对话框返回 null，契约要求的也是 null
      return typeof picked === "string" && picked ? picked : null;
    },
    pickFolders: async () => {
      const picked = await tauriInvoke<unknown>("pick_folders");
      return Array.isArray(picked) ? picked.filter((p): p is string => typeof p === "string") : [];
    },
    // 契约里 windowControl 是同步的（Electron 走 ipcRenderer.send 不等回包），
    // 改成 async 会波及所有窗口控制入口，所以这里 fire-and-forget 保持签名不变
    windowControl: (action) => {
      // 自绘关闭键：先静音再关窗，否则 webview 拆掉时 MediaElement 会硬断爆音
      if (action === "close") silenceMediaForExit();
      void tauriInvoke("window_control", { action }).catch(() => {});
    },
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
    platform: "browser",
    // 浏览器里没有原生对话框和文件管理器，只能降级成提示
    openPath: async (path: string) => {
      console.info("[browser] openPath", path);
    },
    revealPath: async (path: string) => {
      console.info("[browser] revealPath", path);
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
