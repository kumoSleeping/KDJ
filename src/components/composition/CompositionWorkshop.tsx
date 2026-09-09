import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
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
import { workshopCutTime } from "../../lib/workshopRhythm";
import { useWorkshopRhythmStore } from "../../stores/workshopRhythmStore";
import { WorkshopTimeline } from "./WorkshopTimeline";
import { WorkshopClipMenu } from "./WorkshopClipMenu";
import { addWorkshopMarker } from "../../lib/workshopMarkers";
import { WorkshopPictureTools } from "./WorkshopPictureTools";
import { WorkshopToolbar, WorkshopToolbarTarget } from "./WorkshopToolbar";
import { WorkshopExportSettings } from "./WorkshopExport";
import { canCancelExport } from "./WorkshopCancelButton";
import { QueueStateMark } from "../queue/QueuePrimitives";
import { api } from "../../lib/api";
import { useWorkshopUndoShortcuts } from "../../lib/useWorkshopUndoShortcuts";
import { WorkshopCancelButton } from "./WorkshopCancelButton";
import { WorkshopTaskSummary } from "./WorkshopTaskSummary";
import { InlineNotice } from "../common/InlineNotice";
import {
  isTrackDrag,
  readTrackDragIds,
  finishTrackDrop,
} from "../../lib/trackDrag";
function WorkshopEditor() {
  const p = useWorkshopStore((s) => s.draft),
    selected = useWorkshopStore((s) => s.selectedId),
    saving = useWorkshopStore((s) => s.saving),
    past = useWorkshopStore((s) => s.past.length),
    future = useWorkshopStore((s) => s.future.length),
    snap = useWorkshopStore((s) => s.snap),
    barSnap = useWorkshopStore((s) => s.barSnap);
  const legacyTasks = useCompositionStore((s) => s.tasks),
    legacyError = useCompositionStore((s) => s.error);
  const legacy = legacyTasks.filter((t) => t.phase === "import_failed");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [clipMenu, setClipMenu] = useState<{id?: string; markerId?: string; markMs?: number; x: number; y: number} | null>(null),
    [more, setMore] = useState(false),
    [align, setAlign] = useState(false),
    [reference, setReference] = useState("");
  const playback = useWorkshopPlayback(),
    root = useRef<HTMLDivElement>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const hasVideo = Boolean(p?.layers.some(l => l.clips.length > 0 && isVisualSource(p.sources.find(s => s.id === l.source_id))));
  const togglePlayback = () => playback.toggle();
  useEffect(() => { setPreviewOpen(hasVideo); }, [hasVideo]);
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
  const mark = () => {
    if (!useWorkshopStore.getState().gesture)
      edit(p => addWorkshopMarker(p, playback.time()));
  };
  const cut = () => {
    const s = useWorkshopStore.getState();
    if (s.selectedId) edit((p) => splitClip(p, s.selectedId!, workshopCutTime(
      p, s.selectedId!, s.position, useWorkshopRhythmStore.getState().results, s.barSnap,
    )));
  };
  const remove = (ripple?: boolean) => {
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
      aria-label="工作站"
      onPointerDownCapture={e => {
        // WKWebView does not focus buttons on click; leave text-undo ownership
        // as soon as the user returns to timeline or toolbar controls.
        if (!(e.target as HTMLElement).closest("input,select,textarea,[contenteditable]:not([contenteditable=false]),.vj-clip-menu,.vj-dialog,.vj-floating-preview"))
          root.current?.focus({ preventScroll: true });
      }}
      onKeyDownCapture={(e) => {
        if (
          (e.target as HTMLElement).closest(
            "input,select,textarea,[contenteditable=true],.vj-floating-preview,.vj-export-settings,.vj-dialog,.vj-clip-menu,[role=scrollbar],[role=separator],[role=slider]",
          )
        )
          return;
        const key = e.key.toLowerCase();
        if (key === "m" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) mark();
        } else if (key === " ") {
          if ((e.target as HTMLElement).closest("button,summary")) return;
          e.preventDefault();
          e.stopPropagation();
          togglePlayback();
        } else if (key === "delete" || key === "backspace") {
          e.preventDefault();
          e.stopPropagation();
          remove(e.shiftKey ? true : undefined);
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
        const target = e.target as HTMLElement;
        const id = target.closest<HTMLElement>("[data-clip-id]")?.dataset.clipId;
        const rail = target.closest<HTMLElement>(".vj-track-rail,.vj-ruler-rail");
        const markerId = target.closest<HTMLElement>("[data-marker-id]")?.dataset.markerId;
        if (!id && !rail) return;
        e.preventDefault(); e.stopPropagation();
        if (id) useWorkshopStore.getState().select(id);
        const scale = Number(rail?.dataset.vjTimeScale);
        const markMs = markerId ? p?.markers?.find(m => m.id === markerId)?.position_ms
          : rail && scale > 0 ? (e.clientX - rail.getBoundingClientRect().left) / scale : undefined;
        const rect = root.current!.getBoundingClientRect();
        setClipMenu({id, markerId, markMs, x: e.clientX - rect.left, y: e.clientY - rect.top});
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
      <InlineNotice className="vj-operation-notice" text={playback.error} />
      {hasVideo && previewOpen && <WorkshopFloatingPreview playback={playback}
        onClose={() => { setPreviewOpen(false); root.current?.focus({preventScroll: true}); }} />}
      <WorkshopTimeline playback={playback} tools={
      <header className="vj-header vj-workshop-toolbar" data-workshop-toolbar="" aria-label="工作站操作">
        <button type="button" aria-label="新建任务" title="新建任务" disabled={saving > 0}
          onClick={() => void useWorkshopStore.getState().createProject()}><Plus size={16} /></button>
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
        <WorkshopExportSettings />
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
        <button type="button" aria-label="添加标记" title="Mark · M" disabled={!p} onClick={mark}>Mark</button>
        <button
          type="button"
          aria-label="向前微调"
          title="前一帧；Shift 十帧"
          onClick={(e) => nudge(-1, e.shiftKey)}
        >
          <ChevronLeft size={16} />前一帧
        </button>
        <button
          type="button"
          aria-label="向后微调"
          title="后一帧；Shift 十帧"
          onClick={(e) => nudge(1, e.shiftKey)}
        >
          <ChevronRight size={16} />后一帧
        </button>
        <button
          type="button"
          aria-label="剪断选中片段"
          title="剪断 · S"
          disabled={!c}
          onClick={cut}
        >
          <Scissors size={16} />剪断
        </button>
        <button
          type="button"
          aria-label="复制片段"
          disabled={!c}
          onClick={() => edit((p) => duplicateClip(p, selected!))}
        >
          <Copy size={15} />复制
        </button>
        <button
          type="button"
          aria-label="删除片段"
          title="删除；Shift 删除并闭合本行空隙"
          disabled={!c}
          onClick={(e) => remove(e.shiftKey ? true : undefined)}
        >
          <Trash2 size={15} />删除
        </button>

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
        <button
          type="button"
          aria-label="上移图层"
          disabled={layerIndex <= 0}
          onClick={() => edit((p) => moveLayer(p, layer!.id, layerIndex - 1))}
        >
          <ArrowUp size={15} />上移图层
        </button>
        <button
          type="button"
          aria-label="下移图层"
          disabled={layerIndex < 0 || layerIndex === p!.layers.length - 1}
          onClick={() => edit((p) => moveLayer(p, layer!.id, layerIndex + 1))}
        >
          <ArrowDown size={15} />下移图层
        </button>
        <button type="button" aria-label="时间轴吸附" aria-pressed={snap || barSnap}
          title="吸附片段边界与节拍线；Alt/Option 拖动临时关闭"
          onClick={() => useWorkshopStore.setState({snap: !(snap || barSnap), barSnap: !(snap || barSnap)})}><Magnet size={15} /></button>
        <WorkshopPictureTools />
        <button type="button" className="vj-preview-toggle" aria-label="打开作品预览小窗" title="预览小窗"
          aria-pressed={previewOpen && hasVideo} disabled={!hasVideo}
          onClick={() => setPreviewOpen(v => !v)}><PictureInPicture2 size={16} /></button>
      </header>} />
      {clipMenu && <WorkshopClipMenu {...clipMenu} close={(restoreFocus = true) => { setClipMenu(null); if (restoreFocus) root.current?.focus({preventScroll: true}); }} />}


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


export function CompositionWorkshop({ toolbarTarget = null, backTarget = null }: { toolbarTarget?: HTMLElement | null; backTarget?: HTMLElement | null }) {
  const projects = useWorkshopStore(s => s.projects),
    draft = useWorkshopStore(s => s.draft),
    active = useWorkshopStore(s => s.activeId),
    expanded = useWorkshopStore(s => s.expandedId),
    jobs = useWorkshopStore(s => s.jobs),
    saving = useWorkshopStore(s => s.saving),
    error = useWorkshopStore(s => s.error);
  const submitting = useWorkshopStore(s => s.batchSubmitting);
  const [canceling, setCanceling] = useState(false);
  useEffect(() => { void useWorkshopStore.getState().refresh(); }, []);
  const openProject = async (id: string) => {
    await useWorkshopStore.getState().flush();
    await useWorkshopStore.getState().selectProject(id);
  };
  const returnToTasks = async () => {
    await useWorkshopStore.getState().flush();
    useWorkshopStore.setState({expandedId: null});
  };
  const backButton = <button type="button" className="kd-aside-head-close" aria-label="返回任务列表" title="返回任务列表"
    onPointerDown={e => e.stopPropagation()} onClick={() => void returnToTasks()}><ChevronLeft size={14} /></button>;
  return <WorkshopToolbarTarget.Provider value={toolbarTarget}><div data-vj-drop="" className="vj-workshop vj-task-list" aria-label="工作站任务列表"
    onDragOver={e => { if (isTrackDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
    onDrop={e => {
      if (e.defaultPrevented) return;
      const ids = readTrackDragIds(e.dataTransfer);
      if (ids.length) { e.preventDefault(); finishTrackDrop(); void useWorkshopStore.getState().add(ids); }
    }}>
    {expanded !== null && (backTarget ? createPortal(backButton, backTarget)
      : <div className="vj-editor-navigation">{backButton}<span>工作站</span></div>)}
    {expanded === null && <WorkshopToolbar>
      <button aria-label="新建任务" disabled={saving > 0} onClick={() => void useWorkshopStore.getState().createProject()}><Plus size={16} /></button>
      <span className="vj-spacer" />
      <button disabled={saving > 0 || submitting || !projects.some(p => projectDuration(p) > 0 && !jobs.some(j => j.project_id === p.id && ["queued","rendering","validating","committing","importing"].includes(j.phase)))} onClick={() => void useWorkshopStore.getState().exportAll()}><Download size={14} />全部导出</button>
      {(submitting || jobs.some(canCancelExport)) && <button disabled={canceling} onClick={() => {
        setCanceling(true); void useWorkshopStore.getState().cancelAllExports().catch(e => useWorkshopStore.setState({error:String(e)})).finally(() => setCanceling(false));
      }}>{canceling ? "正在取消" : "全部取消"}</button>}
    </WorkshopToolbar>}
    <InlineNotice className="vj-operation-notice" text={error}
      onDismiss={() => useWorkshopStore.setState({error: ""})} />
    <div className="vj-task-stack" data-editing={expanded !== null || undefined}>
      {projects.filter(p => expanded === null || p.id === expanded).map(p => {
        const open = expanded === p.id && active === p.id;
        const job = [...jobs].reverse().find(j => j.project_id === p.id
          && (j.phase !== "complete" || j.revision === p.revision));
        const phase = job ? ({queued:"等待导出",rendering:"导出中",validating:"校验中",committing:"保存中",importing:"入库中",complete:"已导出",failed:"导出失败",import_failed:"入库失败"} as Record<string,string>)[job.phase] : "";
        const heading = <div className="vj-task-card" data-editing={open || undefined}
            onClick={e => {
              if (!open && !(e.target as HTMLElement).closest("button,a,input,select,textarea")) void openProject(p.id);
            }}
            onDragOver={e => { if (isTrackDrag(e)) e.preventDefault(); }}
            onDrop={e => {
              const ids = readTrackDragIds(e.dataTransfer);
              if (ids.length) { e.preventDefault(); e.stopPropagation(); finishTrackDrop(); void (async () => {
                await useWorkshopStore.getState().selectProject(p.id);
                await useWorkshopStore.getState().add(ids);
              })(); }
            }}>
          <div className="vj-task-heading-row">
          <button type="button" className="vj-task-heading" aria-label={`打开任务 ${p.name}`} aria-expanded={open}
            onClick={() => { if (!open) void openProject(p.id); }}>
            <span>{p.name}</span><small>{formatTime(projectDuration(p))}</small>
          </button>
          {(!job || !canCancelExport(job)) && <button type="button" aria-label={`导出任务 ${p.name}`}
            disabled={saving > 0 || submitting || projectDuration(p) <= 0}
            onClick={() => void useWorkshopStore.getState().export(p.id)}><Download size={14} />导出</button>}
          {job && job.phase !== "canceled" && <span className="vj-task-progress vj-task-heading-progress" role="status" title={job.path || job.detail}>
            <QueueStateMark state={job.phase === "rendering" ? "processing" : job.phase === "import_failed" ? "failed" : job.phase}/>
            {phase}{["queued","rendering","validating","committing","importing"].includes(job.phase) && ` ${(job.progress * 100).toFixed(1)}%`}
            {canCancelExport(job) && <progress aria-label={`${p.name} 导出进度`} max={1} value={job.progress} />}
          </span>}
          {job && <WorkshopCancelButton key={job.id} job={job} />}
          <button type="button" aria-label={`删除任务 ${p.name}`} title="删除任务"
            disabled={saving > 0 || submitting || jobs.some(j => j.project_id === p.id && ["queued","rendering","validating","committing","importing"].includes(j.phase))}
            onClick={() => void useWorkshopStore.getState().deleteProject(p.id)}><Trash2 size={14} /></button></div>
          <div className="vj-task-details"><WorkshopTaskSummary project={active === p.id && draft?.id === p.id ? draft : p} /></div>
          </div>;
        return <section key={p.id} data-vj-project={p.id} className="vj-task-entry" data-expanded={open || undefined}>
          {heading}
          {job && job.phase !== "canceled" && (job.path || job.detail || job.phase === "import_failed" || job.error) && <div className="vj-task-export-meta">
            {job.path && <>
              <span className="vj-output-path" title={job.path}>{job.path}</span>
              {window.kdj && <button type="button" onClick={() => void window.kdj!.revealPath(job.path).catch(e => useWorkshopStore.setState({error: String(e)}))}>打开所在文件夹</button>}
            </>}
            {job.phase !== "complete" && job.detail && <span>{job.detail}</span>}
            {job?.phase === "import_failed" && <button onClick={() => void api.importWorkshopExport(job.id).then(s => useWorkshopStore.getState().accept(s)).catch(e => useWorkshopStore.setState({error:String(e)}))}>重试入库</button>}
            {job?.error && job.phase !== "canceled" && <span className="vj-error" role="status">{job.error}</span>}
          </div>}
          {open && <div className="vj-task-editor"><WorkshopEditor key={p.id} /></div>}
        </section>;
      })}
    </div>

  </div></WorkshopToolbarTarget.Provider>;
}
