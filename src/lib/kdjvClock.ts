/** The clock a project's picture follows; shared by the live (<video>) and the WebCodecs picture. */
import { getLatestPlayerSync, getLocalVideoClock, usesLocalVideoDeviceClock } from "./mediaSync";

export interface LiveTransport {
  position: number;
  playing: boolean;
}

export type Heard = { position: number; at: number; playing: boolean; rate: number };
/** How long a clock gone quiet is carried on from where it was, before the picture waits. */
const CARRY_MS = 1_500;

/**
 * Where the project is: the player's device clock, else its last word (web and Android). The
 * device clock is unreadable for moments — while a seek swaps the decks, or the other deck holds
 * the next song — and the last word may be about another row: then the time last known is carried
 * on (and held after a while), never put back to 0, which threw the picture and the window's
 * progress back to the start and forth again.
 */
export function projectTime(trackId: number, heard: Heard | null, known: { current: Heard | null }) {
  const carried = () => {
    const last = known.current;
    if (!last) return null;
    const age = performance.now() - last.at;
    const position = last.position + (last.playing ? Math.min(age, CARRY_MS) / 1000 * last.rate : 0);
    return { position, playing: last.playing && age <= CARRY_MS, rate: last.rate, clock: null };
  };
  if (usesLocalVideoDeviceClock()) {
    const clock = getLocalVideoClock(trackId);
    if (clock) {
      const playing = clock.playing && clock.rate > 0;
      known.current = { position: clock.position, at: performance.now(), playing, rate: clock.rate };
      return { position: clock.position, playing, rate: clock.rate, clock };
    }
    const last = getLatestPlayerSync(trackId);
    const kept = carried();
    if (kept) return kept;
    return { position: last?.position ?? 0, playing: false, rate: 1, clock: null };
  }
  if (!heard) return carried() ?? { position: 0, playing: false, rate: 1, clock: null };
  const position = heard.position + (heard.playing ? (performance.now() - heard.at) / 1000 * heard.rate : 0);
  known.current = { position, at: performance.now(), playing: heard.playing, rate: heard.rate };
  return { position, playing: heard.playing, rate: heard.rate, clock: null };
}
