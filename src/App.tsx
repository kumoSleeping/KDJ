import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import { Button, EmptyState } from "./components/common";
import { Workspace } from "./components/workspace/Workspace";
import { PlayerBar } from "./components/player/PlayerBar";
import { startAutoAnalyze } from "./lib/autoAnalyze";
import { bootAll, connectEvents, selectConnected, useAppStore } from "./stores/appStore";

// 只有一个界面：工作台（曲库 + 搜索下载合一）。
// 原来的设置页删了——登录收进左下角齿轮的小弹窗，其余设置都有就地入口。

export default function App() {
  const booting = useAppStore((state) => state.booting);
  const bootError = useAppStore((state) => state.bootError);
  const connected = useAppStore(selectConnected);
  const [retrying, setRetrying] = useState(false);
  const platform = window.kdj?.platform;
  const isMac = platform === "darwin";
  const isMobile = platform === "android" || platform === "ios";

  useEffect(() => {
    // 全应用只有这一处订阅 WS；卸载时断开（StrictMode 的二次挂载会自动重订）
    const stop = connectEvents();
    void bootAll();
    return stop;
  }, []);

  // 分析不该由人来推动：选中、播放、以及空闲时的后台补齐都自动排队。
  // 挂在 connected 上而不是无条件挂——后端还没起来时轮询只会打出一串失败请求。
  useEffect(() => {
    if (!connected) return;
    return startAutoAnalyze();
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
    >
      <div className="kd-body">
        {connected ? (
          <Workspace />
        ) : (
          <section className="kd-section">
            {booting || retrying ? (
              <EmptyState
                icon={<LoaderCircle className="kd-spin" size={22} />}
                title="正在连接本地服务"
                hint="KDJ 正在启动内置 Rust 服务，首次启动需要几秒。"
              />
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

      {/* 没连上时不渲染播放条：没有可播的曲目，留个空条只会占地方 */}
      {connected && <PlayerBar />}
    </div>
  );
}
