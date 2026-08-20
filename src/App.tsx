import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import { Button, EmptyState, ToastHost } from "./components/common";
import { Workspace } from "./components/workspace/Workspace";
import { PlayerBar } from "./components/player/PlayerBar";
import { VideoPipHost } from "./components/player/VideoPipHost";
import { startAutoAnalyze } from "./lib/autoAnalyze";
import { startDataUpgrade } from "./lib/dataUpgrade";
import { djEngine } from "./lib/djMix";
import { bindSongPreviewToPlayer } from "./lib/songPreview";
import { isEditable } from "./lib/useLibraryClipboard";
import { useLayoutSignals } from "./lib/useLayoutMode";
import { bootAll, connectEvents, selectConnected, useAppStore } from "./stores/appStore";
import { usePlaylistStore } from "./stores/playlistStore";
import { useLyricsPrefs } from "./lib/lyricsPrefs";
import { useUpdateStore } from "./stores/updateStore";
import { readWorkMode, writeWorkMode, type WorkMode } from "./lib/workMode";

// 只有一个界面：工作台（曲库 + 搜索下载合一）。
// 登录 / 队列从顶栏专用按钮进入；其余设置仍就地改。

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
  const refreshOneLibraryDevices = usePlaylistStore((state) => state.refreshDevices);
  const { columns, chrome, portrait } = useLayoutSignals();
  const [retrying, setRetrying] = useState(false);
  const [workMode, setWorkModeState] = useState<WorkMode>(() => readWorkMode());
  const [djWorkspaceHost, setDjWorkspaceHost] = useState<HTMLDivElement | null>(null);
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
    const onLeave = () => silenceAllMedia();
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

  // 搜索结果在线试听 → 主播放条（不再开右栏）
  useEffect(() => bindSongPreviewToPlayer(), []);

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

  // 外置卷的生命周期不属于任何一个面板。即使文件夹栏在窄屏下收起，也要持续
  // 发现 Finder/资源管理器从应用外部完成的挂载与卸载，并清掉已断开的列表视图。
  useEffect(() => {
    if (!connected) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshOneLibraryDevices();
    };
    refreshWhenVisible();
    const timer = window.setInterval(refreshWhenVisible, 3_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [connected, refreshOneLibraryDevices]);

  const retry = useCallback(() => {
    setRetrying(true);
    void bootAll().finally(() => setRetrying(false));
  }, []);

  const setWorkMode = useCallback((mode: WorkMode) => {
    setWorkModeState(mode);
    writeWorkMode(mode);
  }, []);

  return (
    <div
      className="kd-app"
      data-mac={isMac ? "true" : undefined}
      data-mobile={isMobile ? "true" : undefined}
      data-columns={columns}
      data-chrome={chrome}
      data-portrait={portrait ? "true" : undefined}
      data-work-mode={workMode}
    >
      <div className="kd-body">
        {connected ? (
          <Workspace
            workMode={workMode}
            onWorkModeChange={setWorkMode}
            onDjWorkspaceHost={setDjWorkspaceHost}
          />
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
          <PlayerBar workMode={workMode} djWorkspaceHost={djWorkspaceHost} />
          <VideoPipHost />
        </>
      )}
    </div>
  );
}
