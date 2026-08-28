export interface VjMixInput {
  playing: readonly [boolean, boolean];
  crossfaderEnabled: boolean;
  /** Physical crossfader position: -1 is Deck A, +1 is Deck B. */
  crossfader: number;
  /** Raw channel-fader positions, before the audio taper is applied. */
  channelFaders: readonly [number, number];
}

export type VjMixWeights = readonly [number, number];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/**
 * Resolve the deliberately small VJ mixer into two additive source weights.
 *
 * An unlocked crossfader is the sole visual transition owner. A stopped Deck contributes the
 * current theme matte, so moving toward it also fades a playing video to that matte. When the
 * crossfader is locked, the two channel faders take over. Their relative positions choose the
 * overlay while the taller fader chooses how far the result is from the matte; this keeps two
 * fully-open channels from overexposing.
 */
export function vjMixWeights(input: VjMixInput): VjMixWeights {
  if (input.crossfaderEnabled) {
    const ratio = (clamp(input.crossfader, -1, 1) + 1) / 2;
    return [
      input.playing[0] ? 1 - ratio : 0,
      input.playing[1] ? ratio : 0,
    ];
  }

  const rawA = input.playing[0] ? clamp(input.channelFaders[0], 0, 1) : 0;
  const rawB = input.playing[1] ? clamp(input.channelFaders[1], 0, 1) : 0;
  const total = rawA + rawB;
  if (total <= 0) return [0, 0];
  const brightness = Math.max(rawA, rawB);
  return [rawA / total * brightness, rawB / total * brightness];
}

/** Convert linear A/B/matte weights into two ordered canvas `source-over` alphas. */
export function vjMixSourceOverAlphas(weights: VjMixWeights): VjMixWeights {
  const right = clamp(weights[1], 0, 1);
  const leftWeight = clamp(weights[0], 0, 1 - right);
  return [right < 1 ? leftWeight / (1 - right) : 0, right];
}
