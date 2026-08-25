import assert from "node:assert/strict";
import test from "node:test";
import {
  collectMidiOutputs,
  decodeMidiValue,
  dispatchMidiMessage,
  encodeMidiOutput,
  mappingForPort,
  mappingMatchesPort,
  midiBindingInverts,
  MidiEchoGuard,
  MidiFourteenBit,
  parseMidiBytes,
  resolveMidiActions,
  scaleUnitToRange,
  type MidiMapping,
} from "../src/lib/midi/mapping";
import { MIDI_PRESETS } from "../src/lib/midi/presets";
import reloopBuddy from "../src/midi/reloop-buddy.json";

const layers = {};

test("Buddy mapping matches the hardware port name", () => {
  assert.equal(mappingMatchesPort(reloopBuddy, "Reloop Buddy"), true);
  assert.equal(mappingMatchesPort(reloopBuddy, "Buddy"), true);
  assert.equal(mappingForPort("IAC Driver Bus 1", MIDI_PRESETS), null);
});

test("note press toggles play; note off is ignored", () => {
  const press = parseMidiBytes([0x90, 0, 127]);
  const release = parseMidiBytes([0x80, 0, 64]);
  assert.ok(press && press.pressed);
  assert.deepEqual(resolveMidiActions(reloopBuddy, press, layers), [{ type: "playToggle", deck: 0 }]);
  assert.ok(release && !release.pressed);
  assert.deepEqual(resolveMidiActions(reloopBuddy, release, layers), []);
});

test("EQ knobs remain EQ and the former STEM-layer buttons return to PFL", () => {
  const high = parseMidiBytes([0xb0, 23, 127])!;
  assert.deepEqual(resolveMidiActions(reloopBuddy, high, layers), [{ type: "eqHigh", deck: 0, value: 1 }]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x90, 27, 127])!, layers), [
    { type: "pflToggle", deck: 0 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x91, 27, 127])!, layers), [
    { type: "pflToggle", deck: 1 },
  ]);
});

test("Buddy FX LEVEL controls FX1 dry/wet and Shift changes FX1 parameter", () => {
  const message = parseMidiBytes([0xb8, 0, 64])!;
  assert.deepEqual(resolveMidiActions(reloopBuddy, message, layers), [
    { type: "fxMix", value: 64 / 127 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, message, { shift: true }), [
    { type: "fxParameter", value: 64 / 127 },
  ]);
});

test("Buddy FX arrows select FX1 and paddles expose HOLD/ON as absolute enable state", () => {
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x98, 5, 127])!, layers), [
    { type: "fxPrevious" },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x99, 6, 127])!, layers), [
    { type: "fxNext" },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x98, 0, 127])!, layers), [
    { type: "fxEnabled", deck: 0, held: true },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x88, 0, 0])!, layers), [
    { type: "fxEnabled", deck: 0, held: false },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x99, 0, 127])!, layers), [
    { type: "fxEnabled", deck: 1, held: true },
  ]);
});

test("relative controls use exact two's-complement magnitude", () => {
  assert.equal(decodeMidiValue(1, "relative"), 1);
  assert.equal(decodeMidiValue(127, "relative"), -1);
  assert.equal(decodeMidiValue(63, "relative"), 63);
  assert.equal(decodeMidiValue(65, "relative"), -63);
  assert.equal(decodeMidiValue(64, "relative"), -64);
  assert.equal(decodeMidiValue(65, "relativeCentered"), 1);
  assert.equal(decodeMidiValue(63, "relativeCentered"), -1);
  assert.equal(decodeMidiValue(64, "relativeCentered"), 0);
  const turn = parseMidiBytes([0xb4, 52, 127])!;
  assert.deepEqual(resolveMidiActions(reloopBuddy, turn, layers), [{ type: "loopSize", deck: 0, delta: -1 }]);
  const press = parseMidiBytes([0x94, 64, 127])!;
  assert.deepEqual(resolveMidiActions(reloopBuddy, press, layers), [{ type: "loopToggle", deck: 0 }]);
});

