import { useEffect, useState, type CSSProperties, type HTMLAttributes } from "react";
import { MOTION_REDUCED_MS, prefersReducedMotion } from "../../lib/motion";
import type { IntakeItem, Platform, VideoInfo } from "../../types";
import { PLATFORM_BRAND } from "./PlatformMark";

/**
 * What the search's motion needs to know without owning the search: the colours of the selected
 * sources, how far the submitted text reaches, which sources a finished search heard back from
 * (the result table publishes it; the bar's source marks settle on it), and how rows that were
 * unfolded in the results fold back.
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

const WIDE_GLYPH = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-｠￠-￦]/;

/**
 * Rough width of one line of text in em, from character classes alone. A search's waveform
 * steps back behind the submitted text with this: worked out once per search, never while
 * typing, and without reading the layout.
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

/**
 * The colours a search is drawn in: the brand colour of every selected source, in the order of
 * the marks. Neighbours of one colour count once, and there are always two stops, so the list
 * can be written straight into a gradient (`--kd-search-tones`). Empty when nothing is selected.
 */
export function searchTones(
  marks: ReadonlyArray<Platform>,
  selected: ReadonlyArray<Platform>,
): string[] {
  const tones: string[] = [];
  for (const platform of marks) {
    const tone = selected.includes(platform) ? PLATFORM_BRAND[platform] : undefined;
    if (tone && tones[tones.length - 1] !== tone) tones.push(tone);
  }
  return tones.length === 1 ? [tones[0], tones[0]] : tones;
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

/**
 * Rows that were unfolded under a result row fold back in two beats (ResultTable.css): they fade
 * out from the last one up ("out"), then the room they held closes ("shut").
 */
export type FoldPhase = "open" | "out" | "shut" | "closed";

/** One row's fade, the step between rows, and how many steps are told apart. */
const FOLD_OUT_MS = 100;
const FOLD_STEP_MS = 12;
const FOLD_STEPS = 6;
/** The room the rows held closing. */
const FOLD_SHUT_MS = 160;
/** A long package fades only the rows that can be on screen; the rest simply go. */
export const FOLD_MAX_ROWS = 40;

/** When a row starts to leave, in steps: the last row first. */
export function foldOrder(index: number, rows: number): number {
  return Math.max(0, Math.min(rows - 1 - index, FOLD_STEPS));
}

/** How long the rows take to fade out, the first row's later start included. */
export function foldOutDuration(rows: number): number {
  return FOLD_OUT_MS + FOLD_STEP_MS * foldOrder(0, rows);
}

/**
 * Follows `open` and keeps what was closed on screen for as long as it takes to fold away.
 * Opening again at any point simply shows the rows. Under reduced motion the rows fade and the
 * room closes at once.
 */
export function useFold(open: boolean, rows: number): FoldPhase {
  const [phase, setPhase] = useState<FoldPhase>(open ? "open" : "closed");
  if (open && phase !== "open") setPhase("open");
  else if (!open && phase === "open") setPhase(rows > 0 ? "out" : "closed");

  useEffect(() => {
    if (phase !== "out" && phase !== "shut") return;
    const reduced = prefersReducedMotion();
    const wait = phase === "shut" ? FOLD_SHUT_MS : reduced ? MOTION_REDUCED_MS : foldOutDuration(rows);
    const timer = window.setTimeout(() => {
      setPhase((current) => {
        if (current !== phase) return current;
        return phase === "out" && !reduced ? "shut" : "closed";
      });
    }, wait);
    return () => window.clearTimeout(timer);
  }, [phase, rows]);

  return phase;
}

/** What a row carries while it fades out: it is a picture of itself, not a control. */
export function foldingRowProps(order: number | undefined): HTMLAttributes<HTMLTableRowElement> | undefined {
  if (order === undefined) return undefined;
  return {
    "data-fold": "out",
    inert: true,
    "aria-hidden": true,
    tabIndex: -1,
    style: { "--kd-fold-i": order } as CSSProperties,
  } as HTMLAttributes<HTMLTableRowElement>;
}
