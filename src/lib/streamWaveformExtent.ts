/**
 * How long an online song is on the rail once the server has decoded its whole media file.
 *
 * While a song loads, its waveform is a prefix: `covered` seconds of PCM laid over the first
 * `covered / duration` of the rail, where `duration` is what the transport says the song lasts.
 * On the native player that is the provider's catalogue duration, not a measurement of the file.
 * When the file turns out to be a different length (another edit, a trial clip, a catalogue
 * entry that is simply wrong) the finished waveform is still treated as a prefix, and the whole
 * song is drawn squeezed into the front of the rail with the rest left empty.
 *
 * A finished decode is the song; its length is the song's length. It may only overrule the
 * transport when something independent agrees with it, though: a decode that stopped early on a
 * damaged file is "finished" too, and laying that over the whole rail would put every bar under
 * the wrong moment of the song. The container's own duration (the full analysis probes it without
 * decoding) is that second witness.
 */

/** Durations this close are the same song: catalogue seconds are rounded, encoders pad. */
const SAME_LENGTH_SECONDS = 2;
const SAME_LENGTH_RATIO = 0.01;

const known = (seconds: number): boolean => Number.isFinite(seconds) && seconds > 0;

/** Whether two durations describe the same length of audio. */
export function streamDurationsAgree(left: number, right: number): boolean {
  if (!known(left) || !known(right)) return false;
  return Math.abs(left - right) <= Math.max(SAME_LENGTH_SECONDS, SAME_LENGTH_RATIO * Math.max(left, right));
}

/**
 * The duration a completely decoded stream is laid over, or 0 when the transport's stands.
 *
 * `transport` is what the player reports for the song (0 when it does not know), `decoded` the
 * seconds of PCM the finished decode produced, `probed` the duration the container declares
 * (0 when the analysis has none).
 */
export function completedStreamDuration(transport: number, decoded: number, probed: number): number {
  if (!known(decoded) || streamDurationsAgree(decoded, transport)) return 0;
  // The file says it is as long as what was decoded: the transport's figure describes
  // something else.
  if (streamDurationsAgree(decoded, probed)) return decoded;
  // Nothing to measure against but the file itself; a longer container means the decode fell
  // short, and what was decoded stays a prefix of it.
  if (!known(transport)) return known(probed) && probed > decoded ? probed : decoded;
  return 0;
}
