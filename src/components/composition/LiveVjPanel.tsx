import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Select } from "../common/Select";
import { ArrowLeft, Check, GripVertical, Plus, Play, Square, Trash2, Settings2, Monitor, Mic, RefreshCw, Video, BarChart3, X } from "lucide-react";
import { useLiveVjStatus } from "../../lib/useLiveVjStatus";
import { useLiveVjStore } from "../../stores/liveVjStore";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { liveVjActive, liveVjApi, liveVjRunning, liveVjBluetoothSupported, liveVjChannelLabel, type LiveVjInputDevice } from "../../lib/liveVj";
import { api } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import { QueueCover } from "../queue/QueuePrimitives";
import { WorkshopToolbar, WorkshopToolbarTarget } from "./WorkshopToolbar";
import { LiveVjDiagnostics } from "./LiveVjDiagnostics";
import { LiveVjProjection } from "./LiveVjProjection";
import { LiveVjConnections } from "./LiveVjConnections";
import { LiveVjAudioOptions } from "./LiveVjAudioOptions";
import { LiveVjAudioRoute, LiveVjMasterCopyGuide, useLiveVjAudioRouting } from "./LiveVjAudioRouting";
import { LiveVjSender, LiveVjBluetoothStatus } from "./LiveVjSender";
import "./LiveVjPanel.css";

