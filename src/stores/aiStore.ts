/**
 * KDJ's AI (docs/ai-dock.md): the search field's `/pi` request, whether pi is at work, and what
 * kdj-server says about pi. pi's stream arrives through connectEvents in appStore, like every
 * other store's events, and is carried out by aiEvents.tsx.
 */
import { create } from "zustand";
import type { AiTrace } from "../lib/aiTrace";
import { aiApi } from "../lib/api";
import { getBridge } from "../lib/bridge";
import type { AiAttachment } from "../lib/aiAttachments";
import { PI_PREFIX, withPiPrefix } from "../lib/piPrefix";
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
  trace?: AiTrace;
  /** The earlier session this request went on in (历史 → 继续), by its title. */
  resumed?: string;
  /** What the AI said when it was done (its last reply), Markdown. */
  reply?: string;
}

/** An earlier session the next request goes on in (历史 → 继续); shown as a card under the field. */
export interface AiResume { path: string; title: string }

interface AiStore {
  /**
   * What the search field holds while it starts with `/pi` (piPrefix.ts): a request for the AI.
   * null: the field is the search's, and shows its words.
   */
  draft: string | null;
  run: AiRun | null;
  /** pi is at work: from a request until it settles. */
  running: boolean;
  status: AiStatus | null;
  /** The status could not be read. */
  statusError: string;
  /** Counts the times something asks for the caret in the field (a tip's example, 继续). */
  focus: number;
  /** What was dragged into the field, as cards under it; sent with the next request (aiAttachments.ts). */
  attachments: AiAttachment[];
  /** The session the next request continues; null: the next request starts its own. */
  resume: AiResume | null;
  /** 历史 → 继续: pi opens that session, and the field takes `/pi` with the session as a card. */
  continueSession(session: AiResume): Promise<void>;
  /** The card's ×: the next request starts a session of its own again. */
  dropResume(): Promise<void>;
  /** Adds cards (one per thing) and puts `/pi` in the field. */
  attach(items: readonly AiAttachment[]): void;
  detach(key: string): void;
  /** The field's words while they are for the AI; null gives the field back to the search. */
  setDraft(draft: string | null): void;
  /** Puts `/pi` in front of `text`, or keeps what the field holds for the AI already. */
  openDraft(text?: string): void;
  /** Writes `/pi <text>` in the field, not sent, and puts the caret there. */
  suggest(text: string): void;
  /** `force`: look for pi again instead of using what was found a minute ago. */
  refresh(force?: boolean): Promise<void>;
  setStatus(status: AiStatus): void;
  /**
   * Hands a request to pi: a task of its own (aiEvents.tsx), started now, or after the tasks
   * before it while the AI is at work. Nothing is said back: the AI only acts.
   */
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
  draft: null,
  run: null,
  focus: 0,
  attachments: [],
  resume: null,
  async continueSession(session) {
    await aiApi.switchSession(session.path);
    set(state => ({ resume: session, run: null, focus: state.focus + 1 }));
    get().openDraft();
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
    get().openDraft();
  },
  detach(key) {
    set(state => ({ attachments: state.attachments.filter(item => item.key !== key) }));
  },
  running: false,
  status: null,
  statusError: "",

  setDraft(draft) {
    if (get().draft === draft) return;
    set({ draft });
    if (draft !== null && !get().status) void get().refresh();
  },
  openDraft(text) {
    get().setDraft(withPiPrefix(text ?? get().draft ?? ""));
  },
  suggest(text) {
    set(state => ({ focus: state.focus + 1 }));
    get().setDraft(`${PI_PREFIX}${text}`);
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
    // The cards go with the request and leave the field; the request becomes a task at the
    // bottom right, which starts now or waits for the tasks before it.
    const attached = get().attachments;
    set({ attachments: [] });
    const module = await events();
    module.userRequest(text, attached);
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
