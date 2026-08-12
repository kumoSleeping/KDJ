import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design.css";
import App from "./App";
import { DesktopLyricsOverlay } from "./components/player/DesktopLyricsOverlay";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { initBridge } from "./lib/bridge";
import { applyAppFontScale, readAppFontScale } from "./lib/fontScale";
import { applyTheme, useAppStore } from "./stores/appStore";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root，index.html 被改坏了");

const isLyricsWindow = new URLSearchParams(window.location.search).get("window") === "lyrics";
if (isLyricsWindow) document.documentElement.dataset.window = "lyrics";
// 悬浮歌词已有独立字号；主界面在 React 挂载前恢复上次选择，避免刷新后跳变。
if (!isLyricsWindow) applyAppFontScale(readAppFontScale());

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function syncTheme(): void {
  // settings 是异步拉回来的，没到之前不动主题——
  // 首帧的值由 theme-init.js 从 localStorage 恢复，这里再写会把它冲掉又闪一下
  const theme = useAppStore.getState().settings?.theme;
  if (theme) applyTheme(theme);
}

// 设置变更 → 重算主题；theme = system 时还要跟随系统切换（macOS 的日夜自动切换会触发）
useAppStore.subscribe(syncTheme);
darkQuery.addEventListener("change", syncTheme);
syncTheme();

/**
 * 先探测壳、拿到 baseUrl/token，再挂 React。
 *
 * Tauri 下这两个值要 invoke 一次才知道（端口和 token 是 Rust 启动时才定的），
 * 而 `api.audioUrl` / `coverUrl` / WebSocket 都是同步读的。挂载之后再补就有一个窗口期：
 * 首帧发出去的请求带着空 baseUrl，表现是"偶尔连不上、刷新一下又好了"这种最难查的抖动。
 *
 * 用 async 函数而不是顶层 await：顶层 await 会改变入口 chunk 的加载形态，
 * 没必要为省一层缩进去动打包。
 */
async function bootstrap(): Promise<void> {
  const mount = root as HTMLElement;
  try {
    await initBridge();
  } catch (error) {
    // 桥接层失败等于连不上后端。白屏是最难排查的表现，直接把原因写在页面上
    mount.textContent = `无法连接本地服务：${(error as Error).message}`;
    return;
  }
  createRoot(mount).render(
    <StrictMode>
      <RootErrorBoundary>
        {isLyricsWindow ? <DesktopLyricsOverlay /> : <App />}
      </RootErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
