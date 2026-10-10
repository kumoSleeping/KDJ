import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronsDown, ChevronsUp } from "lucide-react";
import { MOTION_IN_MS, MOTION_REDUCED_MS, leaveDuration, motion, prefersReducedMotion } from "../../lib/motion";
import { nowPlayingInfoVisible, useNowPlayingInfo } from "../../lib/nowPlayingInfo";
import {
  nextPlayerBarPhase,
  playerBarMoving,
  playerBarStandsDown,
  usePlayerBarAway,
  type PlayerBarPhase,
} from "../../lib/playerBarAway";
import { dismissTask } from "../tasks/taskBubbleStore";
import { NOW_PLAYING_TASK } from "./NowPlayingTask";
import "./PlayerBarAway.css";

const POP = motion("pop");

/** The key that took the keyboard's focus with it when the bar went or came: its counterpart
 *  takes the focus over, so a listener who works by keyboard is not left on nothing. */
let handFocusTo: "return" | "collapse" | null = null;

/**
 * Drives where the bar is (src/lib/playerBarAway.ts) from the listener's choice. `offered` is
 * false in a layout that does not offer the collapse: the bar is then up whatever was chosen.
 * A slide runs for its whole time before the bar settles; the first render takes the place the
 * bar was left in without moving. The playing song's bubble hears of it in the same pass, so it
 * rises as the bar starts down (see nowPlayingKeptAway).
 */
export function usePlayerBarPhase(offered: boolean): PlayerBarPhase {
  const away = usePlayerBarAway(state => state.collapsed) && offered;
  const phase = usePlayerBarAway(state => state.phase);
  const settled = useRef(false);
  useLayoutEffect(() => {
    const bar = usePlayerBarAway.getState();
    useNowPlayingInfo.getState().setBarAway(away);
    // A bubble that was only kept for the bar leaves as the bar starts back, before the stack
    // decides what rides up with the bar.
    if (!away && !nowPlayingInfoVisible(useNowPlayingInfo.getState())) dismissTask(NOW_PLAYING_TASK);
    const rest: PlayerBarPhase = away ? "away" : "up";
    if (!settled.current) {
      settled.current = true;
      bar.setPhase(rest);
      return;
    }
    const step = nextPlayerBarPhase(bar.phase, away);
    if (!step) return;
    bar.setPhase(step);
    const time = away ? leaveDuration("slide") : prefersReducedMotion() ? MOTION_REDUCED_MS : MOTION_IN_MS;
    const timer = window.setTimeout(() => bar.setPhase(rest), time + 20);
    return () => window.clearTimeout(timer);
  }, [away]);
  // What stood beside the bar makes room for the key at the bottom-left corner (PlayerBarAway.css).
  const standsDown = playerBarStandsDown(phase);
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-kd-bar-away", standsDown);
    return () => document.documentElement.removeAttribute("data-kd-bar-away");
  }, [standsDown]);
  return phase;
}

/**
 * What the bar's own element carries for its phase: out of the layout and over the page from
 * the start of the slide (`data-bar`, see design.css), moving by the motion schema's `slide`
 * from the bottom edge, and inert while it is on its way out or gone.
 */
export function playerBarPhaseProps(phase: PlayerBarPhase) {
  const moving = playerBarMoving(phase);
  return {
    "data-bar": phase === "up" ? undefined : phase,
    "data-kd-motion": moving ? "slide" : undefined,
    "data-kd-edge": moving ? "bottom" : undefined,
    "data-kd-leaving": phase === "leaving" ? "true" : undefined,
    inert: playerBarStandsDown(phase),
  };
}

/** The key on the bar that puts the whole bar away. Playback goes on. */
export function PlayerBarCollapseKey() {
  const phase = usePlayerBarAway(state => state.phase);
  const key = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase !== "returning" || handFocusTo !== "collapse") return;
    handFocusTo = null;
    key.current?.focus();
  }, [phase]);
  return <button ref={key} type="button" className="kd-player-step kd-player-collapse" aria-label="收起播放条" title="收起播放条"
    onClick={event => {
      // A slide is never turned around halfway: the key acts once the bar has arrived.
      if (usePlayerBarAway.getState().phase !== "up") return;
      handFocusTo = event.currentTarget.matches(":focus-visible") ? "return" : null;
      usePlayerBarAway.getState().setCollapsed(true);
    }}>
    <ChevronsDown size={15} aria-hidden="true" />
  </button>;
}

/**
 * The little thing at the bottom-left corner while the bar is away: the playing record, turning
 * while it plays, on a small floating surface. Clicking it brings the bar back up. It pops in
 * when the bar has gone and pops out as the bar starts back (docs/motion-schema.md).
 */
export const PlayerBarReturnKey = memo(function PlayerBarReturnKey({ cover, spinning }: {
  /** The cover of the song on the deck, "" when there is none to show. */
  cover: string;
  spinning: boolean;
}) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setRoot(document.querySelector<HTMLElement>(".kd-app")); }, []);
  const [failed, setFailed] = useState("");
  const key = useRef<HTMLButtonElement | null>(null);
  // The schema's own ref plays the leaving gesture when the key is taken away.
  const attach = useCallback((node: HTMLButtonElement | null) => {
    key.current = node;
    return node ? POP.ref(node) : undefined;
  }, []);
  useEffect(() => {
    if (!root || handFocusTo !== "return") return;
    handFocusTo = null;
    key.current?.focus();
  }, [root]);
  if (!root) return null;
  return createPortal(
    <button type="button" className="kd-bar-return" aria-label="展开播放条" title="展开播放条"
      {...POP} ref={attach}
      onClick={event => {
        handFocusTo = event.currentTarget.matches(":focus-visible") ? "collapse" : null;
        usePlayerBarAway.getState().setCollapsed(false);
      }}>
      <span className="kd-bar-return-record" data-spinning={spinning ? "true" : undefined} aria-hidden="true">
        {cover && failed !== cover
          ? <img key={cover} src={cover} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(cover)} />
          : <i />}
      </span>
      <ChevronsUp className="kd-bar-return-mark" size={16} aria-hidden="true" />
    </button>,
    root,
  );
});
