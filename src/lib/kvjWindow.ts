import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { editorWindowLabels, isEditorWindow, type EditorWindowLabel } from "./windowRole";
import type { KvjOpenRequest } from "../stores/kvjStore";
import type { UnifiedPlayerState } from "./unifiedPlayer";
import type { VisualizerExportTask } from "./visualizerExportQueue";
import { useToastStore } from "../stores/toastStore";

const REQUEST = "kdj:window-request", REPLY = "kdj:window-reply", SNAPSHOT = "kdj:player-snapshot";
type Request = { id: string; sender: string; action: "ping" | "open" | "transport" | "settings" | "visualizer-exports"; payload?: unknown };
const EXPORTS = "kdj:visualizer-exports";
export type VisualizerExportCommand = { action: "initialize" | "start" | "cancel" | "remove"; id?: string }
  /** Queue the draft another window has just saved for this song. */
  | { action: "enqueue"; trackId: number };
export type VisualizerExportSnapshot = { tasks: VisualizerExportTask[]; error: string };
type Reply = { id: string; value?: unknown; error?: string };
type Transport = { method: "play" | "pause" | "seek"; argument?: number; trackId: number | null };
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let started: Promise<void> | undefined;
const activeEditors = new Set<string>();
let relaying = false;

async function request<T>(target: string, action: Request["action"], payload?: unknown, timeout = 30_000): Promise<T> {
  await startWindowLink();
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error("窗口通信超时")); }, timeout);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); pending.delete(id); resolve(value as T); },
      reject: error => { clearTimeout(timer); pending.delete(id); reject(error); },
    });
    void emitTo(target, REQUEST, { id, sender: getCurrentWebviewWindow().label, action, payload }).catch(error => pending.get(id)?.reject(new Error(String(error))));
  });
}

