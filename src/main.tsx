import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design.css";
import App from "./App";
import { applyTheme, useAppStore } from "./stores/appStore";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root，index.html 被改坏了");

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function syncTheme(): void {
  // settings 是异步拉回来的，没到之前先按 index.html 的默认深色走
  applyTheme(useAppStore.getState().settings?.theme ?? "dark");
}

// 设置变更 → 重算主题；theme = system 时还要跟随系统切换（macOS 的日夜自动切换会触发）
useAppStore.subscribe(syncTheme);
darkQuery.addEventListener("change", syncTheme);
syncTheme();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
