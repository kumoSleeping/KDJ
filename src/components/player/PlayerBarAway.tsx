import { useEffect, useLayoutEffect, useRef } from "react";
import { ChevronsDown } from "lucide-react";
import { MOTION_IN_MS, MOTION_REDUCED_MS, leaveDuration, prefersReducedMotion } from "../../lib/motion";
import {
  advancePlayerBar,
  endPlayerBarSlide,
  nowPlayingInfoVisible,
  settlePlayerBar,
  useNowPlayingInfo,
} from "../../lib/nowPlayingInfo";
import {
  playerBarAwayWanted,
  playerBarMoving,
  playerBarStandsDown,
  usePlayerBarAway,
  type PlayerBarPhase,
} from "../../lib/playerBarAway";
import { dismissTask } from "../tasks/taskBubbleStore";
import { NOW_PLAYING_TASK } from "./NowPlayingTask";

/** The playing song's bubble as the host draws it, and the key on it that sends it away. */
const BUBBLE = `.kd-task[data-kind="playing"]`;
const BUBBLE_KEY = `${BUBBLE} .kd-task-dismiss`;

/** The key that had the keyboard's focus when the bar went or came: its counterpart takes the
 *  focus over, so a listener who works by keyboard is not left on nothing. */
let handFocusTo: "bubble" | "collapse" | null = null;

/**
 * Drives where the bar is (src/lib/playerBarAway.ts) from the listener's choice for the shape
 * the window is in. `song` says whether there is a song for the playing song's bubble to show:
 * without one the bar is up whatever was chosen, because the bubble is what stands in for the
 * bar (see playerBarAwayWanted).
 *
 * The first render takes the bar's place without moving. After that the bar slides, and a slide
 * runs for its whole time before the next one can start: when what is wanted changes on the way
 * (the window dragged across the two shapes and back, the bubble sent away while the bar is
 * still going down), the bar arrives first and then sets off again. The bubble is handed the
 * transport as the bar starts down and gives it back as the bar starts up
 * (src/lib/nowPlayingInfo.ts).
 */
export function usePlayerBarPhase(song: boolean): PlayerBarPhase {
  const away = usePlayerBarAway(state => playerBarAwayWanted(state.collapsed, song));
  const phase = usePlayerBarAway(state => state.phase);
  const settled = useRef(false);
  useLayoutEffect(() => {
    if (!settled.current) {
      settled.current = true;
      settlePlayerBar(away);
      return;
    }
    if (advancePlayerBar(away) !== "returning") return;
    const focused = document.activeElement;
    if (focused?.closest(BUBBLE) && focused.matches(":focus-visible")) handFocusTo = "collapse";
    // A bubble that was only up for the bar leaves as the bar starts back, before the stack
    // decides what rides up with the bar.
    if (!nowPlayingInfoVisible(useNowPlayingInfo.getState())) dismissTask(NOW_PLAYING_TASK);
  }, [away, phase]);
  useEffect(() => {
    if (!playerBarMoving(phase)) return;
    const time = phase === "leaving" ? leaveDuration("slide") : prefersReducedMotion() ? MOTION_REDUCED_MS : MOTION_IN_MS;
    const timer = window.setTimeout(endPlayerBarSlide, time + 20);
    return () => window.clearTimeout(timer);
  }, [phase]);
  useEffect(() => {
    if (phase !== "leaving" || handFocusTo !== "bubble") return;
    handFocusTo = null;
    // The bubble is drawn in the pass after this one.
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(BUBBLE_KEY)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [phase]);
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

/**
 * The key on the bar that puts the whole bar away. Playback goes on, and the playing song's
 * bubble comes up as the transport; the key on that bubble brings the bar back.
 */
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
      handFocusTo = event.currentTarget.matches(":focus-visible") ? "bubble" : null;
      usePlayerBarAway.getState().setCollapsed(true);
    }}>
    <ChevronsDown size={15} aria-hidden="true" />
  </button>;
}
