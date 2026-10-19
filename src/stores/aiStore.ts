/**
 * KDJ's AI (docs/ai-dock.md): the search row's AI mode, whether pi is at work, and what
 * kdj-server says about pi. pi's stream arrives through connectEvents in appStore, like every
 * other store's events, and is carried out by aiEvents.tsx.
 */
import { create } from "zustand";
import { aiApi } from "../lib/api";
import { getBridge } from "../lib/bridge";
import type { AiStatus } from "../types/ai";
import type { WsEvent } from "../types";

interface AiStore {
  /** The search row takes a request for the AI instead of a search. */
  mode: boolean;
  /** pi is at work: from a request until it settles. */
  running: boolean;
  status: AiStatus | null;
  /** The status could not be read. */
  statusError: string;
  /** A request put into the field from elsewhere (a tip's example); `n` tells two alike apart. */
  seed: { text: string; n: number } | null;
  setMode(mode: boolean): void;
  toggleMode(): void;
  /** Turns the search row to AI mode with `text` written in it, not sent. */
  suggest(text: string): void;
  /** `force`: look for pi again instead of using what was found a minute ago. */
  refresh(force?: boolean): Promise<void>;
  setStatus(status: AiStatus): void;
  /** Hands a request to pi. Nothing is said back: the AI only acts. */
  send(request: string): Promise<void>;
  abort(): Promise<void>;
  /**
   * The listener changed what is on screen while the AI works: pi is told, and goes on from
   * there. The listener comes first.
   */
  noteUserChange(change: string): void;
  handleEvent(event: WsEvent): void;
}

/** pi runs beside the desktop app only; a phone has no AI. */
export function aiOffered(): boolean {
  try {
    return ["darwin", "win32", "linux"].includes(getBridge().platform);
  } catch {
    return false;
  }
}

/** What stands in the way of a request, as state: no pi, a pi that does not run, no model. */
export function aiBlocker(status: AiStatus | null): string | null {
  if (!status) return null;
  if (status.pi.state === "missing") return "未安装 pi";
  if (status.pi.state === "broken") return status.pi.error ? `pi 无法运行：${status.pi.error}` : "pi 无法运行";
  if (!status.provider || !status.providers.some(provider => provider.id === status.provider && provider.configured)) return "AI 未设置模型";
  return null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// The window's side of pi's stream, loaded when first needed: it draws bubbles, plays and searches.
const events = () => import("../components/ai/aiEvents");

let lastChange = { text: "", at: 0 };

export const useAiStore = create<AiStore>((set, get) => ({
  mode: false,
  seed: null,
  running: false,
  status: null,
  statusError: "",

  setMode(mode) {
    if (get().mode === mode) return;
    set({ mode });
    if (mode && !get().status) void get().refresh();
  },
  toggleMode() {
    get().setMode(!get().mode);
  },
  suggest(text) {
    set(state => ({ seed: { text, n: (state.seed?.n ?? 0) + 1 } }));
    get().setMode(true);
  },

  async refresh(force = false) {
    try {
      set({ status: await aiApi.status(force), statusError: "" });
    } catch (error) {
      set({ statusError: message(error) });
    }
  },
  setStatus(status) {
    set({ status, statusError: "" });
  },

  async send(request) {
    const text = request.trim();
    if (!text) return;
    if (!get().status) await get().refresh();
    const blocked = get().statusError || aiBlocker(get().status);
    if (blocked) {
      void events().then(module => module.aiBlocked(blocked));
      return;
    }
    set({ running: true });
    try {
      await aiApi.prompt(text);
    } catch (error) {
      set({ running: false });
      void events().then(module => module.aiProblem(message(error)));
    }
  },
  async abort() {
    try {
      await aiApi.abort();
    } catch (error) {
      void events().then(module => module.aiProblem(message(error)));
    }
  },
  noteUserChange(change) {
    if (!get().running) return;
    const now = Date.now();
    if (lastChange.text === change && now - lastChange.at < 3_000) return;
    lastChange = { text: change, at: now };
    void aiApi.prompt(`用户改变了页面：${change}。以用户为准，接着完成任务。`).catch(() => undefined);
  },

  handleEvent(event) {
    if (event.type === "ai.event") {
      const payload = event.payload;
      if (payload.type === "agent_start") set({ running: true });
      if (payload.type === "agent_settled" || payload.type === "kdj_exit" || payload.type === "kdj_error") set({ running: false });
      void events().then(module => module.handlePiEvent(payload));
      return;
    }
    if (event.type === "ai.status") {
      get().setStatus(event.payload);
      if (!event.payload.running && get().running) set({ running: false });
      return;
    }
    if (event.type === "connection.open" && get().status) void get().refresh();
  },
}));
