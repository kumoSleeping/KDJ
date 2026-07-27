/**
 * 纯 Rust 后端的开发预览配置。
 *
 * 和 vite.config.ts 的区别只有两点：
 *  1. 不加载 electron 插件（这是浏览器里跑的预览）；
 *  2. 注入一段 shim 提供 `window.kdj`，
 *     让前端能连上 `kumodeck-server` 这个独立进程。
 *
 * 用法：
 *   cargo run --release -p kumodeck-server --bin kumodeck-server   # 后端
 *   npx vite --config vite.rust.config.ts                          # 前端
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = process.env.KDJ_PORT ?? process.env.KUMODECK_PORT ?? "8788";

function devBridge(): Plugin {
  return {
    name: "kdj-dev-bridge",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          injectTo: "head-prepend",
          children: `
window.kdj = {
  baseUrl: "http://127.0.0.1:${API_PORT}",
  platform: "browser",
  // 浏览器预览没有 Tauri 原生对话框，只能降级
  openPath: async (p) => { console.info("[dev] openPath", p); },
  revealPath: async (p) => { console.info("[dev] revealPath", p); },
  pickFolder: async () => window.prompt("输入要添加的目录绝对路径") || null,
  pickFolders: async () => {
    const value = window.prompt("输入目录绝对路径（多个用换行分隔）") || "";
    return value.split("\\n").map((s) => s.trim()).filter(Boolean);
  },
  windowControl: () => {},
  onSidecarLog: () => () => {},
};
`.trim(),
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), devBridge()],
  server: { port: 5274, strictPort: true },
});
