/** The AI corner (docs/ai-dock.md): pi run by kdj-server, its events and what the dock draws. */

export type PiState = "missing" | "broken" | "ready";

export interface AiProviderInfo {
  /** pi's own provider id (`deepseek`, `moonshot`, …). */
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
  /** pi is running for this window's conversation. */
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

export type AiStepState = "running" | "done" | "error";

/** A tool pi called, from `tool_execution_start` to `tool_execution_end`. */
export interface AiToolStep {
  kind: "tool";
  id: string;
  tool: string;
  args: Record<string, unknown>;
  state: AiStepState;
  /** `details` of the latest partial result (a download's progress). */
  partial?: unknown;
  /** `details` of the result: the command's own JSON. */
  details?: unknown;
  /** The text the model was given back. */
  text?: string;
  durationMs?: number;
}

export interface AiTextPart {
  kind: "text" | "thinking";
  id: string;
  text: string;
  streaming: boolean;
}

export interface AiUserPart {
  kind: "user";
  id: string;
  text: string;
}

/** A question an extension asked (`extension_ui_request`), answered in the dock. */
export interface AiAskPart {
  kind: "ask";
  id: string;
  method: "select" | "confirm" | "input";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  /** What was answered; null when it was cancelled. Absent while it waits. */
  answer?: string | boolean | null;
}

export interface AiNotePart {
  kind: "note";
  id: string;
  text: string;
  tone: "info" | "error";
}

export type AiPart = AiToolStep | AiTextPart | AiUserPart | AiAskPart | AiNotePart;