test("LED output follows play, loop, and PFL state", () => {
  const outputs = collectMidiOutputs(reloopBuddy, {
    playing: [true, false],
    pausedLoaded: [false, true],
    syncing: [false, false],
    looping: [true, false],
    pfl: [true, false],
    crossfaderEnabled: true,
  });
  const playA = outputs.find((item) => item.channel === 0 && item.data === 0);
  const cueB = outputs.find((item) => item.channel === 1 && item.data === 1);
  const pflA = outputs.find((item) => item.channel === 0 && item.data === 27);
  const loopA = outputs.find((item) => item.channel === 4 && item.data === 64);
  assert.equal(playA?.value, 127);
  assert.equal(cueB?.value, 127);
  assert.equal(pflA?.value, 127);
  assert.equal(loopA?.value, 127);
  assert.deepEqual(encodeMidiOutput(playA!), [0x90, 0, 127]);
});

test("PFL LED note-on echo is not treated as another headphone button press", () => {
  const echo = new MidiEchoGuard();
  const led = encodeMidiOutput({ kind: "note", channel: 0, data: 27, value: 127 });
  echo.recordOutput(led, 1_000);
  const bounced = parseMidiBytes(led)!;
  assert.equal(echo.isEcho(bounced, 1_010), true);
  assert.equal(echo.isEcho(bounced, 1_020), false, "a real second press still toggles");
});

test("a late PFL button press is not swallowed as LED echo", () => {
  const echo = new MidiEchoGuard();
  echo.recordOutput(encodeMidiOutput({ kind: "note", channel: 0, data: 27, value: 127 }), 1_000);
  const press = parseMidiBytes([0x90, 27, 127])!;
  assert.equal(echo.isEcho(press, 1_200), false);
});

test("dispatch ignores ports that are not in the mapping match list", () => {
  assert.deepEqual(
    dispatchMidiMessage(MIDI_PRESETS[0], { port: "Launchpad Mini", bytes: [0x90, 0, 127] }, layers),
    [],
  );
});

test("Shift hold plus the low knob becomes that deck's filter", () => {
  const press = parseMidiBytes([0x9e, 0, 127])!;
  const release = parseMidiBytes([0x8e, 0, 0])!;
  const low = parseMidiBytes([0xb0, 26, 127])!;
  assert.deepEqual(resolveMidiActions(reloopBuddy, press, layers), [{ type: "shiftHold", held: true }]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, release, layers), [{ type: "shiftHold", held: false }]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, low, layers), [{ type: "eqLow", deck: 0, value: 1 }]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, low, { ...layers, shift: true }), [
    { type: "filter", deck: 0, value: 1 },
  ]);
});

test("crossfader enable is a master toggle that mappings can bind", () => {
  const mapping = {
    name: "Test",
    match: { portContains: ["Test"] },
    bindings: [
      { kind: "note" as const, channel: 14, data: 8, actions: [{ type: "toggleCrossfader" as const }] },
    ],
    outputs: [
      { kind: "note" as const, channel: 14, data: 8, from: "crossfaderEnabled" as const },
    ],
  };
  const press = parseMidiBytes([0x9e, 8, 127])!;
  assert.deepEqual(resolveMidiActions(mapping, press, layers), [{ type: "toggleCrossfader" }]);
  const on = collectMidiOutputs(mapping, {
    playing: [false, false],
    pausedLoaded: [false, false],
    syncing: [false, false],
    looping: [false, false],
    pfl: [false, false],
    crossfaderEnabled: true,
  });
  const off = collectMidiOutputs(mapping, {
    playing: [false, false],
    pausedLoaded: [false, false],
    syncing: [false, false],
    looping: [false, false],
    pfl: [false, false],
    crossfaderEnabled: false,
  });
  assert.equal(on[0]?.value, 127);
  assert.equal(off[0]?.value, 0);
});

test("Shift hold plus the high knob becomes that deck's gain", () => {
  const high = parseMidiBytes([0xb0, 23, 127])!;
  assert.deepEqual(resolveMidiActions(reloopBuddy, high, layers), [{ type: "eqHigh", deck: 0, value: 1 }]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, high, { ...layers, shift: true }), [
    { type: "gain", deck: 0, value: 1 },
  ]);
});

test("hardware Shift layer CCs map high to gain and low to filter", () => {
  const gain = parseMidiBytes([0xb0, 55, 127])!;
  const filter = parseMidiBytes([0xb0, 58, 0])!;
  assert.deepEqual(resolveMidiActions(reloopBuddy, gain, layers), [{ type: "gain", deck: 0, value: 1 }]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, filter, layers), [{ type: "filter", deck: 0, value: -1 }]);
});

