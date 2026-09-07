import { create } from "zustand";
import { api } from "../lib/api";
import {
  cloneProject,
  findClip,
  isVisualSource,
  projectDuration,
  syncOutputFormat,
  validateProject,
} from "../lib/workshop";
import type { WsEvent } from "../types";
import type {
  ClipHandle,
  CompositionProject,
  WorkshopSnapshot,
  WorkshopPositionResults,
} from "../types/workshop";
import { readLocalStorage, writeLocalStorageNow } from "../lib/storageWrite";
interface WorkshopStore extends WorkshopSnapshot {
  positions: Record<string, WorkshopPositionResults>;
  acceptPositions(result: WorkshopPositionResults): void;
  refreshPositions(): Promise<void>;
  controlPositions(projectId: string, stopped: boolean, layerId?: string): Promise<void>;
  applyPositions(
    layer: string,
    analysis: string,
    preset: string,
  ): Promise<void>;
  activeId: string | null;
  expandedId: string | null;
  draft: CompositionProject | null;
  selectedId: string | null;
  cropId: string | null;
  hiddenVideoLayers: Record<string, string[]>;
  auditionAfterLayer: Record<string, string | undefined>;
  toggleAudioLayer(id: string): void;
  toggleVideoLayer(id: string): void;
  handle: ClipHandle;
  position: number;
  snap: boolean;
  barSnap: boolean;
  scrubbing: boolean;
  trimPreview: { clipId: string; edge: "in" | "out" } | null;
  saving: number;
  error: string;
  past: CompositionProject[];
  future: CompositionProject[];
  gesture: CompositionProject | null;
  accept(s: WorkshopSnapshot): void;
  refresh(): Promise<void>;
  selectProject(id: string): Promise<void>;
  createProject(): Promise<void>;
  deleteProject(id?: string): Promise<void>;
  add(ids: number[], at?: number, target?: string | null): Promise<void>;
  intake(ids: number[], paths: string[], at?: number, target?: string | null): Promise<void>;
  select(id: string | null, handle?: ClipHandle): void;
  begin(): void;
  transient(p: CompositionProject): void;
  commit(): void;
  abort(): void;
  edit(transform: (p: CompositionProject) => CompositionProject): void;
  undo(): void;
  redo(): void;
  seek(ms: number): void;
  flush(): Promise<void>;
  align(reference: string): Promise<void>;
  export(id?: string): Promise<void>;
  exportAll(directory?: string): Promise<void>;
  batchSubmitting: boolean;
  cancelExport(id: string): Promise<void>;
  cancelAllExports(): Promise<void>;
  handleEvent(e: WsEvent): void;
}
let batchGeneration = 0;
let tail: Promise<void> = Promise.resolve();
const same = (a: CompositionProject, b: CompositionProject) =>
  JSON.stringify([a.name, a.layers, a.canvas, a.output, a.markers ?? []]) ===
  JSON.stringify([b.name, b.layers, b.canvas, b.output, b.markers ?? []]);
