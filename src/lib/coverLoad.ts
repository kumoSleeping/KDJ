/**
 * How one cover box gets its picture on screen.
 *
 * A box is given every address that can show its cover, best first — for a library track the
 * sized thumbnail and then the embedded original. The state below only records what the image
 * element reported about those addresses; what the box draws is worked out from it during
 * render. Nothing is reset by an effect: an effect that raises "loading" runs after the commit,
 * and a picture that was already cached reports its load before that, so the flag came back up
 * over a finished image and stayed there.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";

/** The whole list is tried again this many times after every address in it has failed. */
export const COVER_RETRY_ROUNDS = 1;
/** How long a failed list rests before that. A file being rewritten is readable again by then. */
export const COVER_RETRY_MS = 4_000;

/**
 * The revision a library cover is asked for under. A view may hold a record read earlier than
 * the list's own (the deck keeps the one a song started with), and a cover written since then
 * is only reachable under the later of the two. Revisions are timestamps in one format, so
 * they order as text.
 */
export function newerRevision(held: string, listed: string | null | undefined): string {
  return listed && listed > held ? listed : held;
}

export interface CoverLoadState {
  /** Whose cover the rest is about. Another owner starts from nothing. */
  owner: number | string;
  /** The addresses the rest is about. Another list forgets the failures, nothing else. */
  list: string;
  /** Addresses that did not load in this round. */
  failed: readonly string[];
  /** A picture of this owner is on screen in the image element. */
  painted: boolean;
  /**
   * The box has shown its no-cover face for this owner. Later attempts — another round, a new
   * revision — run behind that face instead of raising the loading placeholder again.
   */
  quiet: boolean;
  /** How many times the list has been tried again. */
  round: number;
}

export interface CoverLoadView {
  /** The address the image element asks for; "" once every one has failed. */
  src: string;
  /** What the box shows. "loading" covers a first picture that has not arrived yet. */
  face: "image" | "loading" | "missing";
  /** Every address has failed and another round is still owed. */
  retryDue: boolean;
}

const listKey = (urls: readonly string[]): string => urls.join("\n");

export function coverLoadStart(owner: number | string, urls: readonly string[] = []): CoverLoadState {
  return { owner, list: listKey(urls), failed: [], painted: false, quiet: false, round: 0 };
}

/**
 * The state as it applies to this owner and these addresses. A new revision of the same owner
 * keeps what the box shows — its picture is replaced in place — and owes nothing to the
 * failures of the addresses before it.
 */
function settled(state: CoverLoadState, owner: number | string, urls: readonly string[]): CoverLoadState {
  if (state.owner !== owner) return coverLoadStart(owner, urls);
  const list = listKey(urls);
  if (state.list === list) return state;
  return { ...state, list, failed: [], round: 0 };
}

export function coverLoadView(state: CoverLoadState, owner: number | string, urls: readonly string[]): CoverLoadView {
  const own = settled(state, owner, urls);
  const src = urls.find((url) => url !== "" && !own.failed.includes(url)) ?? "";
  if (!src) {
    return { src, face: "missing", retryDue: urls.some(Boolean) && own.round < COVER_RETRY_ROUNDS };
  }
  return { src, face: own.painted ? "image" : own.quiet ? "missing" : "loading", retryDue: false };
}

/** The image element finished loading `url`. */
export function coverLoaded(state: CoverLoadState, owner: number | string, urls: readonly string[], url: string): CoverLoadState {
  const own = settled(state, owner, urls);
  if (!urls.includes(url) || own.painted) return own;
  return { ...own, painted: true, quiet: false };
}

/** The image element could not load `url`: the next address takes over, and nothing is on screen. */
export function coverFailed(state: CoverLoadState, owner: number | string, urls: readonly string[], url: string): CoverLoadState {
  const own = settled(state, owner, urls);
  if (!urls.includes(url) || own.failed.includes(url)) return own;
  const failed = [...own.failed, url];
  const exhausted = urls.every((candidate) => candidate === "" || failed.includes(candidate));
  return { ...own, failed, painted: false, quiet: own.quiet || exhausted };
}

/** Another round over the same addresses, after all of them failed. */
export function coverRetried(state: CoverLoadState, owner: number | string, urls: readonly string[]): CoverLoadState {
  const own = settled(state, owner, urls);
  if (own.failed.length === 0) return own;
  return { ...own, failed: [], round: own.round + 1 };
}

/**
 * The cover behind these addresses was just written: ask again from the first one, with the
 * retry owed anew. Whatever the box shows stays until the new picture has loaded.
 */
export function coverRenewed(state: CoverLoadState, owner: number | string, urls: readonly string[]): CoverLoadState {
  const own = settled(state, owner, urls);
  if (own.failed.length === 0 && own.round === 0) return own;
  return { ...own, failed: [], round: 0 };
}

export interface CoverLoad extends CoverLoadView {
  /** Goes on the image element, which must be keyed by the owner so each owner gets its own. */
  imageRef: RefObject<HTMLImageElement | null>;
  onLoad(event: SyntheticEvent<HTMLImageElement>): void;
  onError(event: SyntheticEvent<HTMLImageElement>): void;
  /** See {@link coverRenewed}. */
  renew(): void;
}

/**
 * Loads a cover from the first of `urls` that works. The caller renders one `<img>` with
 * `src`, `imageRef` and the two handlers whenever `src` is not empty, and the placeholder
 * that `face` names. While the face is "missing" the image is hidden, not removed: that is a
 * later attempt loading behind the no-cover face.
 */
export function useCoverLoad(owner: number | string, urls: readonly string[]): CoverLoad {
  const [state, setState] = useState(() => coverLoadStart(owner, urls));
  const view = coverLoadView(state, owner, urls);
  const list = listKey(urls);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // The handlers are told which address the element was showing, not which one this render
  // would ask for: an event is about the request that produced it.
  const current = useRef({ owner, urls });
  current.current = { owner, urls };
  const report = useCallback((update: typeof coverLoaded, url: string) => {
    setState((before) => update(before, current.current.owner, current.current.urls, url));
  }, []);
  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    report(coverLoaded, event.currentTarget.getAttribute("src") ?? "");
  }, [report]);
  const onError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    report(coverFailed, event.currentTarget.getAttribute("src") ?? "");
  }, [report]);
  const renew = useCallback(() => {
    setState((before) => coverRenewed(before, current.current.owner, current.current.urls));
  }, []);

  // A picture can be complete before its load event reaches a handler (it was in the cache
  // when the element was created). The element itself is the evidence then.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image || !view.src || image.getAttribute("src") !== view.src) return;
    if (image.complete && image.naturalWidth > 0) report(coverLoaded, view.src);
  }, [owner, view.src, report]);

  useEffect(() => {
    if (!view.retryDue) return;
    const timer = window.setTimeout(() => {
      setState((before) => coverRetried(before, current.current.owner, current.current.urls));
    }, COVER_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [view.retryDue, owner, list]);

  return { ...view, imageRef, onLoad, onError, renew };
}
