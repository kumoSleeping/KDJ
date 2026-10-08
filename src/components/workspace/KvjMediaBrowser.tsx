import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileVideo, Music2, Plus, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import { formatTime, projectDuration } from "../../lib/workshop";
import { finishTrackDrop, writeTrackDragData } from "../../lib/trackDrag";
import { useWorkshopStore } from "../../stores/workshopStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { TrackPage } from "../../types";
import { Select } from "../common/Select";
import { InlineNotice } from "../common/InlineNotice";
import { EditorTabs } from "./EditorChrome";

const browserTabs = [{ id: "projects", label: "工程" }, { id: "library", label: "曲库" }, { id: "exports", label: "已导出" }] as const;
type BrowserTab = typeof browserTabs[number]["id"];

/** A selection here is editorial, never a DJ play intent. */
export function KvjMediaBrowser() {
  const projects = useWorkshopStore(s => s.projects), active = useWorkshopStore(s => s.activeId);
  const jobs = useWorkshopStore(s => s.jobs), saving = useWorkshopStore(s => s.saving);
  const libraryStats = useLibraryStore(s => s.stats);
  const [tab, setTab] = useState<BrowserTab>("projects");
  const listId = useId();
  const [query, setQuery] = useState(""), [media, setMedia] = useState<"" | "audio" | "video">("");
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<TrackPage | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [selected, setSelected] = useState<number | null>(null);
  const pageKey = useRef("");
  useEffect(() => {
    if (tab !== "library") return;
    let canceled = false;
    // Focus/stat refreshes keep the visible page (and its scroll) until the reply lands;
    // only a different query, filter or page offset clears the list.
    const key = JSON.stringify([query, media, offset]);
    if (pageKey.current !== key) { pageKey.current = key; setPage(null); }
    setLoading(true); setError("");
    const timer = window.setTimeout(() => {
      void api.tracks({ q: query, media: media || undefined, offset, limit: 60, sort: "title", order: "asc" })
        .then(result => { if (!canceled) setPage(result); })
        .catch(e => { if (!canceled) setError(String(e)); })
        .finally(() => { if (!canceled) setLoading(false); });
    }, 180);
    return () => { canceled = true; clearTimeout(timer); };
  }, [tab, query, media, offset, refresh, libraryStats]);
  useEffect(() => {
    const update = () => setRefresh(value => value + 1);
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);
  const add = (id: number) => { void useWorkshopStore.getState().add([id]); };
  return <div className="kd-kvj-browser" data-kvj-region="browser">
    <EditorTabs<BrowserTab> label="素材浏览器" tabs={browserTabs} value={tab} onChange={setTab} panelId={listId}>
      {tab === "projects" ? <button type="button" aria-label="新建工程" title="新建工程" disabled={saving > 0} onClick={() => void useWorkshopStore.getState().createProject()}><Plus size={14} /></button>
        : <button type="button" aria-label="刷新素材" title="刷新素材" onClick={() => { setRefresh(value => value + 1); void useWorkshopStore.getState().refresh(); }}><RefreshCw size={14} /></button>}
    </EditorTabs>
    {tab === "library" && <div className="kd-kvj-browser-filter">
      <input type="search" aria-label="搜索曲库素材" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} />
      <Select aria-label="素材类型" value={media} onChange={e => { const value = e.target.value; setMedia(value === "audio" || value === "video" ? value : ""); setOffset(0); }}>
        <option value="">全部</option><option value="audio">音频</option><option value="video">视频</option>
      </Select>
    </div>}
    <InlineNotice text={error} />
    <div id={listId} role="tabpanel" className="kd-kvj-browser-list" aria-busy={tab === "library" && loading}>
      {tab === "projects" && projects.map(p => <button key={p.id} type="button" className="kd-kvj-source" aria-pressed={p.id === active}
        onClick={() => { if (p.id !== active) void useWorkshopStore.getState().selectProject(p.id); }}>
        <FileVideo size={16} /><span><strong>{p.name}</strong><small>{formatTime(projectDuration(p))}</small></span>
      </button>)}
      {tab === "library" && page?.items.map(track => <div key={track.id} className="kd-kvj-source" data-selected={selected === track.id || undefined}
        draggable onDragStart={e => writeTrackDragData(e.dataTransfer, [track.id])} onDragEnd={finishTrackDrop}>
        <button type="button" className="kd-kvj-source-main" aria-pressed={selected === track.id} onClick={() => setSelected(track.id)}
          onDoubleClick={() => add(track.id)} title={track.path}>
          {["mp4", "mkv", "webm", "mov", "avi", "m4v"].includes(track.format.toLowerCase()) ? <FileVideo size={16} /> : <Music2 size={16} />}<span><strong>{track.title || track.filename}</strong><small>{[track.artist, formatDuration(track.duration ?? 0)].filter(Boolean).join(" · ")}</small></span>
        </button>
        <button type="button" aria-label={`加入时间线：${track.title || track.filename}`} title="加入时间线" disabled={saving > 0} onClick={() => add(track.id)}><Plus size={14} /></button>
      </div>)}
      {tab === "exports" && jobs.filter(job => job.phase === "complete" && job.path).map(job => <div className="kd-kvj-source" key={job.id}>
        <button type="button" className="kd-kvj-source-main" title={job.path} onClick={() => void window.kdj?.revealPath(job.path).catch(e => setError(String(e)))}>
          <FileVideo size={16} /><span><strong>{job.path.split(/[\\/]/).pop()}</strong><small>{projects.find(p => p.id === job.project_id)?.name}</small></span>
        </button>
        {job.track_id !== null && <button type="button" aria-label="将成品加入时间线" title="将成品加入时间线" disabled={saving > 0} onClick={() => add(job.track_id!)}><Plus size={14} /></button>}
      </div>)}
    </div>
    {tab === "library" && page && page.total > 60 && <footer className="kd-kvj-browser-pages">
      <button type="button" aria-label="上一页素材" title="上一页" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 60))}><ChevronLeft size={14} /></button>
      <span>{offset + 1}–{Math.min(offset + page.items.length, page.total)} / {page.total}</span>
      <button type="button" aria-label="下一页素材" title="下一页" disabled={offset + 60 >= page.total || loading} onClick={() => setOffset(value => value + 60)}><ChevronRight size={14} /></button>
    </footer>}
  </div>;
}
