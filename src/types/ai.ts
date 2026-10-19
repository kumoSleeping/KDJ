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
}

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
