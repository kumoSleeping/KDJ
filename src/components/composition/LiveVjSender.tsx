import { useCallback, useEffect, useRef, useState } from "react";
import { Bluetooth, Mic, Play, RefreshCw, Settings2, Square } from "lucide-react";
import { liveVjApi, liveVjRunning, liveVjChannelLabel, type BluetoothDevice, type LiveVjBluetooth, type LiveVjInputDevice } from "../../lib/liveVj";
import { useLiveVjStore } from "../../stores/liveVjStore";
import { WorkshopToolbar, WorkshopToolbarTarget } from "./WorkshopToolbar";
import { LiveVjAudioOptions } from "./LiveVjAudioOptions";
import { LiveVjAudioRoute, LiveVjMasterCopyGuide, useLiveVjAudioRouting } from "./LiveVjAudioRouting";
import { Select } from "../common/Select";

const linkNames: Record<string, string> = {
  listening: "蓝牙监听中", capturing: "启动声音输入", connecting: "正在连接", sending: "发送中", receiving: "已连接发送端",
  connected: "已连接", reconnecting: "正在重连", disconnected: "蓝牙已断开", failed: "蓝牙连接失败", stopped: "已停止",
};
export function LiveVjBluetoothStatus({link}: {link: LiveVjBluetooth | null | undefined}) {
  if (!link?.state) return null;
  return <div className="kd-live-vj-link" aria-label="蓝牙连接状态">
    <div className="kd-live-vj-status" role="status"><span>{linkNames[link.state] ?? link.state}</span><span>{link.peer}</span></div>
    {(link.packets > 0 || link.rtt_ms !== null) && <div className="kd-live-vj-input">
      {link.packets > 0 && <span>{link.packets} 包 · {(link.bytes / 1024).toFixed(1)} KB</span>}
      {link.rtt_ms !== null && <span>往返 {link.rtt_ms.toFixed(0)} ms</span>}
      {link.clock_uncertainty_ms !== null && <span>时钟不确定度约 ±{link.clock_uncertainty_ms.toFixed(0)} ms</span>}
      {link.data_age_ms !== null && <span>数据龄 {link.data_age_ms.toFixed(0)} ms</span>}
      {link.gaps > 0 && <span>不连续 {link.gaps} 次</span>}
    </div>}
    {link.error && <div className="kd-live-vj-error" role="alert">{link.error}</div>}
  </div>;
}

