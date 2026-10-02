import { useState } from "react";
import { Bluetooth, Check, Square } from "lucide-react";
import { liveVjApi } from "../../lib/liveVj";
import { useLiveVjStore } from "../../stores/liveVjStore";
export function LiveVjConnections() {
  const {view, refresh} = useLiveVjStore();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const connections = view?.connections;
  const select = async (id: string | null) => {
    setBusy(true); setError("");
    try { await liveVjApi.selectBluetooth(id); await refresh(); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <section className="kd-live-vj-connections" aria-label="DJ 连接">
    {connections?.incoming.map(peer => <div key={peer.link.peer} className="kd-live-vj-peer-row" data-selected={peer.selected || undefined}>
      <Bluetooth size={13}/><span>{peer.device.name}</span>
      <span>{peer.selected ? "当前 DJ" : peer.link.state === "connected" ? "已连接 · 待命" : peer.link.state === "connecting" ? "连接中" : "已断开"}</span>
      {peer.selected
        ? <button disabled={busy} onClick={() => void select(null)}><Square size={12}/>结束当前 DJ</button>
        : <button disabled={busy || peer.link.state !== "connected"} onClick={() => void select(peer.link.peer)}><Check size={12}/>设为当前 DJ</button>}
      {peer.link.error && <div className="kd-live-vj-error" role="alert">{peer.link.error}</div>}
    </div>)}
    {(error || connections?.error) && <div className="kd-live-vj-error" role="alert">{error || connections?.error}</div>}
  </section>;
}
