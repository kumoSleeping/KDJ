import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MidiFeedback, MidiMapping, MidiMessage } from "./mapping";
import { collectMidiOutputs, encodeMidiOutput, mappingForPort, type MidiEchoGuard } from "./mapping";
import { MIDI_PRESETS } from "./presets";

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error(`不在 Tauri 环境里，无法调用 ${cmd}`));
  return internals.invoke<T>(cmd, args ?? {});
}

export { MIDI_PRESETS } from "./presets";

export interface MidiDevices {
  inputs: string[];
  outputs: string[];
}

export function selectMappedPort(
  devices: MidiDevices,
  mappings: readonly MidiMapping[] = MIDI_PRESETS,
): { mapping: MidiMapping; port: string } | null {
  for (const port of [...devices.inputs, ...devices.outputs]) {
    const mapping = mappingForPort(port, mappings);
    if (mapping) return { mapping, port };
  }
  return null;
}

export async function sendMidiOutputs(
  mapping: MidiMapping,
  feedback: MidiFeedback,
  previous: Map<string, number>,
  echo?: MidiEchoGuard,
): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  for (const output of collectMidiOutputs(mapping, feedback)) {
    const key = `${output.kind}:${output.channel}:${output.data}`;
    if (previous.get(key) === output.value) continue;
    previous.set(key, output.value);
    const bytes = encodeMidiOutput(output);
    echo?.recordOutput(bytes);
    try {
      await tauriInvoke<void>("midi_send", { bytes });
    } catch {
      previous.delete(key);
    }
  }
}

export function subscribeMidi(
  onDevices: (devices: MidiDevices) => void,
  onMessage: (message: MidiMessage) => void,
): () => void {
  if (!window.__TAURI_INTERNALS__) return () => undefined;
  let disposed = false;
  const unlisten: UnlistenFn[] = [];
  void (async () => {
    try {
      const devices = await tauriInvoke<MidiDevices>("midi_devices");
      if (!disposed) onDevices(devices);
    } catch {
      // MIDI 在无 CoreMIDI/WinMM 的环境里可以静默缺席。
    }
    if (disposed) return;
    unlisten.push(await listen<MidiDevices>("midi-devices", (event) => onDevices(event.payload)));
    unlisten.push(await listen<MidiMessage>("midi-message", (event) => onMessage(event.payload)));
  })();
  return () => {
    disposed = true;
    for (const stop of unlisten) stop();
  };
}
