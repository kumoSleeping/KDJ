import { liveWaveformPhaseError, smoothlyCorrectedWaveformRate } from "./waveformMotion";

/** Scroll baked pixels on the compositor, independently of React/analysis/main-thread stalls. */
export class WaveformRailMotion {
  private animation: Animation | null = null;
  private key = "";
  private transportKey = "";
  private origin = 0;
  private loopLength = 0;
  private rate = 0;

  position(fallback: number): number {
    if (!this.animation) return fallback;
    const offset = Number(this.animation.currentTime ?? 0) / 1000 * this.rate;
    return this.origin + (this.loopLength
      ? ((offset % this.loopLength) + this.loopLength) % this.loopLength : offset);
  }

  stop() {
    this.animation?.cancel();
    this.animation = null;
    this.key = "";
    this.transportKey = "";
  }

  sync(rail: HTMLElement, position: number, start: number, seconds: number,
    total: number, rate: number, revision: number, loopStart: number | null, loopLength: number | null, discrete = false) {
    const transform = (time: number) => `translate3d(${-(time - start) / (seconds * 3) * 100}%,0,0)`;
    if (!Number.isFinite(rate) || Math.abs(rate) < .001 || typeof rail.animate !== "function") {
      this.stop();
      rail.style.transform = transform(position);
      return;
    }
    const transportKey = `${Math.sign(rate)}:${revision}:${loopStart}:${loopLength}`;
    // A tile rebase or a late clock packet is not a transport discontinuity. Preserve
    // the phase already on screen and converge by velocity, including across tile commits.
    if (!discrete && this.animation && this.transportKey === transportKey && this.animation.playState !== "finished") {
      const predicted = this.position(position);
      const error = liveWaveformPhaseError(position, predicted, this.loopLength || null);
      if (Math.abs(error) < 1.25) {
        position = predicted;
        rate = smoothlyCorrectedWaveformRate(rate, error);
      }
    }
    // A loop fully covered by these tiles can repeat without waking JavaScript at loop-out.
    const repeating = loopStart !== null && loopLength !== null && loopLength > 0
      && position >= loopStart && loopStart >= start + seconds / 2
      && loopStart + loopLength <= start + seconds * 2.5;
    const loopEnd = loopStart !== null && loopLength !== null && loopLength > 0
      ? loopStart + loopLength : total;
    const lower = Math.max(0, start + seconds / 2);
    const upper = Math.min(total, start + seconds * 2.5, loopEnd);
    const origin = repeating ? loopStart! : position;
    const end = repeating ? loopEnd : rate > 0 ? upper : lower;
    // Rate estimates may vary on every post-seek clock sample. They change velocity,
    // not the animation's origin; restarting each time loses compositor frames.
    const key = `${start}:${Math.sign(rate)}:${revision}:${loopStart}:${loopLength}:${repeating}:${total}`;
    if (!discrete && this.animation && this.key === key) {
      const predicted = this.position(position);
      let error = position - predicted;
      if (this.loopLength) error -= Math.round(error / this.loopLength) * this.loopLength;
      // Do not restart the animation for ordinary callback/bridge timestamp jitter.
      if (Math.abs(error) < .08) {
        // Keep `this.rate` as the effect's original time scale: currentTime already
        // incorporates playbackRate, so position() must not multiply by the new rate.
        this.animation.playbackRate = rate / this.rate;
        return;
      }
    }
    this.stop();
    rail.style.transform = transform(position);
    if (!repeating && (end - position) * rate <= 0) return;
    this.origin = origin;
    this.rate = rate;
    this.loopLength = repeating ? loopLength! : 0;
    this.key = key;
    this.transportKey = transportKey;
    const span = repeating ? loopLength! : Math.abs(end - origin);
    this.animation = rail.animate([
      { transform: transform(origin) }, { transform: transform(end) },
    ], { duration: span * 1000 / Math.abs(rate), easing: "linear", fill: "forwards",
      iterations: repeating ? Infinity : 1,
      direction: repeating && rate < 0 ? "reverse" : "normal" });
    const localTime = repeating
      ? (rate > 0 ? position - origin : end - position) * 1000 / Math.abs(rate) : 0;
    // Anchor to the current document frame instead of waiting for the pending play
    // task. Repeated landings otherwise accumulate a one-frame startup delay.
    const timelineTime = rail.ownerDocument?.timeline?.currentTime;
    if (typeof timelineTime === "number") this.animation.startTime = timelineTime - localTime;
    else if (repeating) this.animation.currentTime = localTime;
  }
}
