import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { installDiagnostics, captureDiagnostic } from "./lib/diagnostics";

// A diagnostic hook must never prevent the application itself from booting.
try { installDiagnostics(); }
catch (error) { captureDiagnostic("runtime", "diagnostics.install", error); }

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
  const [bridgeModule, fontModule, appStoreModule, themeModule] = await Promise.all([
    import("./lib/bridge"),
    import("./lib/fontScale"),
    import("./stores/appStore"),
    import("./lib/themePack"),
  ]);

  // 悬浮歌词已有独立字号；主界面在 React 挂载前恢复上次选择，避免刷新后跳变。
  if (!isLyricsWindow) fontModule.applyAppFontScale(fontModule.readAppFontScale());

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const syncTheme = () => {
    // settings 是异步拉回来的，没到之前不动主题；首帧由 theme-init.js 恢复。
    const theme = appStoreModule.useAppStore.getState().settings?.theme;
    if (theme) appStoreModule.applyTheme(theme);
    else if (windowKind) {
      // Auxiliary windows do not bootstrap the library/settings store. Keep the
      // main window's snapshot mode, including single-mode theme overrides.
      appStoreModule.applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    }
  };
  appStoreModule.useAppStore.subscribe(syncTheme);
  themeModule.useThemePack.subscribe(syncTheme);
  darkQuery.addEventListener("change", syncTheme);
  syncTheme();

  const mount = root as HTMLElement;
  try {
    await bridgeModule.initBridge();
  } catch (error) {
    captureDiagnostic("runtime", "bridge.bootstrap", error);
    mount.textContent = `无法连接本地服务：${(error as Error).message}`;
    return;
  }
  // 主题文件由本地服务提供，所以排在桥之后；没选主题包时立即返回。
  await themeModule.bootThemePack();

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

  if (windowKind === "live-vj") {
    const { LiveVjOutput } = await import("./components/composition/LiveVjOutput");
    render(<LiveVjOutput />);
  } else if (isLyricsWindow) {
    const { DesktopLyricsOverlay } = await import("./components/player/DesktopLyricsOverlay");
    render(<DesktopLyricsOverlay />);
  } else {
    const { default: App } = await import("./App");
    render(<App />);
  }
}

void bootstrap().catch(error => {
  captureDiagnostic("runtime", "bootstrap", error);
  root.textContent = `启动失败：${error instanceof Error ? error.message : String(error)}`;
});