const opening = new Map<EditorWindowLabel, Promise<boolean>>();
async function ensureEditorWindow(target: EditorWindowLabel, background = false): Promise<void> {
  await startWindowLink();
  if (getCurrentWebviewWindow().label === target) return;
  if (!opening.has(target)) {
    opening.set(target, (async () => {
      await invoke("open_kvj_window", { kind: target, background });
      // New webviews must finish bridge/bootstrap before receiving the intent.
      for (let attempt = 0; attempt < 30; attempt++) {
        try { await request(target, "ping", undefined, 500); return background; }
        catch (error) {
          if (attempt === 29) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      throw new Error("窗口仍在初始化");
    })().finally(() => { opening.delete(target); }));
  }
  const openedInBackground = await opening.get(target);
  if (openedInBackground && !background) await invoke("open_kvj_window", { kind: target });
}

/** The frame producer stays in its original WebView; task pages only receive snapshots. */
export async function requestVisualizerExports(command: VisualizerExportCommand): Promise<VisualizerExportSnapshot> {
  await ensureEditorWindow("visualizer-studio", true);
  return request("visualizer-studio", "visualizer-exports", command);
}

export async function openKvj(requested: KvjOpenRequest = {}): Promise<void> {
  await startWindowLink();
  if (requested.tab === "visualizer") {
    // The configuration is an app of the main window's right column. The visualizer-studio
    // window is never shown for it: it only runs the export queue (requestVisualizerExports).
    if (!requested.track) throw new Error("请选择一首歌曲");
    if (isEditorWindow) await request("main", "open", requested);
    else (await import("../stores/visualizerStudioStore")).useVisualizerStudioStore.getState().open(requested.track);
    return;
  }
  const target: EditorWindowLabel = "preferences";
  if (getCurrentWebviewWindow().label === target) {
    await (await import("../stores/kvjStore")).acceptKvjRequest(requested);
    return;
  }
  await ensureEditorWindow(target);
  await request(target, "open", requested);
}
export function showKvj(requested: KvjOpenRequest = {}): void {
  void openKvj(requested).catch(error => useToastStore.getState().show(`无法打开${requested.tab === "visualizer" ? "可视化" : "偏好设置"}：${String(error)}`));
}
export function requestSettingsSave(patch: Partial<import("../types").Settings>): Promise<void> {
  return request("main", "settings", patch);
}
export function requestKvjTransport(method: Transport["method"], trackId: number | null, argument?: Transport["argument"]): Promise<UnifiedPlayerState> {
  return request("main", "transport", { method, trackId, argument });
}

/** KDJ owns playback intents/command IDs; KVJ observes the same native device clock. */
export function startWindowLink(): Promise<void> {
  if (started) return started;
  started = (async () => {
    const win = getCurrentWebviewWindow();
    const [{ getPlayerSession, publishPlayerSession, PLAYER_COMMAND_EVENT, requestPlayerCommand },
      { getPlayingTrack, setPlayingTrack }, { PLAY_EVENT, playTrack }, { runtimePlayer }] = await Promise.all([
      import("./playerSession"), import("./playingTrack"), import("./playTrack"), import("./unifiedPlayer"),
    ]);
    const broadcast = (event: string, payload: unknown) => Promise.all(
      (isEditorWindow ? ["main"] : [...activeEditors]).map(target => emitTo(target, event, payload)),
    );
    const report = (error: unknown) => useToastStore.getState().show(`窗口通信失败：${String(error)}`);
    let lastTrack: ReturnType<typeof getPlayingTrack> | undefined;
    let lastSession: ReturnType<typeof getPlayerSession> | undefined;
    const sendSnapshot = () => {
      if (!activeEditors.size || isEditorWindow) return;
      const track = getPlayingTrack(), session = getPlayerSession();
      if (track === lastTrack && session === lastSession) return;
      const payload = { ...(track !== lastTrack ? { track } : {}), session };
      lastTrack = track; lastSession = session;
      void broadcast(SNAPSHOT, payload).catch(report);
    };
    await win.listen<Reply>(REPLY, ({ payload }) => {
      const item = pending.get(payload.id);
      if (payload.error) item?.reject(new Error(payload.error)); else item?.resolve(payload.value);
    });
    let ready = false;
    await win.listen<Request>(REQUEST, async ({ payload: message }) => {
      try {
        let value: unknown;
        if (!ready) throw new Error("窗口仍在初始化");
        if (message.action === "ping") {
          if (!isEditorWindow && editorWindowLabels.some(label => label === message.sender)) {
            activeEditors.add(message.sender);
            await emitTo(message.sender, SNAPSHOT, { track: getPlayingTrack(), session: getPlayerSession() });
            const settings = useAppStore.getState().settings;
            if (settings) await emitTo(message.sender, "kdj:window-settings", settings);
          }
        }
        else if (message.action === "visualizer-exports" && win.label === "visualizer-studio") {
          const { useVisualizerExportStore } = await import("../stores/visualizerExportStore");
          const command = message.payload as VisualizerExportCommand;
          const exports = useVisualizerExportStore.getState();
          await exports.initialize();
          if (command.action !== "initialize") useVisualizerExportStore.setState({ error: "" });
          if (command.action === "enqueue") {
            const { loadVisualizerDraft } = await import("./visualizerStudio");
            const draft = await loadVisualizerDraft(command.trackId);
            if (!draft) throw new Error("没有找到这首歌的可视化工程");
            await exports.enqueue(draft);
          }
          else if (command.action === "start") exports.start(command.id);
          else if (command.action === "cancel") await exports.cancel(command.id);
          else if (command.action === "remove" && command.id) await exports.remove(command.id);
          else if (command.action !== "initialize") throw new Error("不支持的导出操作");
          const { tasks, error } = useVisualizerExportStore.getState();
          value = { tasks, error } satisfies VisualizerExportSnapshot;
        }
        else if (message.action === "open" && isEditorWindow) {
          const { acceptKvjRequest } = await import("../stores/kvjStore");
          await acceptKvjRequest(message.payload as KvjOpenRequest);
        } else if (message.action === "open") {
          // A tool window asked for the visualizer configuration, which lives in this window.
          const requested = message.payload as KvjOpenRequest;
          if (requested.tab !== "visualizer" || !requested.track) throw new Error("不支持的窗口请求");
          const { useVisualizerStudioStore } = await import("../stores/visualizerStudioStore");
          useVisualizerStudioStore.getState().open(requested.track);
          // The asking window is in front of this one; the column it opened in must be seen.
          void import("./api").then(({ api }) => api.showMainWindow()).catch(() => undefined);
        } else if (message.action === "settings" && !isEditorWindow) {
          await useAppStore.getState().saveSettings(message.payload as Partial<import("../types").Settings>);
        } else if (message.action === "transport" && !isEditorWindow) {
          const command = message.payload as Transport, player = runtimePlayer();
          // A delayed scrub/pause from the old preview must never affect a newly loaded DJ track.
          if (command.trackId !== player.state().trackId) value = player.state();
          else switch (command.method) {
            case "play": value = await player.play(); break;
            case "pause": value = await player.pause(); break;
            case "seek": value = await player.seek(command.argument as number); break;
            default: throw new Error("不支持的播放命令");
          }
        } else throw new Error("不支持的窗口请求");
        await emitTo(message.sender, REPLY, { id: message.id, value });
      } catch (error) { await emitTo(message.sender, REPLY, { id: message.id, error: String(error) }); }
    });
    const { useAppStore } = await import("../stores/appStore");
    if (win.label === "visualizer-studio") {
      const { useVisualizerExportStore } = await import("../stores/visualizerExportStore");
      useVisualizerExportStore.subscribe((state, previous) => {
        if (state.tasks !== previous.tasks || state.error !== previous.error)
          void emitTo("main", EXPORTS, {
            ...(state.tasks !== previous.tasks ? { tasks: state.tasks } : {}),
            ...(state.error !== previous.error ? { error: state.error } : {}),
          }).catch(report);
      });
    } else if (!isEditorWindow) {
      const { useVisualizerExportStore } = await import("../stores/visualizerExportStore");
      await win.listen<Partial<VisualizerExportSnapshot>>(EXPORTS, ({ payload }) => {
        useVisualizerExportStore.setState(payload);
      });
    }
    if (isEditorWindow) {
      await win.listen<NonNullable<ReturnType<typeof useAppStore.getState>["settings"]>>("kdj:window-settings", ({ payload }) => {
        useAppStore.setState({ settings: payload });
      });
      await win.listen<{ track?: ReturnType<typeof getPlayingTrack>; session: ReturnType<typeof getPlayerSession> }>(SNAPSHOT, ({ payload }) => {
        if ("track" in payload) setPlayingTrack(payload.track ?? null);
        publishPlayerSession(payload.session);
      });
      if (win.label !== "preferences") await runtimePlayer().initialize();
    } else {
      window.setInterval(sendSnapshot, 125);
      useAppStore.subscribe((state, previous) => {
        if (activeEditors.size && state.settings && state.settings !== previous.settings)
          void broadcast("kdj:window-settings", state.settings).catch(report);
      });
    }
    await win.listen<{ request: import("./playTrack").PlayRequest }>("kdj:window-play", ({ payload }) => {
      relaying = true;
      try {
        if (isEditorWindow) window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: payload.request }));
        else {
          const { track, autoPlay, purpose, position } = payload.request;
          playTrack(track, autoPlay, purpose, position);
        }
      } finally { relaying = false; }
    });
    window.addEventListener(PLAY_EVENT, event => {
      if (relaying) return;
      const detail = (event as CustomEvent<import("./playTrack").PlayRequest>).detail;
      void broadcast("kdj:window-play", { request: detail }).catch(report);
    });
    if (isEditorWindow) {
      window.addEventListener(PLAYER_COMMAND_EVENT, event => {
        void emitTo("main", "kdj:window-player-command", (event as CustomEvent).detail).catch(report);
      });
    } else {
      await win.listen<import("./playerSession").PlayerCommand>("kdj:window-player-command", ({ payload }) => requestPlayerCommand(payload));
    }
    ready = true;
    // Subscribe only after listeners exist; the main window is the snapshot owner.
    if (isEditorWindow) void request("main", "ping").catch(report);
  })();
  return started;
}
