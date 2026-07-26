import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import { TitleBar } from "./components/chrome/TitleBar";
import { Button, EmptyState, Toasts } from "./components/common";
import { Workspace } from "./components/workspace/Workspace";
import { PlayerBar } from "./components/player/PlayerBar";
import { bootAll, connectEvents, selectConnected, useAppStore } from "./stores/appStore";

// 只有一个界面：工作台（曲库 + 搜索下载合一）。
// 原来的设置页删了——登录收进左下角齿轮的小弹窗，其余设置都有就地入口。

export default function App() {
  const booting = useAppStore((state) => state.booting);
  const bootError = useAppStore((state) => state.bootError);
  const connected = useAppStore(selectConnected);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // 全应用只有这一处订阅 WS；卸载时断开（StrictMode 的二次挂载会自动重订）
    const stop = connectEvents();
    void bootAll();
    return stop;
  }, []);

  const retry = useCallback(() => {
    setRetrying(true);
    void bootAll().finally(() => setRetrying(false));
  }, []);

  return (
    <div className="kd-app">
      <TitleBar />

      <div className="kd-body">
        {connected ? (
          <Workspace />
        ) : (
          <section className="kd-section">
            {booting || retrying ? (
              <EmptyState
                icon={<LoaderCircle className="kd-spin" size={22} />}
                title="正在连接本地服务"
                hint="KumoDeck 的下载与分析都跑在本机的 Python sidecar 里，首次启动需要几秒。"
              />
            ) : (
              <EmptyState
                icon={<PlugZap size={22} />}
                title="本地服务未连接"
                hint={
                  bootError
                    ? `无法访问 sidecar：${bootError}。确认 sidecar 已随应用启动（npm run sidecar:setup 装过依赖），然后重试。`
                    : "无法访问 sidecar。确认它已随应用启动，然后重试。"
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
      <Toasts />
    </div>
  );
}