export function LiveVjSender({toolbarTarget}: {toolbarTarget?: HTMLElement | null}) {
  const {view: sessionView, busy, error, sendStart, stop, refresh} = useLiveVjStore();
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const outgoing = sessionView?.connections?.outgoing ?? [];
  const view = sessionView?.mode === "send" ? sessionView : null;
  const running = liveVjRunning(sessionView);
  const [inputs, setInputs] = useState<LiveVjInputDevice[]>([]);
  const routing = useLiveVjAudioRouting(inputs, running ? view?.input_device : undefined);
  const {input, setInput, selected} = routing;
  const [channels, setChannels] = useState<Record<string, number>>({});
  const [peers, setPeers] = useState<BluetoothDevice[]>([]);
  const [chosenPeerId, setPeerId] = useState("");
  const peerId = running ? view?.send_target ?? chosenPeerId : chosenPeerId;
  const [loading, setLoading] = useState(false), [scanning, setScanning] = useState(false);
  const [deviceError, setDeviceError] = useState(""), [scanError, setScanError] = useState("");
  const epoch = useRef(0), mounted = useRef(true);
  const load = useCallback(async () => {
    const request = ++epoch.current; setLoading(true); setDeviceError("");
    try { const found = await liveVjApi.inputs(); if (mounted.current && request === epoch.current) setInputs(found); }
    catch (e) { if (mounted.current && request === epoch.current) setDeviceError(String(e)); }
    finally { if (mounted.current && request === epoch.current) setLoading(false); }
  }, []);
  const known = useCallback(async () => {
    try { const found = await liveVjApi.scanBluetooth(false); if (mounted.current) { setPeers(found); setScanError(""); } }
    catch (e) { if (mounted.current) setScanError(String(e)); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); void known(); window.addEventListener("focus", known);
    return () => { mounted.current = false; epoch.current++; window.removeEventListener("focus", known); }; }, [load, known]);
  const scan = async () => {
    if (scanning || running || busy) return;
    setScanning(true); setScanError("");
    try {
      const found = await liveVjApi.scanBluetooth(true);
      if (mounted.current) { setPeers(found.sort((a, b) => Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name))); }
    } catch (e) { if (mounted.current) setScanError(String(e)); }
    finally { if (mounted.current) setScanning(false); }
  };
  const channelStart = running ? view?.input_channel_start ?? 0 : channels[input] ?? 0;
  const pairs = Array.from({length: Math.ceil((selected?.channels ?? 0) / 2)}, (_, i) => i * 2);
  const available = [...peers, ...outgoing.filter(p => !peers.some(d => d.id === p.device.id)).map(p => p.device)];
  const peer = available.find(device => device.id === peerId);
  const link = outgoing.find(p => p.device.id === peerId);
  const ready = !loading && !scanning && !deviceError && selected && !selected.error && pairs.includes(channelStart)
    && peer && link?.link.state === "connected" && link.selected;
  const connection = async (device: BluetoothDevice, disconnect: boolean) => {
    setConnectionBusy(device.id); setScanError("");
    try { if (disconnect) await liveVjApi.disconnectBluetooth(device.id); else await liveVjApi.connectBluetooth(device); await refresh(); }
    catch (e) { setScanError(String(e)); } finally { setConnectionBusy(null); }
  };
  return <WorkshopToolbarTarget.Provider value={toolbarTarget ?? null}>
    <section className="kd-live-vj vj-workshop" aria-label="音频发送">
      <WorkshopToolbar>
        <button disabled={busy || running || scanning} onClick={() => void scan()}><Bluetooth size={14}/>{scanning ? "扫描中" : "扫描设备"}</button>
        <button disabled={scanning} onClick={() => void known()}><RefreshCw size={13}/>已添加设备</button>
        <button onClick={() => void liveVjApi.pairBluetooth().catch(e => setScanError(String(e)))}>系统配对</button>
        <span className="vj-spacer"/>
        {running ? <button disabled={busy} onClick={() => void stop()}><Square size={13}/>停止</button>
          : <button disabled={busy || !ready} onClick={() => { if (peer) void sendStart(selected?.resolved_id ?? input, channelStart, peer); }}><Play size={14}/>开始发送</button>}
      </WorkshopToolbar>
      <fieldset className="kd-live-vj-devices" disabled={busy || running} aria-label="音频采集设备" aria-busy={loading}>
        <LiveVjAudioRoute routing={routing} loading={loading}/>
        <label><Mic size={13}/><span>{routing.secondary ? "播放设备" : "音频来源"}</span><Select aria-label={routing.secondary ? "发送第二路 Master 播放设备" : "发送音频捕获设备"} value={input} disabled={loading || !routing.choices.length} onChange={e => setInput(e.target.value)}>
          {!input && routing.choices.length > 0 && <option value="" disabled/>}
          <LiveVjAudioOptions devices={routing.choices}/>
          {!loading && input && !selected && <option value={input} disabled>设备已断开</option>}
        </Select></label>
        <label><Settings2 size={13}/><span>捕获声道</span><Select aria-label="发送音频捕获声道" value={channelStart} disabled={loading || !pairs.length}
          onChange={e => setChannels(old => ({...old, [input]: Number(e.target.value)}))}>
          {pairs.map(start => <option key={start} value={start}>{liveVjChannelLabel(selected!, start)}</option>)}
          {!loading && selected && !selected.error && !pairs.includes(channelStart) && <option value={channelStart} disabled>声道已不可用</option>}
        </Select></label>
        <button aria-label="刷新音频设备" title="刷新音频设备" disabled={loading} onClick={() => void load()}><RefreshCw size={13}/></button>
        <LiveVjMasterCopyGuide routing={routing} channelStart={channelStart}/>
      </fieldset>
      {(error || deviceError || scanError || selected?.error || view?.error) && <div className="kd-live-vj-error" role="alert">{error || deviceError || scanError || selected?.error || view?.error}</div>}
      <div className="kd-live-vj-peers" role="group" aria-label="发送目标设备" aria-busy={scanning}>
        {available.map(device => {
          const connected = outgoing.find(p => p.device.id === device.id);
          return <div key={device.id} className="kd-live-vj-peer-row">
            <button type="button" aria-pressed={peerId === device.id} disabled={running || busy} onClick={() => setPeerId(device.id)}>
              <Bluetooth size={14}/><span>{device.name}</span><small>{device.id}</small>
            </button>
            <span>{connected ? `${linkNames[connected.link.state] ?? connected.link.state}${connected.selected ? " · 当前 DJ" : connected.link.state === "connected" ? " · 待命" : ""}` : device.paired ? "已添加" : "未配对"}</span>
            {device.paired ? <button disabled={connectionBusy !== null} onClick={() => void connection(device, Boolean(connected))}>{connected ? "断开" : "连接"}</button>
              : <button onClick={() => void liveVjApi.pairBluetooth().catch(e => setScanError(String(e)))}>系统配对</button>}
            {connected?.link.error && <div className="kd-live-vj-error" role="alert">{connected.link.error}</div>}
          </div>;
        })}
      </div>
      <LiveVjBluetoothStatus link={outgoing.find(p => p.device.id === view?.send_target)?.link ?? view?.bluetooth}/>
      {view?.input && <div className="kd-live-vj-input" aria-label="采集电平">
        <span>{view.input.source}</span>
        {view.input.channels.map(channel => <span key={channel.name} className="kd-live-vj-channel"><span>{channel.name}</span>
          <meter min={-70} max={0} value={channel.rms_dbfs} aria-label={`${channel.name} 电平`}/></span>)}
      </div>}
    </section>
  </WorkshopToolbarTarget.Provider>;
}
