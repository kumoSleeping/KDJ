import { lazy, Suspense, useEffect } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { connectEvents, selectConnected, useAppStore } from "../../stores/appStore";
import type { KvjTab } from "../../stores/kvjStore";
import { api } from "../../lib/api";
import { TaskBubbleHost } from "../tasks/TaskBubbleHost";
import { AppChrome } from "../chrome/AppChrome";
import { ChromeThemeButton } from "../chrome/ChromeActions";
import "./KvjApp.css";

const SettingsPanel = lazy(() => import("../settings/SettingsPanel").then(module => ({ default: module.SettingsPanel })));
const labels: Record<KvjTab, string> = { visualizer: "歌曲可视化", preferences: "偏好设置" };
let bootingWindow: Promise<void> | null = null;
function bootEditor(): Promise<void> {
  if (bootingWindow) return bootingWindow;
  useAppStore.setState({ booting: true });
  bootingWindow = Promise.all([api.health(), api.getSettings(), api.cachedAccounts()])
    .then(([health, settings, accounts]) => { useAppStore.setState({ health, settings, accounts, bootError: "" }); })
    .catch(error => { useAppStore.setState({ bootError: String(error) }); })
    .finally(() => { useAppStore.setState({ booting: false }); bootingWindow = null; });
  return bootingWindow;
}

function EditorPanel({ tab }: { tab: KvjTab }) {
  return <section className="kd-kvj-panel" aria-label={labels[tab]}>
    <div className="kd-kvj-content">
      {tab === "preferences" ? <Suspense fallback={null}><SettingsPanel preferences /></Suspense>
        // The visualizer window stays hidden and only runs the export queue (kvjWindow):
        // the configuration itself is an app of the main window's right column.
        : null}
    </div>
  </section>;
}

/** Window identity is fixed: opening another tool never unmounts this editor. */
export function KvjApp({ tab }: { tab: KvjTab }) {
  const connected = useAppStore(selectConnected), booting = useAppStore(state => state.booting);
  const error = useAppStore(state => state.bootError);
  const ready = connected && !booting;
  const platform = window.kdj?.platform;
  useEffect(() => {
    const stop = connectEvents();
    void bootEditor();
    return stop;
  }, []);
  return <div className={`kd-app ${tab === "preferences" ? "kd-preferences-app" : "kd-kvj-app"}`}
    data-mac={platform === "darwin" ? "true" : undefined} data-work-mode="manager">
    {tab !== "preferences" && <AppChrome history={<span className="kd-kvj-chrome-title">{labels[tab]}</span>}
      actions={<div className="kd-chrome-actions" role="group" aria-label="顶栏工具"><ChromeThemeButton /></div>}
      showWindowControls={platform === "win32" || platform === "linux"} />}
    {ready ? <EditorPanel tab={tab} />
      : <div className="kd-kvj-loading" role="status">{booting ? <LoaderCircle className="kd-spin" size={20} />
        : <><span>{error}</span><button type="button" aria-label="重试连接" title="重试连接" onClick={() => void bootEditor()}><RefreshCw size={16} /></button></>}</div>}
    <TaskBubbleHost sources={["exports"]} />
  </div>;
}
