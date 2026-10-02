/** Local diagnostic capture only. Remote upload is owned by the explicit report dialog/backend. */
export interface DiagnosticDraft { level: "error" | "warn" | "info"; category: string; source: string; message: string }
let queue: DiagnosticDraft[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | undefined;
let installed = false;
let dropped = 0;
const recent = new Map<string, number>();

function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ""}${value.cause ? `\nCause: ${String(value.cause)}` : ""}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  // Never stringify arbitrary console arguments: they may be settings, credentials or user data.
  if (value && typeof value === "object") {
    return ["name", "message", "stack", "code"].map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && (typeof descriptor.value === "string" || typeof descriptor.value === "number") ? `${key}=${descriptor.value}` : "";
    }).filter(Boolean).join(" ") || "[object omitted]";
  }
  return String(value);
}

export function captureDiagnostic(category: string, source: string, error: unknown, context = "", level: DiagnosticDraft["level"] = "error"): void {
  try {
    if (error instanceof Error && error.name === "AbortError") return;
    const message = `${describe(error)}${context ? `\n${context}` : ""}`.slice(0, 12_000);
    const key = `${category}:${source}:${message}`, now = Date.now();
    if (now - (recent.get(key) ?? 0) < 5_000) { dropped++; return; }
    recent.set(key, now);
    if (recent.size > 200) recent.delete(recent.keys().next().value!);
    queue.push({ category, source, message, level });
    if (queue.length > 200) { queue.shift(); dropped++; }
    schedule();
  } catch { /* Diagnostics must not break the failing operation. */ }
}
function schedule(): void {
  if (timer !== undefined) return;
  timer = setTimeout(() => { timer = undefined; void flushDiagnostics(); }, 1500);
}
export async function flushDiagnostics(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      // Startup diagnostics must not depend on the application module graph or initBridge().
      // Tauri's native invoke is read-only: call it, never replace it.
      const connection = window.kdj ?? (window.__TAURI_INTERNALS__
        ? await window.__TAURI_INTERNALS__.invoke<{ baseUrl: string; authToken: string }>("get_bridge_info")
        : null);
      if (!connection) return;
      const { baseUrl, authToken } = connection;
      while (queue.length) {
        const entries = queue.splice(0, 30);
        if (dropped) { entries.push({ level: "warn", category: "diagnostics", source: "queue", message: `Merged or dropped ${dropped} repeated/overflow entries` }); dropped = 0; }
        try {
          const response = await fetch(`${baseUrl}/api/diagnostics/entries`, {
            method: "POST", headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(entries), signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("Local diagnostic write failed");
        } catch { queue = [...entries, ...queue].slice(-200); break; }
      }
    } catch { /* Bridge may not be ready during startup. Retain a bounded queue. */ }
  })().finally(() => { flushing = undefined; if (queue.length) schedule(); });
  return flushing;
}

export function mediaDiagnostic(media: HTMLMediaElement): string {
  return `code=${media.error?.code ?? 0} message=${media.error?.message ?? ""} readyState=${media.readyState} networkState=${media.networkState} time=${media.currentTime} duration=${media.duration} paused=${media.paused} seeking=${media.seeking} rate=${media.playbackRate} muted=${media.muted} defaultMuted=${media.defaultMuted} volume=${media.volume} visibility=${media.ownerDocument.visibilityState}`;
}

const observedMedia = new WeakSet<HTMLMediaElement>();
/** Shared frame scheduling also owns detached preview elements, whose events never reach document. */
export function observeMediaDiagnostics(media: HTMLMediaElement): void {
  if (observedMedia.has(media)) return;
  observedMedia.add(media);
  media.addEventListener("error", () => captureDiagnostic("playback", media.tagName.toLowerCase(), "MediaError", mediaDiagnostic(media)));
  media.addEventListener("stalled", () => {
    if (!media.paused) captureDiagnostic("playback", "media.stalled", "Media loading stalled", mediaDiagnostic(media), "warn");
  });
}

export function installDiagnostics(): void {
  if (installed) return; installed = true;
  window.addEventListener("error", (event: Event) => {
    if (event.target instanceof HTMLMediaElement) {
      captureDiagnostic("playback", event.target.tagName.toLowerCase(), "MediaError", mediaDiagnostic(event.target));
    } else if (event instanceof ErrorEvent) {
      captureDiagnostic("render", "window.error", event.error ?? event.message, `line=${event.lineno} column=${event.colno}`);
    } else if (event.target instanceof HTMLElement) {
      captureDiagnostic("render", "resource", `Failed ${event.target.tagName}`, "", "warn");
    }
  }, true);
  window.addEventListener("unhandledrejection", event => captureDiagnostic("runtime", "unhandledrejection", event.reason));
  for (const name of ["webglcontextlost", "webglcontextcreationerror", "contextlost"] as const) {
    document.addEventListener(name, event => captureDiagnostic("hardware", name, "Rendering context unavailable", "statusMessage" in event ? String(event.statusMessage) : ""), true);
  }
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      captureDiagnostic("console", `console.${level}`, args.map(describe).join(" "), "", level);
    };
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try { return await originalFetch(...args); }
    catch (error) {
      const raw = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (!raw.includes("/api/diagnostics/")) captureDiagnostic("network", "fetch.transport", error);
      throw error;
    }
  };
  window.addEventListener("pagehide", () => { void flushDiagnostics(); });
}
