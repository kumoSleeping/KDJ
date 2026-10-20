import type { Platform, SearchKind } from "../types";

/**
 * pi searched (`kdj_search`, docs/ai-dock.md): the search pane shows the same search, as if the
 * listener had run it, so what the AI looks at is on screen. Workspace runs it; kept out of the
 * Workspace file so Fast Refresh keeps working there.
 */
export type AiSearchDetail = {
  query: string;
  kind?: SearchKind;
  platforms?: Platform[];
};

export const AI_SEARCH_EVENT = "kd:ai-search";

const KINDS: readonly SearchKind[] = ["song", "playlist", "album", "artist", "radio"];
const PLATFORMS: readonly Platform[] = ["wyy", "qqm", "soundcloud", "ytm", "youtube", "bilibili"];

export function requestAiSearch(args: Record<string, unknown>): void {
  // Several keywords arrive one per line: the pane searches them together (searchInterleave.ts).
  const query = typeof args.text === "string" ? args.text.trim() : "";
  if (!query) return;
  const kind = KINDS.find(item => item === args.kind);
  const platforms = Array.isArray(args.platforms)
    ? PLATFORMS.filter(platform => (args.platforms as unknown[]).includes(platform))
    : [];
  window.dispatchEvent(new CustomEvent<AiSearchDetail>(AI_SEARCH_EVENT, {
    detail: { query, kind, platforms: platforms.length ? platforms : undefined },
  }));
}

/**
 * pi looked something up in the library (`kdj_library_list`): the library shows the same lookup
 * — the rail's search words, key, BPM range, energy and folder — as if the listener had typed it.
 * The tool asks the same endpoint with the same filter, so the list is what the AI got.
 */
export type AiLibraryDetail = {
  q: string;
  key: string;
  bpmMin: number | null;
  bpmMax: number | null;
  energyMin: number | null;
  /** An absolute folder; absent leaves the open folder as it is. */
  folder?: string;
};

export const AI_LIBRARY_EVENT = "kd:ai-library";

/** "124..130", or one tempo for both ends, as the tool takes it. */
function bpmRange(raw: unknown): [number | null, number | null] {
  if (typeof raw !== "string" || !raw.trim()) return [null, null];
  const [lo, hi = lo] = raw.split("..").map(part => Number(part.trim()));
  return [Number.isFinite(lo) ? lo : null, Number.isFinite(hi) ? hi : null];
}

export function requestAiLibrary(args: Record<string, unknown>): void {
  const [bpmMin, bpmMax] = bpmRange(args.bpm);
  const folder = typeof args.folder === "string" && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(args.folder.trim())
    ? args.folder.trim()
    : undefined;
  window.dispatchEvent(new CustomEvent<AiLibraryDetail>(AI_LIBRARY_EVENT, {
    detail: {
      q: typeof args.q === "string" ? args.q.trim() : "",
      // The library writes keys as Camelot codes ("8A"); any other spelling is passed as given.
      key: typeof args.key === "string"
        ? (/^\d{1,2}[ab]$/i.test(args.key.trim()) ? args.key.trim().toUpperCase() : args.key.trim())
        : "",
      bpmMin,
      bpmMax,
      energyMin: typeof args.energy === "number" && Number.isFinite(args.energy) ? args.energy : null,
      folder,
    },
  }));
}
