/**
 * Small, side-effect-free policies shared by the Web Audio DJ engine.
 *
 * Keeping these decisions outside djMix.ts makes the Android output policy and the optional
 * effect routing testable without constructing DOM media elements or a real AudioContext.
 */

/** Android WebView is used for music streaming, not latency-sensitive live monitoring. */
export function audioContextOptionsForPlatform(
  platform: string | null | undefined,
): AudioContextOptions | undefined {
  // The default AudioContext latency category is `interactive`. On Android that selects a small
  // hardware queue which is easy to underrun when MediaCodec, the local proxy and waveform work
  // are active together. `playback` deliberately trades a little control latency for a deeper,
  // stable music buffer. Desktop DJ cueing keeps the browser default.
  return platform === "android" ? { latencyHint: "playback" } : undefined;
}

export interface EffectOutputPort<TDestination> {
  connect(destination: TDestination): unknown;
  disconnect(destination: TDestination): unknown;
}

export interface EffectOutputRoute<TDestination> {
  output: EffectOutputPort<TDestination>;
  destination: TDestination;
  connected: boolean;
}

export interface OptionalEffectOutputRoutes<TDestination> {
  echo: EffectOutputRoute<TDestination>;
  hydrant: EffectOutputRoute<TDestination>;
}

export function effectOutputRoute<TDestination>(
  output: EffectOutputPort<TDestination>,
  destination: TDestination,
): EffectOutputRoute<TDestination> {
  return { output, destination, connected: false };
}

/**
 * Connect an optional effect to the audible graph only while it is in use.
 *
 * A zero GainNode is not a reliable CPU gate: Chromium may still render the upstream delay,
 * feedback and convolution graph. Disconnecting its last path to the destination lets the audio
 * engine cull that whole branch. Idempotence is important because cancel/seek/rapid-next paths
 * can all neutralize the same deck.
 */
export function setEffectOutputActive<TDestination>(
  route: EffectOutputRoute<TDestination>,
  active: boolean,
): void {
  if (route.connected === active) return;
  if (active) route.output.connect(route.destination);
  else route.output.disconnect(route.destination);
  route.connected = active;
}

/** Apply the transition's effect selection, also closing branches left by an interrupted mix. */
export function syncOptionalEffectOutputs<TDestination>(
  routes: OptionalEffectOutputRoutes<TDestination>,
  selected: readonly string[],
): void {
  setEffectOutputActive(routes.echo, selected.includes("echo"));
  setEffectOutputActive(routes.hydrant, selected.includes("hydrant"));
}