const remembered = readLocalStorage("kdj-workshop-project");
const retired = new Set<string>();
function queue(action: () => Promise<void>): Promise<void> {
  useWorkshopStore.setState((s) => ({ saving: s.saving + 1 }));
  const task = tail
    .then(action)
    .catch(async (error: unknown) => {
      useWorkshopStore.setState({
        error: error instanceof Error ? error.message : String(error),
        gesture: null,
        past: [],
        future: [],
      });
      try {
        const latest = await api.workshop();
        useWorkshopStore.getState().accept(latest);
        useWorkshopStore.setState((s) => ({
          draft: latest.projects.find((p) => p.id === s.activeId) ?? null,
        }));
      } catch {
        /* Keep the actionable original failure. */
      }
    })
    .finally(() =>
      useWorkshopStore.setState((s) => {
        const saving = Math.max(0, s.saving - 1);
        // Analysis can save the first match while an import response is still
        // arriving. Once local writes settle, display that latest saved layout.
        const draft = saving === 0 && !s.gesture
          ? s.projects.find(p => p.id === s.activeId) ?? null
          : s.draft;
        return { saving, draft };
      }),
    );
  tail = task;
  return task;
}
function save(p: CompositionProject) {
  void queue(async () => {
    const state = useWorkshopStore.getState(),
      base = state.projects.find((v) => v.id === p.id);
    if (!base) throw new Error("作品不存在");
    const result = await api.editWorkshop(p.id, base.revision, {...p, markers: p.markers ?? []});
    useWorkshopStore.getState().accept(result);
    const updated = result.projects.find((v) => v.id === p.id);
    useWorkshopStore.setState((s) => ({
      draft:
        s.draft?.id === p.id && updated
          ? { ...s.draft, revision: updated.revision, sources: updated.sources }
          : s.draft,
    }));
  });
}
export const useWorkshopStore = create<WorkshopStore>()((set, get) => ({
  batchSubmitting: false,
  positions: {},
  expandedId: null,
  session: "",
  revision: -1,
  projects: [],
  jobs: [],
  activeId: remembered || null,
  draft: null,
  cropId: null,
  selectedId: null,
  hiddenVideoLayers: {},
  auditionAfterLayer: {},
  toggleAudioLayer(id) {
    const p = get().draft;
    if (!p || !p.layers.some(l => l.id === id && p.sources.some(s => s.id === l.source_id && s.audio))) return;
    set(s => ({ auditionAfterLayer: { ...s.auditionAfterLayer, [p.id]: s.auditionAfterLayer[p.id] === id ? undefined : id } }));
  },
  toggleVideoLayer(id) {
    const p = get().draft;
    if (!p || !p.layers.some(l => l.id === id)) return;
    const hidden = get().hiddenVideoLayers[p.id] ?? [];
    set(s => ({hiddenVideoLayers: {...s.hiddenVideoLayers, [p.id]: hidden.includes(id) ? hidden.filter(v => v !== id) : [...hidden, id]}}));
  },
  handle: "move",
  position: 0,
  snap: true,
  barSnap: true,
  scrubbing: false,
  trimPreview: null,
  saving: 0,
  error: "",
  past: [],
  future: [],
  gesture: null,
  accept(snapshot) {
    const state = get();
    if (snapshot.session !== state.session) {
      if (retired.has(snapshot.session)) return;
      if (state.session) retired.add(state.session);
    } else if (snapshot.revision < state.revision) return;
    // Export completion retains the editable project until explicit deletion.
    const projects = snapshot.projects;
    const activeId = projects.some((p) => p.id === state.activeId)
      ? state.activeId
      : (projects[0]?.id ?? null);
    const project = projects.find((p) => p.id === activeId) ?? null;
    const retain =
      state.draft?.id === activeId &&
      (state.saving > 0 || state.gesture !== null);
    set({
      ...snapshot,
      projects,
      jobs: snapshot.jobs,
      expandedId: projects.some(p => p.id === state.expandedId) ? state.expandedId : null,
      ...(activeId !== state.activeId ? {selectedId:null, past:[], future:[], gesture:null, trimPreview:null, scrubbing:false} : {}),
      activeId,
      draft: retain ? state.draft : project,
      positions: snapshot.session === state.session ? state.positions : {},
    });
  },
  acceptPositions(result) {
    const s = get(),
      p = s.projects.find((p) => p.id === result.project_id);
    if (s.session !== result.session || (p && result.revision < p.revision))
      return;
    const old = s.positions[result.project_id];
    if (old && old.revision > result.revision) return;
    const items = result.items.map((item) => {
      const previous = old?.items.find((v) => v.id === item.id);
      return previous && (previous.phase === "stopped" || previous.progress > item.progress) ? previous : item;
    });
    set({
      positions: { ...s.positions, [result.project_id]: { ...result, items } },
    });
  },
  async refreshPositions() {
    const pid = get().activeId;
    if (!pid) return;
    try {
      get().acceptPositions(await api.workshopPositions(pid));
    } catch {
      /* Import/edit errors are reported by their own operation; matching can be retried. */
    }
  },
  async controlPositions(projectId, stopped, layerId) {
    try {
      get().acceptPositions(await api.controlWorkshopPositions(projectId, stopped, layerId));
    } catch (e) {
      set({ error: `位置分析操作失败：${String(e)}` });
    }
  },
  async applyPositions(layer, analysis, preset) {
    await get().flush();
    const pid = get().activeId;
    await queue(async () => {
      const p = get().projects.find((p) => p.id === pid);
      if (!p) return;
      const before = cloneProject(p),
        snapshot = await api.applyWorkshopPositions(
          p.id,
          p.revision,
          layer,
          analysis,
          preset,
        );
      get().accept(snapshot);
      const next = snapshot.projects.find((v) => v.id === pid)!;
      if (get().activeId === pid)
        set((s) => ({
          draft: next,
          selectedId:
            next.layers.find((l) => l.id === layer)?.clips[0]?.id ?? null,
          past: [...s.past, before].slice(-100),
          future: [],
          error: "",
        }));
    });
  },
  async refresh() {
    try {
      get().accept(await api.workshop());
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  async selectProject(id) {
    get().commit();
    await tail;
    const p = get().projects.find((p) => p.id === id);
    if (!p) return;
    writeLocalStorageNow("kdj-workshop-project", id);
    set({
      activeId: id,
      expandedId: id,
      draft: cloneProject(p),
      selectedId: null,
      position: 0,
      past: [],
      future: [],
      error: "",
      gesture: null,
      trimPreview: null,
      scrubbing: false,
    });
  },
  createProject: () =>
    queue(async () => {
      const s = await api.createWorkshop();
      get().accept(s);
      const p = s.projects.at(-1)!;
      writeLocalStorageNow("kdj-workshop-project", p.id);
      set({
        activeId: p.id,
        expandedId: p.id,
        draft: p,
        selectedId: null,
        past: [],
        future: [],
        position: 0,
      });
    }),
  deleteProject: (id = get().activeId ?? undefined) =>
    queue(async () => {
      const p = get().projects.find((p) => p.id === id);
      if (!p) return;
      if (get().batchSubmitting || get().jobs.some(j => j.project_id === id && ["queued", "rendering", "validating", "committing", "importing"].includes(j.phase))) {
        throw new Error("请先取消导出或等待导出完成");
      }
      const s = await api.deleteWorkshop(p.id, p.revision);
      if (get().activeId === id) set({
        activeId: null,
        expandedId: null,
        draft: null,
        selectedId: null,
        past: [],
        future: [],
        position: 0,
        gesture: null,
        trimPreview: null,
        scrubbing: false,
      });
      set(state => ({
        error: "",
        positions: Object.fromEntries(Object.entries(state.positions).filter(([key]) => key !== id)),
        hiddenVideoLayers: Object.fromEntries(Object.entries(state.hiddenVideoLayers).filter(([key]) => key !== id)),
        auditionAfterLayer: Object.fromEntries(Object.entries(state.auditionAfterLayer).filter(([key]) => key !== id)),
      }));
      get().accept(s);
    }),
  async add(ids, at, target) { return get().intake(ids, [], at, target); },
  async intake(ids, paths, at, target) {
    if (!ids.length && !paths.length) return;
    get().commit();
    const pid = target === undefined ? get().activeId : target;
    const position = at ?? get().position;
    await queue(async () => {
      const p = get().projects.find(p => p.id === pid);
      if (pid && !p) throw new Error("目标任务不存在");
      const result = await api.intakeWorkshop({project_id: pid, revision: p?.revision, track_ids: ids, paths, at_ms: position});
      get().accept(result.snapshot);
      const updated = result.snapshot.projects.find(p => p.id === result.project_id);
      if (updated && result.before && (get().activeId === pid || (!pid && !get().expandedId))) {
        set(state => ({activeId: updated.id, expandedId: updated.id, draft: updated,
          selectedId: updated.layers.find(l => !result.before?.layers.some(old => old.id === l.id))?.clips[0]?.id ?? null,
          past: [...state.past, result.before!].slice(-100), future: [],
        }));
      }
      set({error: result.errors.join("；")});
    });
  },
  select(id, handle = "move") {
    get().commit();
    set({ selectedId: id, cropId: get().cropId === id ? id : null, handle, error: "" });
  },
  begin() {
    const s = get();
    if (!s.gesture && s.draft)
      set({ gesture: cloneProject(s.draft), error: "" });
  },
  transient(p) {
    const state = get();
    if (state.draft) syncOutputFormat(p, state.draft);
    const before = state.draft && findClip(state.draft, state.selectedId);
    const after = findClip(p, state.selectedId);
    // Keep right-click edits and preview drags in the same import workflow.
    // Rotation/crop remain specific to the source being edited.
    if (p.canvas.import_picture !== null && before && after &&
      isVisualSource(p.sources.find(s => s.id === after.source_id)) &&
      (["x", "y", "scale", "opacity"] as const).some(key => before.picture[key] !== after.picture[key])) {
      const { x, y, scale, opacity } = after.picture;
      p.canvas.import_picture = { x, y, scale, opacity };
    }
    const error = validateProject(p);
    if (error) {
      set({ error });
      return;
    }
    if (!get().gesture) get().begin();
    const duration = projectDuration(p);
    if (p.output.in_ms > duration) p.output.in_ms = 0;
    if (
      p.output.out_ms !== null &&
      (p.output.out_ms > duration || p.output.out_ms <= p.output.in_ms)
    )
      p.output.out_ms = null;
    set({ draft: p, error: "" });
  },
  commit() {
    const s = get(),
      before = s.gesture,
      after = s.draft;
    if (!before || !after) return;
    set({ gesture: null, trimPreview: null });
    if (same(before, after)) return;
    set({ past: [...s.past, before].slice(-100), future: [] });
    save(after);
  },
  abort() {
    const p = get().gesture;
    if (p) set({ draft: p, gesture: null, trimPreview: null, error: "" });
  },
  edit(transform) {
    const p = get().draft;
    if (!p) return;
    get().begin();
    get().transient(transform(p));
    get().commit();
  },
  undo() {
    get().commit();
    const s = get(),
      p = s.past.at(-1);
    if (!p || !s.draft) return;
    const next = {
      ...cloneProject(p),
      revision: s.draft.revision,
      sources: s.draft.sources,
    };
    set({
      draft: next,
      past: s.past.slice(0, -1),
      future: [...s.future, s.draft],
      selectedId: findClip(next, s.selectedId) ? s.selectedId : null,
      error: "",
    });
    save(next);
  },
  redo() {
    const s = get(),
      p = s.future.at(-1);
    if (!p || !s.draft) return;
    const next = {
      ...cloneProject(p),
      revision: s.draft.revision,
      sources: s.draft.sources,
    };
    set({
      draft: next,
      past: [...s.past, s.draft],
      future: s.future.slice(0, -1),
      selectedId: findClip(next, s.selectedId) ? s.selectedId : null,
      error: "",
    });
    save(next);
  },
  seek(ms) {
    const p = get().draft;
    set({ position: Math.max(0, Math.min(p ? projectDuration(p) : 0, ms)) });
  },
  async flush() {
    get().commit();
    await tail;
  },
  async align(reference) {
    get().commit();
    const pid = get().activeId,
      cid = get().selectedId;
    if (!pid || !cid) return;
    await queue(async () => {
      const p = get().projects.find((p) => p.id === pid);
      if (!p) return;
      const result = await api.alignWorkshop(pid, p.revision, cid, reference);
      if (get().activeId !== pid || get().draft?.revision !== result.revision)
        return;
      const before = cloneProject(get().draft!),
        next = cloneProject(before),
        c = findClip(next, cid);
      if (!c) return;
      c.start_ms = result.start_ms;
      const error = validateProject(next);
      if (error) throw new Error(error);
      const snapshot = await api.editWorkshop(pid, p.revision, next);
      get().accept(snapshot);
      set((s) => ({
        draft: snapshot.projects.find((p) => p.id === pid)!,
        past: [...s.past, before].slice(-100),
        future: [],
      }));
    });
  },
  async export(projectId) {
    const id = projectId ?? get().activeId;
    await get().flush();
    await queue(async () => {
      const p = get().projects.find((p) => p.id === id);
      if (p) get().accept(await api.exportWorkshop(p.id, p.revision));
    });
  },
  async cancelExport(id) {
    set({error: ""});
    try {
      get().accept(await api.cancelWorkshopExport(id));
    } catch (error) {
      // A lost response must not report failure after cancellation succeeded.
      const snapshot = await api.workshop().catch(() => null);
      if (snapshot) {
        get().accept(snapshot);
        const job = snapshot.jobs.find(j => j.id === id);
        if (job && ["canceled", "complete", "failed", "import_failed"].includes(job.phase)) return;
      }
      throw error;
    }
  },
  async cancelAllExports() {
    ++batchGeneration;
    const results = await Promise.allSettled(get().jobs.filter(j => ["queued", "rendering", "validating"].includes(j.phase)).map(j => get().cancelExport(j.id)));
    const errors = results.filter(r => r.status === "rejected");
    if (errors.length) throw new Error(errors.map(r => String(r.reason)).join("；"));
  },
  async exportAll(directory) {
    if (get().batchSubmitting) return;
    const generation = ++batchGeneration;
    set({batchSubmitting: true});
    try {
      await get().flush();
      const ids = get().projects.filter(p => projectDuration(p) > 0).map(p => p.id);
      for (const id of ids) {
        if (generation !== batchGeneration) break;
        await queue(async () => {
          if (generation !== batchGeneration) return;
          let p = get().projects.find(p => p.id === id);
          if (!p || get().jobs.some(j => j.project_id === id && ["queued", "rendering", "validating", "committing", "importing"].includes(j.phase))) return;
          if (directory && directory !== p.output.directory) {
            const next = cloneProject(p); next.output.directory = directory;
            const snapshot = await api.editWorkshop(id, p.revision, next);
            get().accept(snapshot); p = snapshot.projects.find(p => p.id === id)!;
          }
          if (generation !== batchGeneration) return;
          const previous = new Set(get().jobs.map(j => j.id));
          const snapshot = await api.exportWorkshop(id, p.revision);
          get().accept(snapshot);
          // A cancel can arrive while submission is in flight. Cancel the new
          // receipt too, and never submit the remainder of that batch.
          if (generation !== batchGeneration) for (const j of snapshot.jobs) {
            if (!previous.has(j.id) && j.project_id === id && ["queued", "rendering", "validating"].includes(j.phase)) await get().cancelExport(j.id);
          }
        });
      }
    } finally { set({batchSubmitting: false}); }
  },
  handleEvent(e) {
    if (e.type === "workshop.positions") get().acceptPositions(e.payload);
    if (e.type === "workshop.updated") get().accept(e.payload);
    if (e.type === "connection.open")
      void get()
        .refresh()
        .then(() => get().refreshPositions());
  },
}));
