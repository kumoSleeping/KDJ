import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import { Button, EmptyState, ToastHost } from "./components/common";
import { Workspace } from "./components/workspace/Workspace";
import { PlayerBar } from "./components/player/PlayerBar";
import { VideoPipHost } from "./components/player/VideoPipHost";
import { startAutoAnalyze } from "./lib/autoAnalyze";
import { startDataUpgrade } from "./lib/dataUpgrade";
import { djEngine } from "./lib/djMix";
import { isEditable } from "./lib/useLibraryClipboard";
import { useLayoutSignals } from "./lib/useLayoutMode";
import { bootAll, connectEvents, selectConnected, useAppStore } from "./stores/appStore";
import { useLyricsPrefs } from "./lib/lyricsPrefs";
import { useUpdateStore } from "./stores/updateStore";
import { flushLocalStorageWrites } from "./lib/storageWrite";

// 只有一个界面：工作台（曲库 + 搜索下载合一）。
// 队列、设置与日夜模式从顶栏专用按钮进入。

/** 关窗/刷新前把所有会出声的媒体瞬间静音，避免硬卸时爆音。 */
function silenceAllMedia(): void {
  djEngine.silenceForExit();
  try {
    for (const node of document.querySelectorAll("audio, video")) {
      const media = node as HTMLMediaElement;
      media.muted = true;
      media.volume = 0;
      media.pause();
    }
  } catch {
    /* 拆页途中 DOM 可能已不可用 */
  }
}

export default function App() {
  const booting = useAppStore((state) => state.booting);
  const bootError = useAppStore((state) => state.bootError);
  const connected = useAppStore(selectConnected);
  const { columns, chrome, portrait } = useLayoutSignals();
  const [retrying, setRetrying] = useState(false);
  const platform = window.kdj?.platform;
  const isMac = platform === "darwin";
  const isMobile = platform === "android" || platform === "ios";

  useEffect(() => {
    // 全应用只有这一处订阅 WS；卸载时断开（StrictMode 的二次挂载会自动重订）
    const stop = connectEvents();
    useLyricsPrefs.getState().prepareForStartup();
    void bootAll();
    return stop;
  }, []);

  // 关应用 / 刷新：先静音再让壳拆掉，否则 MediaElement 硬断会「啪」一声。
  useEffect(() => {
    const onLeave = () => {
      flushLocalStorageWrites();
      silenceAllMedia();
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  // 禁止在列表/队列里 Cmd+C / 浏览器「复制」带走随便划到的字；输入框照常。
  // 需要复制标题等内容时走右键菜单的「复制标题」（navigator.clipboard）。
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  // 分析不该由人来推动：选中、播放、以及空闲时的后台补齐都自动排队。
  // 挂在 connected 上而不是无条件挂——后端还没起来时轮询只会打出一串失败请求。
  useEffect(() => {
    if (!connected) return;
    startDataUpgrade();
    return startAutoAnalyze();
  }, [connected]);

  // 软件更新：连通后启动静默检查（启动一次 + 每 5 分钟；受「自动检测」开关控制）。
  useEffect(() => {
    if (!connected) return;
    return useUpdateStore.getState().startBackgroundChecks();
  }, [connected]);

  const retry = useCallback(() => {
    setRetrying(true);
    void bootAll().finally(() => setRetrying(false));
  }, []);

  return (
    <div
      className="kd-app"
      data-mac={isMac ? "true" : undefined}
      data-mobile={isMobile ? "true" : undefined}
      data-columns={columns}
      data-chrome={chrome}
      data-portrait={portrait ? "true" : undefined}
      data-work-mode="manager"
    >
      <div className="kd-body">
        {connected ? (
          <Workspace />
        ) : (
          <section className="kd-section">
            {booting || retrying ? (
              <div className="kd-empty" aria-busy="true" aria-label="加载中">
                <LoaderCircle className="kd-spin" size={22} />
              </div>
            ) : (
              <EmptyState
                icon={<PlugZap size={22} />}
                title="本地服务未连接"
                hint={
                  bootError
                    ? `无法访问 KDJ 内置服务：${bootError}。请重启应用后再试。`
                    : "无法访问 KDJ 内置服务，请重启应用后再试。"
                }
                action={
                  <Button variant="primary" onClick={retry}>
                    <RefreshCw size={13} />
                    重试连接
                  </Button>
                }
              />
            )}
          </section>
        )}
      </div>

      <ToastHost />
      {/* 没连上时不渲染播放条：没有可播的曲目，留个空条只会占地方 */}
      {connected && (
        <>
          <PlayerBar />
          <VideoPipHost />
        </>
      )}
    </div>
  );
}
