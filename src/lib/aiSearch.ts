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
