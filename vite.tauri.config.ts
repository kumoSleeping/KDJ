/**
 * Tauri 壳的前端构建配置。
 *
 *  1. 端口固定 5274 且 strictPort。`src-tauri/tauri.conf.json` 的 devUrl 写死了它，
 *     端口一漂移 dev 窗口就是白屏，而且白屏不会报错，很难一眼看出根因；
 *  2. 产物固定落在 `dist-tauri/`；
 *  3. CSP 只由 `src-tauri/tauri.conf.json` 的 app.security.csp / devCsp 管理。
 *
 * 用法：
 *   npm run tauri:dev     # 起窗口（内部会先跑 tauri:web）
 *   npm run tauri:build   # 出安装包
 */
import react from "@vitejs/plugin-react";
import { build as buildWithEsbuild } from "esbuild";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const YOUTUBE_NATIVE_PO_DEV_PATH = "/__kdj_youtube_native_po.js";
const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
// Tauri builds provide the target-triple platform (`darwin`, `windows`, `linux`, `androideabi`,
// …). A direct Vite build falls back to its host, so Linux/Windows CI cannot accidentally retain
// a worker that only macOS can invoke.
const nativeYoutubeRuntime = tauriPlatform
  ? tauriPlatform === "darwin"
  : process.platform === "darwin";

/**
 * Vite serves `?worker&url` as an ES module graph in development, whereas WKWebView's isolated
 * proof page deliberately accepts only one local eval bundle and cannot import localhost modules.
 * Production already emits a self-contained worker chunk; this endpoint gives development the
 * same artifact shape without adding a runtime or a second proof implementation.
 */
function youtubeNativePoDevBundle(): Plugin {
  let cached: Promise<string> | null = null;
  const entry = fileURLToPath(new URL("./src/lib/youtubeNativePo.worker.ts", import.meta.url));
  const bundle = () => {
    cached ??= buildWithEsbuild({
      entryPoints: [entry],
      bundle: true,
      format: "iife",
      legalComments: "none",
      minify: true,
      platform: "browser",
      target: "safari13",
      write: false,
    }).then((result) => {
      const code = result.outputFiles[0]?.text ?? "";
      if (
        !code
        || code.length > 256 * 1024
        || !code.includes("__KDJ_YOUTUBE_NATIVE_PO__")
      ) throw new Error("YouTube native proof development bundle is invalid");
      return code;
    }).catch((error) => {
      cached = null;
      throw error;
    });
    return cached;
  };
  return {
    name: "kdj-youtube-native-po-dev-bundle",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== YOUTUBE_NATIVE_PO_DEV_PATH) {
          next();
          return;
        }
        try {
          const code = await bundle();
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(code);
        } catch {
          response.statusCode = 500;
          response.end("YouTube proof development bundle failed");
        }
      });
    },
    handleHotUpdate(context) {
      if (context.file === entry) cached = null;
    },
  };
}

// `tauri dev --host` 会设这个变量：真机调试时 HMR 不能连 localhost。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Codex worktrees / proof copies intentionally reuse the repository's node_modules symlink.
  // Vite's default node_modules/.vite cache would then be shared by multiple dev servers: one
  // optimizer rewrite can leave another WebView loading React DOM and Zustand from different
  // dependency generations, which manifests as an otherwise inexplicable Invalid Hook Call.
  // `target/` is checkout-local, so every Tauri session gets one coherent dependency graph.
  cacheDir: "target/vite-tauri-cache",
  plugins: [react(), youtubeNativePoDevBundle()],
  resolve: nativeYoutubeRuntime
    ? undefined
    : {
        alias: [
          {
            find: /^\.\/youtubeNativePo$/,
            replacement: fileURLToPath(
              new URL("./src/lib/youtubeNativePo.unsupported.ts", import.meta.url),
            ),
          },
          {
            find: /^\.\/youtubeSabr$/,
            replacement: fileURLToPath(
              new URL("./src/lib/youtubeSabr.unsupported.ts", import.meta.url),
            ),
          },
        ],
      },
  // Tauri CLI 自己要打印编译进度，vite 清屏会把它冲掉
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 5274,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5276 } : undefined,
    // Rust 侧的改动由 cargo 自己盯着，vite 再 watch 一遍只会白白触发整树重载
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  build: {
    outDir: "dist-tauri",
    emptyOutDir: true,
    // 目标 WebView 版本由平台决定：Windows 是 WebView2（Chromium），
    // macOS/Linux 是 WKWebView/WebKitGTK，后者的下限低不少。
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
