/**
 * KDJ's AI (docs/ai-dock.md): the search row's AI mode, whether pi is at work, and what
 * kdj-server says about pi. pi's stream arrives through connectEvents in appStore, like every
 * other store's events, and is carried out by aiEvents.tsx.
 */
import { create } from "zustand";
import { aiApi } from "../lib/api";
import { getBridge } from "../lib/bridge";
import { imagesOf, withAttachments, type AiAttachment } from "../lib/aiAttachments";
import { withStatus } from "../lib/aiStatus";
import type { AiStatus } from "../types/ai";
import type { WsEvent } from "../types";

/** One step of a run: a tool call, while it runs and how it ended (the AI drawer's 任务 page). */
export interface AiStep {
  id: string;
  tool: string;
  args: unknown;
  state: "running" | "done" | "failed";
  /** The result's text, for a failure's reason. */
  text?: string;
  details?: unknown;
}

/** The request under way, or the last one: what was asked, with what, and what the AI did. */
export interface AiRun {
  request: string;
  attached: string[];
  supplements: string[];
  steps: AiStep[];
  /** The earlier session this request went on in (历史 → 继续), by its title. */
  resumed?: string;
  /** What the AI said when it was done (its last reply), Markdown. */
  reply?: string;
}

/** An earlier session the next request goes on in (历史 → 继续); shown as a card in Agent Mode. */
export interface AiResume { path: string; title: string }

interface AiStore {
  /** The search row takes a request for the AI instead of a search. */
  mode: boolean;
  run: AiRun | null;
  /** pi is at work: from a request until it settles. */
  running: boolean;
  status: AiStatus | null;
  /** The status could not be read. */
  statusError: string;
  /** A request put into the field from elsewhere (a tip's example); `n` tells two alike apart. */
  seed: { text: string; n: number } | null;
  /** What was dragged into the field, as cards above it; sent with the next request (aiAttachments.ts). */
  attachments: AiAttachment[];
  /** The session the next request continues; null: the next request starts its own. */
  resume: AiResume | null;
  /** 历史 → 继续: pi opens that session, Agent Mode comes up with the session as a card. */
  continueSession(session: AiResume): Promise<void>;
  /** The card's ×: the next request starts a session of its own again. */
  dropResume(): Promise<void>;
  /** Adds cards (one per thing) and turns the row to Agent Mode. */
  attach(items: readonly AiAttachment[]): void;
  detach(key: string): void;
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
  run: null,
  seed: null,
  attachments: [],
  resume: null,
  async continueSession(session) {
    await aiApi.switchSession(session.path);
    set({ resume: session, run: null });
    get().setMode(true);
  },
  async dropResume() {
    if (!get().resume) return;
    set({ resume: null });
    // A new session for pi: what 继续 opened is left as it was.
    await aiApi.reset().catch(() => undefined);
  },
  attach(items) {
    if (items.length === 0) return;
    set(state => {
      const known = new Set(state.attachments.map(item => item.key));
      // The same thing dropped again takes its newer time.
      const updated = state.attachments.map(item => items.find(next => next.key === item.key) ?? item);
      return { attachments: [...updated, ...items.filter(item => !known.has(item.key))] };
    });
    get().setMode(true);
  },
  detach(key) {
    set(state => ({ attachments: state.attachments.filter(item => item.key !== key) }));
  },
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
    // The request becomes a task at the bottom right (a supplement when the AI is at work); the
    // cards go with it and leave the field.
    const attached = get().attachments;
    const images = imagesOf(attached);
    set({ attachments: [] });
    const module = await events();
    const running = get().running;
    // A new request also says where the listener is (aiStatus.ts); a supplement does not.
    const sent = running ? withAttachments(text, attached) : withStatus(withAttachments(text, attached));
    // A request (not a supplement) goes on in the session 继续 chose, and the card goes.
    const resumed = running ? undefined : get().resume?.title;
    const task = module.userRequest(text, running, sent, attached.map(item => item.title), images, resumed);
    set(running ? { running: true } : { running: true, resume: null });
    try {
      await aiApi.prompt(sent, images, running);
    } catch (error) {
      module.requestFailed(task);
      set({ running: false });
      module.aiProblem(message(error));
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
    void aiApi.prompt(`用户改变了页面：${change}。以用户为准，接着完成任务。`, [], true).catch(() => undefined);
  },

  handleEvent(event) {
    if (event.type === "ai.event") {
      const payload = event.payload;
      if (payload.type === "agent_start") set({ running: true });
      if (payload.type === "agent_settled" || payload.type === "kdj_exit" || payload.type === "kdj_error") set({ running: false });
      // A pi that ended takes the session 继续 opened with it: the next one starts afresh.
      if (payload.type === "kdj_exit") set({ resume: null });
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
