import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { connectEvents, selectConnected, useAppStore } from "../../stores/appStore";
import { acceptKvjRequest, useKvjStore, type KvjTab } from "../../stores/kvjStore";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { useToastStore } from "../../stores/toastStore";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useWorkshopDrop } from "../../lib/workshopDrop";
import { api } from "../../lib/api";
import { ToastHost } from "../common";
import { CompositionWorkshop } from "../composition/CompositionWorkshop";
import { LiveVjPanel } from "../composition/LiveVjPanel";
import "./KvjApp.css";

const VisualizerStudioPanel = lazy(() => import("../composition/VisualizerStudioPanel"));
const tabs: [KvjTab, string][] = [["workshop", "剪辑"], ["live-vj", "实时"], ["visualizer", "可视化"]];
let bootingWindow: Promise<void> | null = null;
function bootKvj(): Promise<void> {
  if (bootingWindow) return bootingWindow;
  useAppStore.setState({ booting: true });
  bootingWindow = Promise.all([api.health(), api.getSettings()])
    .then(([health, settings]) => { useAppStore.setState({ health, settings, bootError: "" }); })
    .catch(error => { useAppStore.setState({ bootError: String(error) }); })
    .finally(() => { useAppStore.setState({ booting: false }); bootingWindow = null; });
  return bootingWindow;
}

function KvjPanel({ tab, active }: { tab: KvjTab; active: boolean }) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [back, setBack] = useState<HTMLSpanElement | null>(null);
  return <section className="kd-kvj-panel" hidden={!active} aria-label={tabs.find(item => item[0] === tab)?.[1]}>
    {tab !== "visualizer" && <header className="kd-kvj-tools"><span ref={setBack} /><div ref={setToolbar} /></header>}
    <div className="kd-kvj-content">
      {tab === "workshop" ? <CompositionWorkshop toolbarTarget={toolbar} backTarget={back} />
        : tab === "live-vj" ? <LiveVjPanel toolbarTarget={toolbar} backTarget={back} />
        : <Suspense fallback={null}><VisualizerStudioPanel onClose={() => { const editor = useVisualizerStudioStore.getState(); if (editor.beforeClose) void editor.beforeClose(); else editor.close(); }} /></Suspense>}
    </div>
  </section>;
}

export function KvjApp() {
  const connected = useAppStore(selectConnected), booting = useAppStore(state => state.booting);
  const error = useAppStore(state => state.bootError);
  const tab = useKvjStore(state => state.tab);
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack);
  const [visited, setVisited] = useState<Set<KvjTab>>(() => new Set([tab]));
  const ready = connected && !booting;
  useWorkshopDrop(ready);
  useEffect(() => {
    const stop = connectEvents();
    void bootKvj();
    return stop;
  }, []);
  useEffect(() => { setVisited(previous => previous.has(tab) ? previous : new Set([...previous, tab])); }, [tab]);
  const navigate = (next: KvjTab) => {
    void acceptKvjRequest({ tab: next }).catch(error => useToastStore.getState().show(String(error)));
  };
  return <div className="kd-app kd-kvj-app" data-work-mode="manager">
    <nav className="kd-kvj-nav" aria-label="KVJ 工作区">
      {tabs.map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => navigate(id)}>{label}</button>)}
      {tab === "visualizer" && track && track.id > 0 && <button type="button" className="kd-kvj-current" title="编辑当前播放的可视化"
        onClick={() => void acceptKvjRequest({ tab: "visualizer", track }).catch(error => useToastStore.getState().show(String(error)))}>{track.title}</button>}
    </nav>
    {ready ? tabs.filter(([id]) => visited.has(id) || id === tab).map(([id]) => <KvjPanel key={id} tab={id} active={id === tab} />)
      : <div className="kd-kvj-loading" role="status">{booting ? <LoaderCircle className="kd-spin" size={20} />
        : <><span>{error}</span><button type="button" aria-label="重试连接" onClick={() => void bootKvj()}><RefreshCw size={16} /></button></>}</div>}
    <ToastHost />
  </div>;
}
