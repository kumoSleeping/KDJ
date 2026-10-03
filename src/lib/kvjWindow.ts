import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isKvjWindow } from "./windowRole";
import type { KvjOpenRequest } from "../stores/kvjStore";
import type { UnifiedPlayerSource, UnifiedPlayerState } from "./unifiedPlayer";
import { useToastStore } from "../stores/toastStore";

const REQUEST = "kdj:window-request", REPLY = "kdj:window-reply", SNAPSHOT = "kdj:player-snapshot";
type Request = { id: string; action: "ping" | "open" | "transport"; payload?: unknown };
type Reply = { id: string; value?: unknown; error?: string };
type Transport = { method: "play" | "pause" | "seek" | "replaceAudio"; argument?: number | UnifiedPlayerSource; trackId: number | null };
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let started: Promise<void> | undefined;
let peerActive = false;
let relaying = false;

async function request<T>(action: Request["action"], payload?: unknown, timeout = 30_000): Promise<T> {
  await startWindowLink();
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error("窗口通信超时")); }, timeout);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); pending.delete(id); resolve(value as T); },
      reject: error => { clearTimeout(timer); pending.delete(id); reject(error); },
    });
    void emitTo(isKvjWindow ? "main" : "kvj", REQUEST, { id, action, payload }).catch(error => pending.get(id)?.reject(new Error(String(error))));
  });
}

let opening: Promise<void> | undefined;
export async function openKvj(requested: KvjOpenRequest = {}): Promise<void> {
  await startWindowLink();
  if (!opening) {
    opening = (async () => {
      await invoke("open_kvj_window");
      peerActive = true;
      // New webviews must finish bridge/bootstrap before receiving the intent.
      for (let attempt = 0; attempt < 30; attempt++) {
        try { await request("ping", undefined, 500); return; }
        catch (error) {
          if (attempt === 29) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    })().finally(() => { opening = undefined; });
  }
  await opening;
  const [{ getPlayingTrack }, { getPlayerSession }] = await Promise.all([import("./playingTrack"), import("./playerSession")]);
  await emitTo("kvj", SNAPSHOT, { track: getPlayingTrack(), session: getPlayerSession() });
  await request("open", requested);
}
export function showKvj(requested: KvjOpenRequest = {}): void {
  void openKvj(requested).catch(error => useToastStore.getState().show(`无法打开 KVJ：${String(error)}`));
}
export function requestKvjTransport(method: Transport["method"], trackId: number | null, argument?: Transport["argument"]): Promise<UnifiedPlayerState> {
  return request("transport", { method, trackId, argument });
}

/** KDJ owns playback intents/command IDs; KVJ observes the same native device clock. */
export function startWindowLink(): Promise<void> {
  if (started) return started;
  started = (async () => {
    const win = getCurrentWebviewWindow();
    const [{ getPlayerSession, publishPlayerSession, PLAYER_COMMAND_EVENT, requestPlayerCommand },
      { getPlayingTrack, setPlayingTrack }, { PLAY_EVENT, playTrack }, stream, { runtimePlayer }] = await Promise.all([
      import("./playerSession"), import("./playingTrack"), import("./playTrack"), import("./streamTrack"), import("./unifiedPlayer"),
    ]);
    const peer = isKvjWindow ? "main" : "kvj";
    const report = (error: unknown) => useToastStore.getState().show(`窗口通信失败：${String(error)}`);
    let lastTrack: ReturnType<typeof getPlayingTrack> | undefined;
    let lastSession: ReturnType<typeof getPlayerSession> | undefined;
    const sendSnapshot = () => {
      if (!peerActive || isKvjWindow) return;
      const track = getPlayingTrack(), session = getPlayerSession();
      if (track === lastTrack && session === lastSession) return;
      const payload = { ...(track !== lastTrack ? { track } : {}), session };
      lastTrack = track; lastSession = session;
      void emitTo(peer, SNAPSHOT, payload).catch(report);
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
        if (message.action === "ping") { peerActive = true; sendSnapshot(); }
        else if (message.action === "open" && isKvjWindow) {
          const { acceptKvjRequest } = await import("../stores/kvjStore");
          await acceptKvjRequest(message.payload as KvjOpenRequest);
        } else if (message.action === "transport" && !isKvjWindow) {
          const command = message.payload as Transport, player = runtimePlayer();
          // A delayed scrub/pause from the old preview must never affect a newly loaded DJ track.
          if (command.trackId !== player.state().trackId) value = player.state();
          else switch (command.method) {
            case "play": value = await player.play(); break;
            case "pause": value = await player.pause(); break;
            case "seek": value = await player.seek(command.argument as number); break;
            case "replaceAudio": {
              const source = command.argument as UnifiedPlayerSource;
              if (!player.replaceAudio) throw new Error("当前播放器不支持替换音频");
              value = await player.replaceAudio(source);
              stream.updateCompositionPreviewAudio(source.track, source.src);
              break;
            }
            default: throw new Error("不支持的播放命令");
          }
        } else throw new Error("不支持的窗口请求");
        await emitTo(peer, REPLY, { id: message.id, value });
      } catch (error) { await emitTo(peer, REPLY, { id: message.id, error: String(error) }); }
    });
    const { useAppStore } = await import("../stores/appStore");
    if (isKvjWindow) {
      await win.listen<NonNullable<ReturnType<typeof useAppStore.getState>["settings"]>>("kdj:window-settings", ({ payload }) => {
        useAppStore.setState({ settings: payload });
      });
      await win.listen<{ track?: ReturnType<typeof getPlayingTrack>; session: ReturnType<typeof getPlayerSession> }>(SNAPSHOT, ({ payload }) => {
        if ("track" in payload) setPlayingTrack(payload.track ?? null);
        publishPlayerSession(payload.session);
      });
      await runtimePlayer().initialize();
    } else {
      window.setInterval(sendSnapshot, 125);
      useAppStore.subscribe((state, previous) => {
        if (peerActive && state.settings && state.settings !== previous.settings)
          void emitTo(peer, "kdj:window-settings", state.settings).catch(report);
      });
    }
    await win.listen<{ request: import("./playTrack").PlayRequest; url?: string }>("kdj:window-play", ({ payload }) => {
      relaying = true;
      try {
        if (isKvjWindow) window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: payload.request }));
        else {
          const { track, autoPlay, purpose, position } = payload.request;
          if (payload.url && "path" in track && track.path.startsWith("composition:")) stream.registerCompositionPreviewTrack(track as import("../types").Track, payload.url);
          playTrack(track, autoPlay, purpose, position);
        }
      } finally { relaying = false; }
    });
    window.addEventListener(PLAY_EVENT, event => {
      if (relaying) return;
      const detail = (event as CustomEvent<import("./playTrack").PlayRequest>).detail;
      const url = stream.isCompositionPreview(detail.track as import("../types").Track)
        ? stream.streamMeta(detail.track as import("../types").Track)?.url : undefined;
      void emitTo(peer, "kdj:window-play", { request: detail, url }).catch(report);
    });
    if (isKvjWindow) {
      window.addEventListener(PLAYER_COMMAND_EVENT, event => {
        void emitTo(peer, "kdj:window-player-command", (event as CustomEvent).detail).catch(report);
      });
    } else {
      await win.listen<import("./playerSession").PlayerCommand>("kdj:window-player-command", ({ payload }) => requestPlayerCommand(payload));
    }
    ready = true;
  })();
  return started;
}
