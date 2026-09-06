import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Plus,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Magnet,
  MoreHorizontal,
  Pause,
  Play,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  PictureInPicture2,
  X,
} from "lucide-react";
import { useCompositionStore } from "../../stores/compositionStore";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  isVisualSource,
  adjustClip,
  cloneProject,
  deleteClip,
  duplicateClip,
  findClip,
  formatTime,
  moveLayer,
  projectDuration,
  splitClip,
} from "../../lib/workshop";
import { useWorkshopPlayback } from "../../lib/workshopPlayback";
import { WorkshopFloatingPreview } from "./WorkshopFloatingPreview";
import { WorkshopTimeline } from "./WorkshopTimeline";
import { WorkshopClipMenu } from "./WorkshopClipMenu";
import { WorkshopPictureTools } from "./WorkshopPictureTools";
import { WorkshopExportSettings } from "./WorkshopExport";
import { canCancelExport } from "./WorkshopCancelButton";
import { QueueStateMark } from "../queue/QueuePrimitives";
import { api } from "../../lib/api";
import { useWorkshopUndoShortcuts } from "../../lib/useWorkshopUndoShortcuts";
import { WorkshopCancelButton } from "./WorkshopCancelButton";
import { WorkshopTaskSummary } from "./WorkshopTaskSummary";
import {
  isTrackDrag,
  readTrackDragIds,
  finishTrackDrop,
} from "../../lib/trackDrag";
function WorkshopEditor() {
  const p = useWorkshopStore((s) => s.draft),
    selected = useWorkshopStore((s) => s.selectedId),
    saving = useWorkshopStore((s) => s.saving),
    error = useWorkshopStore((s) => s.error),
    past = useWorkshopStore((s) => s.past.length),
    future = useWorkshopStore((s) => s.future.length),
    snap = useWorkshopStore((s) => s.snap),
    jobs = useWorkshopStore(s => s.jobs);
  const legacyTasks = useCompositionStore((s) => s.tasks),
    legacyError = useCompositionStore((s) => s.error);
  const legacy = legacyTasks.filter((t) => t.phase === "import_failed");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [clipMenu, setClipMenu] = useState<{id: string; x: number; y: number} | null>(null),
    [more, setMore] = useState(false),
    [align, setAlign] = useState(false),
    [reference, setReference] = useState("");
  const playback = useWorkshopPlayback(),
    root = useRef<HTMLDivElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const cropId = useWorkshopStore(s => s.cropId);
  const trimPreview = useWorkshopStore(s => s.trimPreview);
  const hasVideo = Boolean(p?.layers.some(l => isVisualSource(p.sources.find(s => s.id === l.source_id))));
  const togglePlayback = () => {
    if (!playback.playing && hasVideo) setPreviewOpen(true);
    playback.toggle();
  };
  useEffect(() => {
    if ((playback.playing || trimPreview || cropId) && hasVideo) setPreviewOpen(true);
  }, [playback.playing, trimPreview, cropId, hasVideo]);
  useWorkshopUndoShortcuts(root);
  useEffect(() => {
    void useWorkshopStore.getState().refresh();
    root.current?.focus({ preventScroll: true });
    return () => {
      void useWorkshopStore.getState().flush();
    };
  }, []);
  useEffect(() => {
    if (p?.id) void useWorkshopStore.getState().refreshPositions();
  }, [p?.id]);
  const c = p && findClip(p, selected),
    layer = p?.layers.find((l) => l.clips.some((c) => c.id === selected)),
    layerIndex = layer ? p!.layers.indexOf(layer) : -1;
  const edit = (
    f: Parameters<ReturnType<typeof useWorkshopStore.getState>["edit"]>[0],
  ) => useWorkshopStore.getState().edit(f);
  const cut = () => {
    const s = useWorkshopStore.getState();
    if (s.selectedId) edit((p) => splitClip(p, s.selectedId!, s.position));
  };
  const remove = (ripple = false) => {
    const s = useWorkshopStore.getState();
    if (s.selectedId) {
      edit((p) => deleteClip(p, s.selectedId!, ripple));
      useWorkshopStore.getState().select(null);
    }
  };
  const nudge = (direction: number, large = false) => {
    const s = useWorkshopStore.getState();
    if (!s.draft) return;
    const delta = (1000 / s.draft.canvas.fps) * direction * (large ? 10 : 1);
    if (s.selectedId)
      edit((p) => adjustClip(p, s.selectedId!, s.handle, delta));
    else playback.seek(s.position + delta);
  };
  return (
    <div
      className="vj-workshop"
      ref={root}
      tabIndex={-1}
      aria-label="VJ 剪辑工坊"
      onKeyDownCapture={(e) => {
        if (
          (e.target as HTMLElement).closest(
            "input,select,textarea,[contenteditable=true],.vj-floating-preview,.vj-dialog,.vj-clip-menu,[role=scrollbar],[role=separator],[role=slider]",
          )
        )
          return;
        const key = e.key.toLowerCase();
        if (key === " ") {
          e.preventDefault();
          e.stopPropagation();
          togglePlayback();
        } else if (key === "delete" || key === "backspace") {
          e.preventDefault();
          e.stopPropagation();
          remove(e.shiftKey);
        } else if (key === "s" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          cut();
        } else if (key === "arrowleft" || key === "arrowright") {
          e.preventDefault();
          e.stopPropagation();
          nudge(key === "arrowleft" ? -1 : 1, e.shiftKey);
        } else if (key === "escape") {
          e.preventDefault();
          e.stopPropagation();
          useWorkshopStore.getState().abort();
          useWorkshopStore.setState({cropId:null});
          setMore(false);
          setAlign(false);
          setClipMenu(null);
        }
      }}
      onContextMenu={e => {
        if ((e.target as HTMLElement).closest(".vj-clip-menu")) return;
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-clip-id]")?.dataset.clipId;
        if (!id) return;
        e.preventDefault(); e.stopPropagation();
        useWorkshopStore.getState().select(id);
        const rect = root.current!.getBoundingClientRect();
        setClipMenu({id, x: e.clientX - rect.left, y: e.clientY - rect.top});
      }}
      onDragOver={(e) => {
        if (isTrackDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const ids = readTrackDragIds(e.dataTransfer);
        if (ids.length) {
          e.preventDefault();
          finishTrackDrop();
          void useWorkshopStore.getState().add(ids);
        }
      }}
    >
      <header className="vj-header">
        <button
          type="button"
          aria-label="撤销"
          title="撤销 · ⌘/Ctrl Z"
          disabled={!past}
          onClick={() => useWorkshopStore.getState().undo()}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          aria-label="重做"
          title="重做 · ⌘/Ctrl Shift Z"
          disabled={!future}
          onClick={() => useWorkshopStore.getState().redo()}
        >
          <Redo2 size={16} />
        </button>
        <span className="vj-save-state" role="status">
          {saving ? "保存中" : ""}
        </span>
        <span className="vj-spacer" />
        <div className="vj-menu-anchor">
          <button
            type="button"
            aria-label="作品菜单"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
          >
            <MoreHorizontal size={17} />
          </button>
          {more && (
            <div className="vj-menu">
              {legacy.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setLegacyOpen(true);
                    setMore(false);
                  }}
                >
                  恢复旧导出 · {legacy.length}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  void useWorkshopStore.getState().createProject();
                  setMore(false);
                }}
              >
                新建任务
              </button>
              {p && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void useWorkshopStore.getState().deleteProject();
                      setMore(false);
                    }}
                  >
                    删除任务
                  </button>
                  <label>
                    任务名称
                    <input
                      aria-label="任务名称"
                      value={p.name}
                      onChange={(e) => {
                        const state = useWorkshopStore.getState(),
                          next = cloneProject(state.draft!);
                        next.name = e.target.value;
                        state.transient(next);
                      }}
                      onBlur={() => useWorkshopStore.getState().commit()}
                    />
                  </label>
                </>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className="vj-primary"
          disabled={!p || projectDuration(p) <= 0 || saving > 0 || jobs.some(j => j.project_id === p.id && ["queued","rendering","validating","committing","importing"].includes(j.phase))}
          onClick={() => void useWorkshopStore.getState().export()}
        >
          <Download size={14} />
          导出
        </button>
      </header>
      {error && (
        <div className="vj-error vj-error-banner" role="status">
          {error}
          <button
            type="button"
            aria-label="关闭错误"
            onClick={() => useWorkshopStore.setState({ error: "" })}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <WorkshopExportSettings />
      <nav className="vj-tools" aria-label="剪辑工具">
        <div className="vj-edit-tools">
        <button
          type="button"
          aria-label={playback.playing ? "暂停作品" : "播放作品"}
          aria-busy={playback.loading}
          disabled={!p || projectDuration(p) <= 0}
          onClick={togglePlayback}
        >
          {playback.playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <span className="vj-preparing">
          {playback.loading ? "准备预览" : ""}
        </span>
        <div className="vj-toolbar-divider" />
        <button
          type="button"
          aria-label="向前微调"
          title="前一帧；Shift 十帧"
          onClick={(e) => nudge(-1, e.shiftKey)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          aria-label="向后微调"
          title="后一帧；Shift 十帧"
          onClick={(e) => nudge(1, e.shiftKey)}
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          aria-label="剪断选中片段"
          title="剪断 · S"
          disabled={!c}
          onClick={cut}
        >
          <Scissors size={16} />
        </button>
        <button
          type="button"
          aria-label="复制片段"
          disabled={!c}
          onClick={() => edit((p) => duplicateClip(p, selected!))}
        >
          <Copy size={15} />
        </button>
        <button
          type="button"
          aria-label="删除片段"
          title="删除；Shift 删除并闭合本行空隙"
          disabled={!c}
          onClick={(e) => remove(e.shiftKey)}
        >
          <Trash2 size={15} />
        </button>
        <details className="vj-tools-menu">
          <summary aria-label="更多片段操作">
            <MoreHorizontal size={16} />
          </summary>
          <div className="vj-menu">
            <button type="button" disabled={!c} onClick={() => remove(true)}>
              删除并闭合本行空隙
            </button>
            <button
              type="button"
              disabled={!c || p!.layers.length < 2}
              onClick={() => {
                setReference("");
                setAlign(true);
              }}
            >
              自动对齐
            </button>
          </div>
        </details>
        <div className="vj-toolbar-divider" />
        <button
          type="button"
          aria-label="上移图层"
          disabled={layerIndex <= 0}
          onClick={() => edit((p) => moveLayer(p, layer!.id, layerIndex - 1))}
        >
          <ArrowUp size={15} />
        </button>
        <button
          type="button"
          aria-label="下移图层"
          disabled={layerIndex < 0 || layerIndex === p!.layers.length - 1}
          onClick={() => edit((p) => moveLayer(p, layer!.id, layerIndex + 1))}
        >
          <ArrowDown size={15} />
        </button>
        <button
          type="button"
          aria-label="时间轴吸附"
          aria-pressed={snap}
          onClick={() => useWorkshopStore.setState({ snap: !snap })}
        >
          <Magnet size={15} />
        </button>
        </div>
        <div className="vj-tools-trailing">
        <WorkshopPictureTools />
        <button type="button" aria-label="打开作品预览小窗" title="预览小窗"
          aria-pressed={previewOpen && hasVideo} disabled={!hasVideo}
          onClick={() => setPreviewOpen(v => !v)}><PictureInPicture2 size={16} /></button>
        </div>
      </nav>
      {previewOpen && hasVideo && <WorkshopFloatingPreview playback={playback}
        onClose={() => { setPreviewOpen(false); root.current?.focus({preventScroll: true}); }} />}
      {playback.error && <div className="vj-error vj-error-banner" role="status">{playback.error}</div>}
      {clipMenu && <WorkshopClipMenu {...clipMenu} close={() => setClipMenu(null)} />}
      <WorkshopTimeline playback={playback} />


      {legacyOpen && (
        <div className="vj-dialog-backdrop">
          <section
            className="vj-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="恢复旧导出"
          >
            <header>
              <strong>恢复旧导出</strong>
              <button
                type="button"
                aria-label="关闭旧导出"
                onClick={() => setLegacyOpen(false)}
              >
                <X size={15} />
              </button>
            </header>
            {legacy.map((t) => (
              <div className="vj-export-status" key={t.id}>
                <span>{t.video?.title}</span>
                <span className="vj-output-path">{t.output_path}</span>
                <span className="vj-error">{t.error}</span>
                <button
                  type="button"
                  disabled={t.busy}
                  onClick={() =>
                    void useCompositionStore.getState().start([t.id])
                  }
                >
                  重试入库
                </button>
              </div>
            ))}
            {legacyError && <div className="vj-error">{legacyError}</div>}
          </section>
        </div>
      )}

      {align && p && (
        <div className="vj-dialog-backdrop">
          <section
            className="vj-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="自动对齐"
          >
            <header>
              <strong>自动对齐</strong>
              <button
                type="button"
                aria-label="关闭自动对齐"
                onClick={() => setAlign(false)}
              >
                <X size={15} />
              </button>
            </header>
            <label className="vj-text-field">
              参考片段
              <select
                aria-label="参考片段"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              >
                <option value="" />
                {p.layers
                  .flatMap((l) => l.clips)
                  .filter(
                    (c) =>
                      c.id !== selected &&
                      p.sources.find((s) => s.id === c.source_id)?.audio,
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {p.sources.find((s) => s.id === c.source_id)?.title} ·{" "}
                      {(c.start_ms / 1000).toFixed(3)}s
                    </option>
                  ))}
              </select>
            </label>
            <footer>
              <button
                type="button"
                className="vj-primary"
                disabled={!reference || saving > 0}
                onClick={() => {
                  void useWorkshopStore.getState().align(reference);
                  setAlign(false);
                }}
              >
                对齐
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}


export function CompositionWorkshop() {
  const projects = useWorkshopStore(s => s.projects),
    draft = useWorkshopStore(s => s.draft),
    active = useWorkshopStore(s => s.activeId),
    expanded = useWorkshopStore(s => s.expandedId),
    jobs = useWorkshopStore(s => s.jobs),
    saving = useWorkshopStore(s => s.saving),
    error = useWorkshopStore(s => s.error);
  const submitting = useWorkshopStore(s => s.batchSubmitting);
  const [canceling, setCanceling] = useState(false);
  const [details, setDetails] = useState<Set<string>>(() => new Set());
  const toggleDetails = (id: string) => setDetails(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  useEffect(() => { void useWorkshopStore.getState().refresh(); }, []);
  const toggle = async (id: string) => {
    await useWorkshopStore.getState().flush();
    if (useWorkshopStore.getState().expandedId === id) useWorkshopStore.setState({expandedId: null});
    else await useWorkshopStore.getState().selectProject(id);
  };
  return <div data-vj-drop="" className="vj-workshop vj-task-list" aria-label="VJ 任务列表"
    onDragOver={e => { if (isTrackDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
    onDrop={e => {
      if (e.defaultPrevented) return;
      const ids = readTrackDragIds(e.dataTransfer);
      if (ids.length) { e.preventDefault(); finishTrackDrop(); void useWorkshopStore.getState().add(ids); }
    }}>
    <header className="vj-header">
      <button aria-label="新建任务" disabled={saving > 0} onClick={() => void useWorkshopStore.getState().createProject()}><Plus size={16} /></button>
      <span className="vj-spacer" />
      <button disabled={saving > 0 || submitting || !projects.some(p => projectDuration(p) > 0 && !jobs.some(j => j.project_id === p.id && ["queued","rendering","validating","committing","importing"].includes(j.phase)))} onClick={() => void useWorkshopStore.getState().exportAll()}><Download size={14} />全部导出</button>
      {(submitting || jobs.some(canCancelExport)) && <button disabled={canceling} onClick={() => {
        setCanceling(true); void useWorkshopStore.getState().cancelAllExports().catch(e => useWorkshopStore.setState({error:String(e)})).finally(() => setCanceling(false));
      }}>{canceling ? "正在取消" : "全部取消"}</button>}
    </header>
    {error && expanded === null && <div className="vj-error vj-error-banner" role="status">{error}</div>}
    <div className="vj-task-stack" data-editing={expanded !== null || undefined}>
      {projects.filter(p => expanded === null || p.id === expanded).map(p => {
        const open = expanded === p.id && active === p.id;
        const showDetails = details.has(p.id);
        const job = [...jobs].reverse().find(j => j.project_id === p.id
          && (j.phase !== "complete" || j.revision === p.revision));
        const phase = job ? ({queued:"等待导出",rendering:"导出中",validating:"校验中",committing:"保存中",importing:"入库中",complete:"已导出",failed:"导出失败",import_failed:"入库失败"} as Record<string,string>)[job.phase] : "";
        return <section key={p.id} data-vj-project={p.id} className="vj-task-entry" data-expanded={open || undefined}>
          <div className="vj-task-heading-row"><button className="vj-task-heading" aria-expanded={showDetails} aria-label={`展开详情 ${p.name}`} onClick={() => toggleDetails(p.id)}
            onDragOver={e => { if (isTrackDrag(e)) e.preventDefault(); }}
            onDrop={e => {
              const ids = readTrackDragIds(e.dataTransfer);
              if (ids.length) { e.preventDefault(); e.stopPropagation(); finishTrackDrop(); void (async () => {
                await useWorkshopStore.getState().selectProject(p.id);
                await useWorkshopStore.getState().add(ids);
              })(); }
            }}>
            {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{p.name}</span><small>{formatTime(projectDuration(p))}</small>
            <small className="vj-task-fold-label">详情</small>
          </button>
          <button type="button" className="vj-task-edit-toggle" aria-expanded={open} aria-label={`展开编辑 ${p.name}`} onClick={() => void toggle(p.id)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}编辑
          </button>
          {(!job || job.phase === "canceled") && <button type="button" aria-label={`导出任务 ${p.name}`}
            disabled={saving > 0 || submitting || projectDuration(p) <= 0}
            onClick={() => void useWorkshopStore.getState().export(p.id)}><Download size={14} />导出</button>}
          {job && job.phase !== "canceled" && <span className="vj-task-progress vj-task-heading-progress" role="status" title={job.detail || job.path}>
            <QueueStateMark state={job.phase === "rendering" ? "processing" : job.phase === "import_failed" ? "failed" : job.phase}/>
            {phase}{["queued","rendering","validating","committing","importing"].includes(job.phase) && ` ${(job.progress * 100).toFixed(1)}%`}
            {canCancelExport(job) && <progress aria-label={`${p.name} 导出进度`} max={1} value={job.progress} />}
          </span>}
          {job && <WorkshopCancelButton key={job.id} job={job} />}
          <button type="button" aria-label={`删除任务 ${p.name}`} title="删除任务"
            disabled={saving > 0 || submitting || jobs.some(j => j.project_id === p.id && ["queued","rendering","validating","committing","importing"].includes(j.phase))}
            onClick={() => void useWorkshopStore.getState().deleteProject(p.id)}><Trash2 size={14} /></button></div>
          {showDetails && <div className="vj-task-details"><WorkshopTaskSummary project={active === p.id && draft?.id === p.id ? draft : p} /></div>}
          {(showDetails || open) && job && job.phase !== "canceled" && (job.detail || job.phase === "import_failed" || job.error) && <div className="vj-task-export-meta">
            {job?.detail && <span>{job.detail}</span>}
            {job?.phase === "import_failed" && <button onClick={() => void api.importWorkshopExport(job.id).then(s => useWorkshopStore.getState().accept(s)).catch(e => useWorkshopStore.setState({error:String(e)}))}>重试入库</button>}
            {job?.error && job.phase !== "canceled" && <span className="vj-error" role="status">{job.error}</span>}
          </div>}
          {open && <div className="vj-task-editor"><WorkshopEditor key={p.id} /></div>}
        </section>;
      })}
    </div>

  </div>;
}
