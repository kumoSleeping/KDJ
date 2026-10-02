import { useState } from "react";
import { Image, Monitor, X } from "lucide-react";
import { liveVjApi } from "../../lib/liveVj";
import { useLiveVjStore } from "../../stores/liveVjStore";
export function LiveVjProjection({output}: {output: string}) {
  const {document, view, busy, setStandby, refresh} = useLiveVjStore();
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const toggle = async () => {
    setPending(true); setError("");
    try { if (view?.projection_open) await liveVjApi.closeProjection(); else await liveVjApi.openProjection(output); await refresh(); }
    catch (e) { setError(String(e)); } finally { setPending(false); }
  };
  return <section className="kd-live-vj-projection" aria-label="屏幕投放">
    <div className="kd-live-vj-projection-actions">
      <button disabled={busy || !document} onClick={() => void setStandby()}><Image size={14}/>默认画面</button>
      {document?.standby && <><span title={document.standby.path}>{document.standby.name}</span>
        <button aria-label="移除默认画面" title="移除默认画面" disabled={busy} onClick={() => void setStandby(true)}><X size={13}/></button></>}
      <button disabled={pending || busy} onClick={() => void toggle()}><Monitor size={14}/>{view?.projection_open ? "关闭投放" : "开启投放"}</button>
    </div>
    {(error || view?.projection_error) && <div className="kd-live-vj-error" role="alert">{error || view?.projection_error}</div>}
  </section>;
}