test("Buddy tempo uses 10-bit max 1023 with LSB 63 and invert", () => {
  const bits = new MidiFourteenBit();
  const top = resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 9, 0])!, layers, bits);
  assert.equal(top[0]?.type, "tempo");
  if (top[0]?.type === "tempo") {
    assert.ok(Math.abs(top[0].value - 1) < 0.02, `top should be 1, got ${top[0].value}`);
    assert.ok(Math.abs(scaleUnitToRange(top[0].value, 0.9, 1.1) - 0.9) < 0.005);
  }
  resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 9, 7])!, layers, bits);
  const bottom = resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 63, 127])!, layers, bits);
  assert.equal(bottom[0]?.type, "tempo");
  if (bottom[0]?.type === "tempo") {
    assert.ok(Math.abs(bottom[0].value) < 0.02, `bottom should be 0, got ${bottom[0].value}`);
    assert.ok(Math.abs(scaleUnitToRange(bottom[0].value, 0.9, 1.1) - 1.1) < 0.005);
  }
  resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 9, 4])!, layers, bits);
  const center = resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 63, 0])!, layers, bits);
  assert.equal(center[0]?.type, "tempo");
  if (center[0]?.type === "tempo") {
    assert.ok(Math.abs(center[0].value - 0.5) < 0.03, `center should be ~0.5, got ${center[0].value}`);
    assert.equal(scaleUnitToRange(center[0].value, 0.9, 1.1), 1);
  }
});

test("browse encoder defaults to Pioneer polarity so clockwise steps down the list", () => {
  const cw = parseMidiBytes([0xbe, 0, 1])!;
  const ccw = parseMidiBytes([0xbe, 0, 127])!;
  assert.equal(midiBindingInverts(reloopBuddy.bindings.find((binding) => binding.actions[0]?.type === "browseStep")!, "browseStep"), false);
  assert.deepEqual(resolveMidiActions(reloopBuddy, cw, layers), [{ type: "browseStep", delta: 1 }]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, ccw, layers), [{ type: "browseStep", delta: -1 }]);
});

test("browseStep invert is off by default and actually reverses clockwise", () => {
  const mapping: MidiMapping = {
    name: "x",
    match: { portContains: ["x"] },
    bindings: [{ kind: "cc", channel: 0, data: 0, actions: [{ type: "browseStep" }] }],
  };
  const cw = parseMidiBytes([0xb0, 0, 1])!;
  assert.deepEqual(resolveMidiActions(mapping, cw, layers), [{ type: "browseStep", delta: 1 }]);
  mapping.bindings[0] = { ...mapping.bindings[0], invert: true };
  assert.deepEqual(resolveMidiActions(mapping, cw, layers), [{ type: "browseStep", delta: -1 }]);
});

test("jog wheel carries touch separately, preserves edge nudge, and gives Shift priority to seek", () => {
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 6, 1])!, layers), [
    { type: "jog", deck: 0, delta: 1 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 6, 65])!, layers), [
    { type: "jog", deck: 0, delta: -63 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 6, 64])!, layers), [
    { type: "jog", deck: 0, delta: -64 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x90, 6, 127])!, layers), [
    { type: "jogTouch", deck: 0, held: true },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x80, 6, 0])!, layers), [
    { type: "jogTouch", deck: 0, held: false },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0xb1, 6, 127])!, layers), [
    { type: "jog", deck: 1, delta: -1 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x91, 6, 127])!, layers), [
    { type: "jogTouch", deck: 1, held: true },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x81, 6, 0])!, layers), [
    { type: "jogTouch", deck: 1, held: false },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 6, 1])!, { ...layers, shift: true }), [
    { type: "jogSeek", deck: 0, delta: 1 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0xb0, 43, 127])!, layers), [
    { type: "jogSeek", deck: 0, delta: -1 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x9e, 6, 127])!, layers), [
    { type: "browsePress" },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x9e, 2, 127])!, layers), [
    { type: "loadSelected", deck: 0 },
  ]);
  assert.deepEqual(resolveMidiActions(reloopBuddy, parseMidiBytes([0x9e, 3, 127])!, layers), [
    { type: "loadSelected", deck: 1 },
  ]);
});
