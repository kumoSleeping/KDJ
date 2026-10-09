import type { IntakeItem, Platform, VideoInfo } from "../../types";

/**
 * What the search bar's motion needs to know about a search without owning it: how far the
 * typed text reaches, and which sources a finished search heard back from. The result table
 * publishes the second; the bar's source marks settle on it.
 */

/** A running search, then the moment its results land. */
export type SearchPhase = "run" | "done";

/** One source mark during a search: asked, answered, answered with nothing, failed, or simply done. */
export type SearchMarkState = "run" | "hit" | "miss" | "fail" | "settle";

export interface SearchOutcome {
  /** Sources that brought back at least one row. */
  hits: ReadonlySet<Platform>;
  /** Sources that reported an error. */
  fails: ReadonlySet<Platform>;
}

const WIDE_GLYPH = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-｠￠-￦]/;

/**
 * Rough width of one line of text in em, from character classes alone. The field's ink follows
 * the typed text with this, so typing never reads the layout.
 */
export function estimateTextEm(text: string): number {
  let em = 0;
  for (const char of text) {
    if (WIDE_GLYPH.test(char) || char.length > 1) em += 1;
    else if (char === " ") em += 0.28;
    else if (/[A-Z0-9mw@#%&]/.test(char)) em += 0.66;
    else if (/[.,:;!|'`ijl()[\]/]/.test(char)) em += 0.32;
    else em += 0.54;
  }
  return Math.round(em * 100) / 100;
}

/** Which sources a delivered list heard back from. Local copies are not a searched source. */
export function searchOutcomeOf(
  items: ReadonlyArray<IntakeItem>,
  video: VideoInfo | null,
): SearchOutcome {
  const hits = new Set<Platform>();
  const fails = new Set<Platform>();
  if (video) hits.add(video.platform);
  for (const item of items) {
    for (const group of item.groups) {
      for (const source of group.sources) {
        if (source.platform !== "local") hits.add(source.platform);
      }
    }
    for (const collection of item.collections) hits.add(collection.platform);
    for (const platform of Object.keys(item.errors)) fails.add(platform as Platform);
  }
  // A source that failed for one entry of a batch and answered another did answer.
  for (const platform of hits) fails.delete(platform);
  return { hits, fails };
}

/** How one selected source mark shows the search right now. */
export function searchMarkState(
  phase: SearchPhase,
  platform: Platform,
  outcome: SearchOutcome | null,
): SearchMarkState {
  if (phase === "run") return "run";
  if (!outcome) return "settle";
  if (outcome.hits.has(platform)) return "hit";
  return outcome.fails.has(platform) ? "fail" : "miss";
}

let current: SearchOutcome | null = null;
const listeners = new Set<() => void>();

function sameSet(a: ReadonlySet<Platform>, b: ReadonlySet<Platform>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function emit() {
  for (const listener of listeners) listener();
}

/** The result table reports what the list it now shows came back with. */
export function publishSearchOutcome(next: SearchOutcome) {
  if (current && sameSet(current.hits, next.hits) && sameSet(current.fails, next.fails)) return;
  current = next;
  emit();
}

/** A new search forgets the previous answer, so its marks never settle on stale results. */
export function clearSearchOutcome() {
  if (!current) return;
  current = null;
  emit();
}

export function getSearchOutcome(): SearchOutcome | null {
  return current;
}

export function subscribeSearchOutcome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
