import { create } from "zustand";
import { liveVjApi, liveVjRunning, type BluetoothDevice, type LiveVjDocument, type LiveVjEdit, type LiveVjLog, type LiveVjView } from "../lib/liveVj";
interface State {
  document: LiveVjDocument | null; activeId: string | null; view: LiveVjView | null;
  busy: boolean; error: string; logs: LiveVjLog[];
  mode: "vj" | "send"; setMode(mode: "vj" | "send"): void;
  sendStart(input: string, channelStart: number, peer: BluetoothDevice): Promise<void>;
  initialize(): Promise<void>; select(id: string | null): void;
  edit(edit: LiveVjEdit): Promise<void>;
  setStandby(clear?: boolean): Promise<void>;
  import(setId: string, ids: number[], paths: string[]): Promise<void>;
  prepare(): Promise<void>; start(input: string, output: string, channelStart: number): Promise<void>; stop(): Promise<void>; refresh(): Promise<void>;
}
let edits = Promise.resolve();
let initializing: Promise<void> | null = null;
let statusEpoch = 0;
let statusRequest = 0;
let appliedStatus = 0;
function queue(action: () => Promise<void>): Promise<void> {
  const next = edits.then(action); edits = next.catch(() => undefined); return next;
}
export const useLiveVjStore = create<State>((set, get) => ({
  document: null, activeId: null, view: null, busy: false, error: "", logs: [], mode: "vj",
  setMode(mode) { if (!get().busy && !liveVjRunning(get().view)) set({mode, error: ""}); },
  async sendStart(input, channelStart, peer) {
    if (get().busy || liveVjRunning(get().view)) return;
    statusEpoch++;
    set({busy: true, error: ""});
    try { const view = await liveVjApi.sendStart(input, channelStart, peer); statusEpoch++; set({view, logs: [], mode: "send"}); }
    catch (e) { set({error: String(e)}); } finally { set({busy: false}); }
  },
  async initialize() {
    if (get().document) return;
    if (initializing) return initializing;
    initializing = liveVjApi.document().then(document => set({document, error: ""})).catch(e => set({error: String(e)})).finally(() => { initializing = null; });
    return initializing;
  },
  select: activeId => set({activeId}),
  setStandby: (clear = false) => queue(async () => {
    const doc = get().document; if (!doc) return;
    set({busy: true, error: ""});
    try { set({document: await liveVjApi.standby(doc.revision, clear)}); await get().refresh(); }
    catch (e) { set({error: String(e)}); } finally { set({busy: false}); }
  }),
  edit: edit => queue(async () => {
    const old = get().document; if (!old) return;
    set({busy: true, error: ""});
    try {
      const document = await liveVjApi.edit(old.revision, edit);
      const activeId = edit.kind === "create" ? document.sets.at(-1)?.id ?? null
        : document.sets.some(s => s.id === get().activeId) ? get().activeId : null;
      set({document, activeId});
    } catch (e) { set({error: String(e)}); } finally { set({busy: false}); }
  }),
  import: (setId, ids, paths) => queue(async () => {
    const old = get().document; if (!old) return;
    set({busy: true, error: ""});
    try { set({document: await liveVjApi.import(old.revision, setId, paths, ids)}); }
    catch (e) { set({error: String(e)}); } finally { set({busy: false}); }
  }),
  async prepare() {
    const id = get().activeId; if (!id || get().busy) return;
    statusEpoch++;
    set({busy: true, error: ""});
    try { const view = await liveVjApi.prepare(id); statusEpoch++; set({view, logs: []}); }
    catch (e) { set({error: String(e)}); } finally { set({busy: false}); }
  },
  async start(input, output, channelStart) {
    const id = get().activeId; if (!id || get().busy) return;
    statusEpoch++;
    set({busy: true, error: ""});
    try { const view = await liveVjApi.start(id, input, output, channelStart); statusEpoch++; set({view, logs: []}); }
    catch (e) { set({error: String(e)}); } finally { set({busy: false}); }
  },
  async stop() {
    statusEpoch++;
    set({busy: true, error: ""});
    try { await liveVjApi.stop(); statusEpoch++; await get().refresh(); }
    catch (e) { set({error: String(e)}); } finally { set({busy: false}); }
  },
  async refresh() {
    const epoch = statusEpoch, request = ++statusRequest;
    try {
      const {logs: incoming, ...view} = await liveVjApi.status(get().logs.at(-1)?.id ?? 0);
      if (epoch !== statusEpoch || request < appliedStatus) return;
      appliedStatus = request;
      set(old => {
        const previous = old.view?.session === view.session ? old.logs : [];
        const lastId = previous.at(-1)?.id ?? 0;
        return {view, logs: [...previous, ...incoming.filter(log => log.id > lastId)].slice(-300)};
      });
    }
    catch (e) { if (epoch === statusEpoch && request >= appliedStatus) set({error: String(e)}); }
  },
}));
