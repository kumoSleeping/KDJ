import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RootErrorBoundary } from "./components/RootErrorBoundary";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root，index.html 被改坏了");

const windowKind = new URLSearchParams(window.location.search).get("window");
const isLyricsWindow = windowKind === "lyrics";

function render(node: ReactNode): void {
  createRoot(root as HTMLElement).render(
    <StrictMode>
      <RootErrorBoundary>{node}</RootErrorBoundary>
    </StrictMode>,
  );
}

async function bootstrap(): Promise<void> {
  if (isLyricsWindow) document.documentElement.dataset.window = "lyrics";
  await import("./design.css");
  const [bridgeModule, fontModule, appStoreModule] = await Promise.all([
    import("./lib/bridge"),
    import("./lib/fontScale"),
    import("./stores/appStore"),
  ]);

  // 悬浮歌词已有独立字号；主界面在 React 挂载前恢复上次选择，避免刷新后跳变。
  if (!isLyricsWindow) fontModule.applyAppFontScale(fontModule.readAppFontScale());

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const syncTheme = () => {
    // settings 是异步拉回来的，没到之前不动主题；首帧由 theme-init.js 恢复。
    const theme = appStoreModule.useAppStore.getState().settings?.theme;
    if (theme) appStoreModule.applyTheme(theme);
  };
  appStoreModule.useAppStore.subscribe(syncTheme);
  darkQuery.addEventListener("change", syncTheme);
  syncTheme();

  const mount = root as HTMLElement;
  try {
    await bridgeModule.initBridge();
  } catch (error) {
    mount.textContent = `无法连接本地服务：${(error as Error).message}`;
    return;
  }

  if (
    import.meta.env.DEV
    && import.meta.env.VITE_KDJ_YOUTUBE_E2E === "1"
    && !isLyricsWindow
  ) {
    try {
      const { runYoutubePlaybackE2e } = await import("./lib/youtubePlaybackE2e");
      await runYoutubePlaybackE2e();
    } catch (error) {
      console.warn("YouTube playback E2E failed", error);
    }
    return;
  }

  if (isLyricsWindow) {
    const { DesktopLyricsOverlay } = await import("./components/player/DesktopLyricsOverlay");
    render(<DesktopLyricsOverlay />);
  } else {
    const { default: App } = await import("./App");
    render(<App />);
  }
}

void bootstrap();
