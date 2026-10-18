/**
 * The AI corner (docs/ai-dock.md): whether the dock is up, what kdj-server says about pi, and
 * the conversation folded from pi's stream (src/lib/aiTranscript.ts). Events arrive through
 * connectEvents in appStore, like every other store's.
 */
import { create } from "zustand";
import { aiApi } from "../lib/api";
import { getBridge } from "../lib/bridge";
import {
  EMPTY_TRANSCRIPT,
  addNote,
  addUserLine,
  answerAsk,
  reducePiEvent,
  type AiTranscript,
} from "../lib/aiTranscript";
import type { AiStatus } from "../types/ai";
import type { WsEvent } from "../types";

interface AiStore extends AiTranscript {
  open: boolean;
  /** A line put into the composer from outside (a tip's example); `n` tells two alike apart. */
  seed: { text: string; n: number } | null;
  /** Opens the dock with `text` written in its field, not sent. */
  suggest(text: string): void;
  status: AiStatus | null;
  /** The status could not be read. */
  statusError: string;
  setOpen(open: boolean): void;
  toggle(): void;
  /** `force`: look for pi again instead of using what was found a minute ago. */
  refresh(force?: boolean): Promise<void>;
  setStatus(status: AiStatus): void;
  send(line: string): Promise<void>;
  abort(): Promise<void>;
  /** A new conversation: pi starts a new session and the dock is emptied. */
  reset(): Promise<void>;
  answer(id: string, answer: string | boolean | null): Promise<void>;
  handleEvent(event: WsEvent): void;
}

/** pi runs beside the desktop app only; a phone has no AI corner. */
export function aiOffered(): boolean {
  try {
    return ["darwin", "win32", "linux"].includes(getBridge().platform);
  } catch {
    return false;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useAiStore = create<AiStore>((set, get) => ({
  ...EMPTY_TRANSCRIPT,
  open: false,
  seed: null,
  status: null,
  statusError: "",

  setOpen(open) {
    if (get().open === open) return;
    set({ open });
    if (open) void get().refresh();
  },
  toggle() {
    get().setOpen(!get().open);
  },
  suggest(text) {
    set(state => ({ seed: { text, n: (state.seed?.n ?? 0) + 1 } }));
    get().setOpen(true);
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

  async send(line) {
    const text = line.trim();
    if (!text) return;
    set(state => ({ ...addUserLine(state, text), running: true }));
    try {
      await aiApi.prompt(text);
    } catch (error) {
      set(state => ({ ...addNote(state, message(error), "error"), running: false }));
    }
  },
  async abort() {
    try {
      await aiApi.abort();
    } catch (error) {
      set(state => addNote(state, message(error), "error"));
    }
  },
  async reset() {
    set({ ...EMPTY_TRANSCRIPT });
    try {
      await aiApi.reset();
    } catch (error) {
      set(state => addNote(state, message(error), "error"));
    }
  },
  async answer(id, answer) {
    set(state => answerAsk(state, id, answer));
    const requestId = id.replace(/^ui:/, "");
    const body = answer === null
      ? { id: requestId, cancelled: true }
      : typeof answer === "boolean" ? { id: requestId, confirmed: answer } : { id: requestId, value: answer };
    try {
      await aiApi.answer(body);
    } catch (error) {
      set(state => addNote(state, message(error), "error"));
    }
  },

  handleEvent(event) {
    if (event.type === "ai.event") {
      set(state => {
        const next = reducePiEvent(state, event.payload);
        return next === state ? state : { parts: next.parts, running: next.running, message: next.message };
      });
      return;
    }
    if (event.type === "ai.status") {
      get().setStatus(event.payload);
      return;
    }
    if (event.type === "connection.open" && (get().open || get().status)) void get().refresh();
  },
}));
