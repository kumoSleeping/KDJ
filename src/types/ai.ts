/** KDJ's AI (docs/ai-dock.md): pi run by kdj-server, driven from the search row's AI mode. */

export type PiState = "missing" | "broken" | "ready";

export interface AiProviderInfo {
  /** pi's own provider id (`deepseek`, `moonshotai-cn`, …). */
  id: string;
  label: string;
  /** A key for it is in KDJ's own pi directory. */
  configured: boolean;
}

export interface AiStatus {
  pi: {
    state: PiState;
    path?: string;
    version?: string;
    /** The newest published version, when it is newer than the one found. */
    latest?: string;
    error?: string;
  };
  providers: AiProviderInfo[];
  provider: string | null;
  model: string | null;
  /** pi is running. */
  running: boolean;
  /** How hard the model thinks; high unless the listener chose otherwise. */
  thinking: AiThinking;
  /** Remotion in the AI's workspace (设置 → AI → 视频), which the video skill renders with. */
  remotion: {
    /** Installed version; null when it is not installed. */
    version: string | null;
    installing: boolean;
    /** Why the last install failed. */
    error: string;
  };
  web: {
    mode: AiWebMode;
    /** pi-web-access is installed in KDJ's pi directory. */
    access: boolean;
    installing: boolean;
    /** Why the last install failed. */
    error: string;
    /** A Jina key is kept. */
    jina: boolean;
  };
}

/** pi's reasoning efforts that the key beside Agent Mode steps through. */
export type AiThinking = "low" | "medium" | "high" | "xhigh";

/** How the AI searches the web: pi-web-access, or one of KDJ's own ways. */
export type AiWebMode = "access" | "deepseek" | "deepseek-jina" | "jina";

export interface AiModel {
  provider: string;
  id: string;
  name: string;
}

/** One line of pi's RPC stream (`pi --mode rpc`), as kdj-server forwards it. */
export interface PiEvent {
  type: string;
  [field: string]: unknown;
}

/** A login in the user's own pi (~/.pi/agent/auth.json) that can be brought into KDJ's. */
export interface AiGlobalLogin {
  id: string;
  label: string;
  kind: string;
  importable: boolean;
}

/** One of the AI's past sessions (crates/kdj-server/src/ai/sessions.rs). */
export interface AiSessionSummary {
  path: string;
  id: string;
  /** ISO 8601. */
  started: string;
  /** Unix ms of the last change. */
  updated: number;
  /** The first request, cut short. */
  title: string;
  requests: number;
  steps: number;
}

/** What was asked, or one tool call and how it ended. */
export type AiSessionStep =
  | { kind: "request"; text: string; attached: string[]; at: string }
  | { kind: "tool"; tool: string; args: unknown; failed: boolean; text: string; details: unknown };
