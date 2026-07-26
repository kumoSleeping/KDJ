/**
 * 运行时桥接层：同一份前端要跑在三种壳里 —— Tauri（新）、Electron（旧）、浏览器预览。
 *
 * 为什么不在构建期用环境变量二选一：`rust-rewrite` 期间两个壳会并存一段时间
 * （老壳还要能出包、新壳还在验证），构建期分叉意味着每次都要重新 build 才能换壳测。
 * 运行时探测的代价只有一次 `typeof` 判断。
 *
 * 探测顺序 Tauri → Electron → 浏览器：Tauri 优先是因为将来 Tauri 壳里
 * 不会再有 `window.kumodeck`，而反过来"Electron 里混进 Tauri 句柄"不可能发生。
 *
 * 探测完成后会把结果**装回 `window.kumodeck`**。这不是偷懒：`window.kumodeck`
 * 本来就是前端和壳之间的既有契约（`src/types.ts::KumoDeckBridge`），
 * 组件里那 7 处 `window.kumodeck?.revealPath(...)` 因此一行都不用改，
 * 也就不存在"漏改一处导致某个按钮在 Tauri 下变哑巴"这种回归。
 */

import type { KumoDeckBridge } from "../types";

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

/** `get_bridge_info` 的返回：Rust 侧启动 axum 之后才知道端口和 token。 */
interface BridgeInfo {
  baseUrl: string;
  token: string;
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
  const token = str("token");
  if (!baseUrl || !token) {
    throw new Error(`get_bridge_info 返回不完整：${JSON.stringify(raw)}`);
  }
  return { baseUrl, token, platform: str("platform") || "unknown" };
}

async function createTauriBridge(): Promise<KumoDeckBridge> {
  const info = normalizeInfo(await tauriInvoke<unknown>("get_bridge_info"));
  return {
    ...info,
    openPath: (path: string) => tauriInvoke<void>("open_path", { path }),
    revealPath: (path: string) => tauriInvoke<void>("reveal_path", { path }),
    openExternal: (url: string) => tauriInvoke<void>("open_external", { url }),
    // 一键更新：桌面才有。安卓的 Tauri 壳没有 updater 插件，invoke 会直接
    // 报"命令不存在"——所以按平台判掉，让 UI 落到"开下载页"的分支。
    applyUpdate: /android/i.test(navigator.userAgent)
      ? null
      : async (onProgress) => {
          // 走 Rust 侧命令而不是 @tauri-apps/plugin-updater 的 JS 包：
          // 少一个要和 Rust 版本对齐的 npm 依赖（同 tauriInvoke 的理由）。
          // 进度事件靠轮询命令返回，一次 invoke 全托管到重启。
          await tauriInvoke<void>("apply_update");
          void onProgress; // 下载进度在 Rust 侧打日志；窗口马上就重启了
        },
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
    // 改成 async 会波及 TitleBar，所以这里 fire-and-forget 保持签名不变
    windowControl: (action) => {
      void tauriInvoke("window_control", { action }).catch(() => {});
    },
    // 纯 Rust 版没有 sidecar 子进程，日志直接落在 Rust 侧，这里给个空退订函数
    onSidecarLog: () => () => {},
  };
}

/**
 * 浏览器降级：`npx vite --config vite.rust.config.ts` 那套预览。
 *
 * 配置里注入的 `window.kumodeck` 是内联 `<script>`，而 index.html 的 CSP 是
 * `script-src 'self'`（没有 'unsafe-inline'），所以那段 shim 有可能被浏览器直接拦掉。
 * 这里兜底给出同样的默认值，预览就不依赖那段注入能不能落地。
 */
function createBrowserBridge(): KumoDeckBridge {
  const port = (import.meta.env.VITE_KUMODECK_PORT as string | undefined) ?? "8788";
  const token = (import.meta.env.VITE_KUMODECK_TOKEN as string | undefined) ?? "dev-token";
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
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
    applyUpdate: null,
    windowControl: () => {},
    onSidecarLog: () => () => {},
  };
}

function detect(): Promise<KumoDeckBridge> {
  if (window.__TAURI_INTERNALS__) return createTauriBridge();
  // Electron 的 preload 是同步注入的，探测到就直接用原对象，
  // 不要重新包一层：contextBridge 暴露的属性是只读的，改它会抛
  if (window.kumodeck) return Promise.resolve(window.kumodeck);
  return Promise.resolve(createBrowserBridge());
}

let current: KumoDeckBridge | null = null;
let pending: Promise<KumoDeckBridge> | null = null;

/**
 * 初始化桥接层。Tauri 下 baseUrl/token 要等 Rust 起完 axum 才知道，
 * 所以必须在 React 挂载之前 await 一次（见 `src/main.tsx`）——
 * `api.audioUrl` / `coverUrl` / WebSocket 都是同步读 baseUrl 的。
 *
 * 重复调用返回同一个 Promise：并发调用不会打两次 `get_bridge_info`。
 */
export function initBridge(): Promise<KumoDeckBridge> {
  if (!pending) {
    pending = detect().then((resolved) => {
      current = resolved;
      // 装回 window：组件里既有的 `window.kumodeck?.xxx` 调用点因此不用动。
      // Electron 下 detect() 返回的就是它自己，赋值会被 contextBridge 拒绝，故跳过。
      if (window.kumodeck !== resolved) {
        Object.defineProperty(window, "kumodeck", {
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
export function getBridge(): KumoDeckBridge {
  if (current) return current;
  if (typeof window !== "undefined" && window.kumodeck) return window.kumodeck;
  throw new Error("桥接层尚未初始化：main.tsx 必须先 await initBridge()");
}