type Device = {id: string; label: string};
type PanelProps = {backTarget?: HTMLElement | null; toolbarTarget?: HTMLElement | null};
export function LiveVjPanel(props: PanelProps) {
  const {mode, setMode, view, busy} = useLiveVjStore();
  const running = liveVjRunning(view);
  const shown = running ? (view?.mode === "send" ? "send" : "vj") : mode;
  useLiveVjStatus();
  return <div className="kd-live-vj-shell">
    {liveVjBluetoothSupported() && <div className="kd-live-vj-modes" role="group" aria-label="运行模式">
      <button type="button" aria-pressed={shown === "vj"} disabled={busy || running} onClick={() => setMode("vj")}>实时 VJ</button>
      <button type="button" aria-pressed={shown === "send"} disabled={busy || running} onClick={() => setMode("send")}>音频发送</button>
    </div>}
    {shown === "send" ? <LiveVjSender toolbarTarget={props.toolbarTarget}/> : <LiveVjWorkspace {...props}/>}
  </div>;
}
function LiveVjWorkspace({backTarget, toolbarTarget}: PanelProps) {
  const {document, activeId, view: sessionView, logs, busy, error, initialize, edit, select, start, stop} = useLiveVjStore();
  const view = sessionView?.mode === "send" ? null : sessionView;
  const running = liveVjActive(view);
  const [devices, setDevices] = useState<{inputs: LiveVjInputDevice[]; outputs: Device[]}>({inputs: [], outputs: []});
  const [output, setOutput] = useState("auto");
  const routing = useLiveVjAudioRouting(devices.inputs, running ? view?.input_device : undefined);
  const {input, setInput, selected: inputDevice} = routing;
  // First pair is the conservative default, not a claim that it is Master.
  // Keep explicit choices while switching devices; never reset on refresh.
  const [channelStarts, setChannelStarts] = useState<Record<string, number>>({});
  const channelStart = running ? view?.input_channel_start ?? 0 : channelStarts[input] ?? 0;
  const channelPairs = Array.from({length: Math.ceil((inputDevice?.channels ?? 0) / 2)}, (_, i) => {
    const start = i * 2;
    return {start, label: liveVjChannelLabel(inputDevice!, start)};
  });
  const [devicesLoading, setDevicesLoading] = useState(true), [deviceError, setDeviceError] = useState("");
  const [inputError, setInputError] = useState("");
  const [notice, setNotice] = useState(""), [creating, setCreating] = useState(false), [name, setName] = useState("");
  const deviceRequest = useRef(0);
  const drag = useRef<(() => void) | null>(null);
  const [reorderBefore, setReorderBefore] = useState<string | null>(null);
  const active = document?.sets.find(s => s.id === activeId);
  const locked = running && view?.set_id === activeId;
  const loadDevices = useCallback(async () => {
    const request = ++deviceRequest.current;
    setDevicesLoading(true); setDeviceError("");
    try {
      const [inputs, outputs] = await Promise.allSettled([liveVjApi.inputs(), liveVjApi.outputs()]);
      if (request === deviceRequest.current) {
        setDevices({inputs: inputs.status === "fulfilled" ? inputs.value : [], outputs: outputs.status === "fulfilled" ? outputs.value : []});
        setInputError(inputs.status === "rejected" ? String(inputs.reason) : "");
        setDeviceError(outputs.status === "rejected" ? String(outputs.reason) : "");
      }
    } catch (error) { if (request === deviceRequest.current) setDeviceError(String(error)); }
    finally { if (request === deviceRequest.current) setDevicesLoading(false); }
  }, []);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    if (running) return;
    void loadDevices();
    const focus = () => { void loadDevices(); };
    window.addEventListener("focus", focus);
    return () => { deviceRequest.current++; window.removeEventListener("focus", focus); };
  }, [running, loadDevices]);
  useEffect(() => { setNotice(""); setCreating(false); }, [activeId]);
  useEffect(() => () => { drag.current?.(); }, [activeId]);
  const reorder = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (!active || event.button !== 0 || busy || running) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); drag.current?.();
    const x = event.clientX, y = event.clientY, pointerId = event.pointerId, setId = active.id;
    const targetAt = (x: number, y: number) => window.document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-live-vj-entry]");
    const cleanup = () => { window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", cleanup, true); window.removeEventListener("blur", cleanup); setReorderBefore(null); drag.current = null; };
    const move = (e: PointerEvent) => { if (e.pointerId === pointerId) setReorderBefore(targetAt(e.clientX, e.clientY)?.dataset.liveVjEntry ?? null); };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      if (Math.hypot(e.clientX - x, e.clientY - y) < 4) return;
      const target = window.document.elementFromPoint(e.clientX, e.clientY);
      if (target?.closest<HTMLElement>("[data-live-vj-set]")?.dataset.liveVjSet !== setId) return;
      void edit({kind: "move", set_id: setId, entry_id: id, before_id: targetAt(e.clientX, e.clientY)?.dataset.liveVjEntry ?? null});
    };
    drag.current = cleanup;
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", up, true); window.addEventListener("pointercancel", cleanup, true); window.addEventListener("blur", cleanup);
  };
  const back = active && <button type="button" className="kd-aside-head-close" aria-label="返回演出列表" title="返回演出列表"
    onClick={() => select(null)}><ArrowLeft size={14}/></button>;
  const phase = view?.phase === "indexing" ? `分析素材 ${view.indexed}/${view.total}`
    : view?.phase === "permission" ? "等待声音输入授权" : view?.phase === "listening" ? "监听中"
    : view?.phase === "matched" ? "已匹配" : view?.phase === "searching" ? "重新搜索 · 沿用上次画面"
    : view?.phase === "prepared" ? "特征索引已就绪"
    : view?.phase === "stopped" ? "已停止" : view?.phase === "failed" ? "运行失败" : "";
  const channelsReady = channelPairs.some(pair => pair.start === channelStart);
  const inputReady = input === "bluetooth" ? liveVjBluetoothSupported() : !inputDevice?.error && channelsReady;
  const devicesReady = !devicesLoading && !deviceError && inputReady && devices.outputs.some(d => d.id === output);
  return <WorkshopToolbarTarget.Provider value={toolbarTarget ?? null}><section className="kd-live-vj vj-workshop vj-task-list" aria-label="自动 VJ" data-live-vj-set={active?.id}>
    {back && (backTarget ? createPortal(back, backTarget) : back)}
    <WorkshopToolbar>
      {active ? <input className="kd-live-vj-name" key={active.id} aria-label="演出名称" defaultValue={active.name} disabled={busy || locked}
        onBlur={e => { const name = e.currentTarget.value.trim(); if (name && name !== active.name) void edit({kind: "rename", set_id: active.id, name}); else e.currentTarget.value = active.name; }}
        onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}/>
        : <button aria-label="新建演出" title="新建演出" disabled={busy || !document} onClick={() => { setCreating(v => !v); setName(""); }}><Plus size={16}/></button>}
      {active && <button aria-label="添加素材" title="添加素材" disabled={busy || running} onClick={() => void liveVjApi.pickFiles().then(paths => paths.length ? useLiveVjStore.getState().import(active.id, [], paths) : undefined).catch(e => setNotice(String(e)))}><Plus size={15}/></button>}
      <span className="vj-spacer"/>
      {active && !running && <button disabled={busy || !active.entries.length || !devicesReady} onClick={() => void start(inputDevice?.resolved_id ?? input, output, channelStart)}><Play size={14}/>开始运行</button>}
      {running && <button disabled={busy} onClick={() => void stop()}><Square size={13}/>停止</button>}
    </WorkshopToolbar>
    {creating && <form className="kd-live-vj-create" onSubmit={e => { e.preventDefault(); if (name.trim() && !busy) void edit({kind: "create", name: name.trim()}); }}>
      <input aria-label="演出名称" autoFocus value={name} onChange={e => setName(e.target.value)} disabled={busy}/>
      <button type="submit" aria-label="创建演出" disabled={busy || !name.trim()}><Check size={14}/></button>
      <button type="button" aria-label="取消新建" onClick={() => setCreating(false)}><X size={14}/></button>
    </form>}
    <fieldset className="kd-live-vj-devices" disabled={busy || running} aria-label="设备设置" aria-busy={devicesLoading}>
      <LiveVjAudioRoute routing={routing} loading={devicesLoading}/>
      <label><Mic size={13}/><span>{routing.secondary ? "播放设备" : "音频来源"}</span><Select aria-label={routing.secondary ? "第二路 Master 播放设备" : "音频捕获设备"} value={input} disabled={devicesLoading || routing.secondary && !routing.choices.length}
        onChange={e => setInput(e.target.value)}>
        {!input && routing.choices.length > 0 && <option value="" disabled/>}
        <LiveVjAudioOptions devices={routing.choices}/>
        {!routing.secondary && liveVjBluetoothSupported() && <option value="bluetooth">蓝牙接收</option>}
        {!devicesLoading && input && input !== "bluetooth" && !inputDevice && <option value={input} disabled>设备已断开</option>}
      </Select></label>
      {input !== "bluetooth" && <label><Settings2 size={13}/><span>捕获声道</span><Select aria-label="音频捕获声道" value={channelStart} disabled={devicesLoading || !channelPairs.length}
        onChange={e => setChannelStarts(old => ({...old, [input]: Number(e.target.value)}))}>
        {channelPairs.map(pair => <option key={pair.start} value={pair.start}>{pair.label}</option>)}
        {!devicesLoading && inputDevice && !inputDevice.error && !channelsReady && <option value={channelStart} disabled>声道已不可用</option>}
      </Select></label>
      }
      <label><Monitor size={13}/><span>画面输出</span><Select aria-label="画面输出设备" value={output} disabled={devicesLoading}
        onChange={e => setOutput(e.target.value)}>{devices.outputs.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
        {!devicesLoading && devices.outputs.length > 0 && !devices.outputs.some(d => d.id === output) && <option value={output} disabled>设备已断开</option>}
      </Select></label>
      <button aria-label="刷新设备" title="刷新设备" disabled={devicesLoading} onClick={() => void loadDevices()}><RefreshCw size={13}/></button>
      <LiveVjMasterCopyGuide routing={routing} channelStart={channelStart}/>
    </fieldset>
    <LiveVjProjection output={output}/>
    {input === "bluetooth" && <LiveVjConnections/>}
    {(error || notice || deviceError || (input !== "bluetooth" && inputError) || inputDevice?.error || view?.error) && <div className="kd-live-vj-error" role="alert">{error || notice || deviceError || (input !== "bluetooth" && inputError) || inputDevice?.error || view?.error}</div>}
    {phase && <div className="kd-live-vj-status" role="status"><span>{document?.sets.find(s => s.id === view?.set_id)?.name}</span><span>{phase}</span></div>}
    {!active ? <div className="vj-task-stack kd-live-vj-sets">{document?.sets.map(s => <section key={s.id} className="vj-task-entry" data-live-vj-set={s.id}>
      <div className="vj-task-heading-row">
        <button className="vj-task-heading" onClick={() => select(s.id)} aria-label={`打开演出 ${s.name}`}><span>{s.name}</span><small>{s.entries.length > 0 && formatDuration(s.entries.reduce((n, e) => n + e.duration, 0))}</small></button>
        {running && view?.set_id === s.id && <span className="kd-live-vj-priority">运行中</span>}
        <button className="kd-live-vj-set-delete" aria-label={`删除 ${s.name}`} title="删除演出" disabled={busy || (running && view?.set_id === s.id)} onClick={() => void edit({kind: "delete", set_id: s.id})}><Trash2 size={15}/></button>
      </div>
      {s.entries.length > 0 && <button className="kd-live-vj-set-preview" aria-label={`查看 ${s.name} 素材`} onClick={() => select(s.id)}>
        <span className="kd-live-vj-set-covers">{s.entries.slice(0, 3).map(entry => <QueueCover key={entry.id} artwork={api.coverUrl(entry.track_id)} video={entry.video}/>)}</span>
        <span className="kd-live-vj-set-info"><span>{s.entries.slice(0, 3).map(entry => entry.title).join(" · ")}</span>
          <small>{s.entries.length} 个素材 · {s.entries.filter(e => e.video).length} 视频 · {s.entries.filter(e => !e.video).length} 可视化</small></span>
      </button>}
    </section>)}</div> : <div className="kd-live-vj-list">
      {active.entries.map((entry, i) => <div className="kd-live-vj-entry" key={entry.id} data-live-vj-entry={entry.id} data-reorder-before={reorderBefore === entry.id || undefined} data-current={(running && view?.matched?.entry.id === entry.id) || undefined}>
        <button disabled={busy || running} aria-label={`拖动排序 ${entry.title}`} title="拖动排序" style={{touchAction: "none"}}
          onPointerDown={e => reorder(e, entry.id)}
          onKeyDown={e => { if (e.key === "ArrowUp" && i > 0 || e.key === "ArrowDown" && i + 1 < active.entries.length) {
            e.preventDefault(); void edit({kind: "move", set_id: active.id, entry_id: entry.id, before_id: active.entries[e.key === "ArrowUp" ? i - 1 : i + 2]?.id ?? null});
          } }}><GripVertical size={13}/></button>
        <span className="kd-mono">{i + 1}</span><QueueCover artwork={api.coverUrl(entry.track_id)} video={entry.video}/>
        <div className="kd-live-vj-entry-info"><span title={entry.path}>{entry.title}</span>
          <div>{entry.video ? <Video size={11}/> : <BarChart3 size={11}/>}<small>{formatDuration(entry.duration)}</small>
          {!entry.video && <button aria-label={`编辑 ${entry.title} 可视化`} title="编辑可视化" onClick={() => void api.track(entry.track_id).then(track => useVisualizerStudioStore.getState().open(track)).catch(e => setNotice(String(e)))}><Settings2 size={12}/></button>}
          {running && view?.priority.includes(entry.id) && <small className="kd-live-vj-priority">{view.priority[0] === entry.id ? "当前" : "下一首"}</small>}</div></div>
        <button aria-label={`移除 ${entry.title}`} disabled={busy || locked} onClick={() => void edit({kind: "remove", set_id: active.id, entry_id: entry.id})}><Trash2 size={13}/></button>
      </div>)}
    </div>}
    <LiveVjBluetoothStatus link={view?.bluetooth}/>
    {view?.session && (!active || view.set_id === active.id) && <LiveVjDiagnostics view={view} logs={logs}/>}
  </section></WorkshopToolbarTarget.Provider>;
}
