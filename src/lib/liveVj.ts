import { getBridge } from "./bridge";
export interface LiveVjEntry { id: string; track_id: number; path: string; title: string; duration: number; video: boolean; presentation: "video" | "lyrics-visualizer" }
export interface LiveVjSet { id: string; name: string; entries: LiveVjEntry[] }
export interface LiveVjStandby { path: string; name: string; kind: "image" | "video" }
export interface LiveVjDocument { version: number; revision: number; sets: LiveVjSet[]; standby?: LiveVjStandby | null }
export interface LiveVjMatch { entry: LiveVjEntry; position: number; observed_at_ms: number; clock_at_ms: number; rate: number; confidence: number; margin: number; rate_confidence: number; lock_revision: number }
export interface LiveVjLog {
  id: number; at_ms: number; level: "info" | "warn" | "error";
  stage: "session" | "index" | "input" | "scan" | "decision" | "output"; message: string;
}
export interface LiveVjInputDevice { id: string; label: string; channels: number; kind: "output" | "system" | "input"; resolved_id: string | null; error: string | null }
export const liveVjChannelLabel = (device: LiveVjInputDevice, start: number) => device.kind === "system" ? "L/R"
  : start + 1 === device.channels ? `CH ${start + 1}` : `CH ${start + 1}/${start + 2}`;
export interface LiveVjInput {
  state: "waiting" | "buffering" | "receiving" | "quiet" | "stalled";
  source: string; sample_rate: number;
  channels: {name: string; rms_dbfs: number; peak_dbfs: number}[];
  rms_dbfs: number | null; peak_dbfs: number | null; buffered_seconds: number;
  packet_age_ms: number | null; packets: number; gaps: number;
}
export interface LiveVjListener {
  state: "waiting" | "preparing" | "retrieving" | "verifying" | "quiet" | "interrupted" | "tracking" | "searching" | "confirming" | "locked";
  target: string | null;
  runs: number; elapsed_ms: number; query_seconds: number;
  position: number | null; rate: number | null; error_ms: number | null;
}
export interface LiveVjOutputMetrics {
  error_ms: number | null; frame_gap_ms: number; seeks: number; rate_changes: number;
  playback_rate: number; base_rate: number;
  preparation_ms: number; seek_ms: number; attempts: number;
}
export interface BluetoothDevice { id: string; name: string; paired: boolean }
export interface LiveVjBluetooth {
  state: string; peer: string | null; error: string; packets: number; bytes: number;
  rtt_ms: number | null; clock_uncertainty_ms: number | null; data_age_ms: number | null; gaps: number;
}
export interface LiveVjPeer { device: BluetoothDevice; selected: boolean; link: LiveVjBluetooth }
export interface LiveVjConnections { listening: boolean; selected: string | null; incoming: LiveVjPeer[]; outgoing: LiveVjPeer[]; error: string }
export interface LiveVjView {
  connections: LiveVjConnections; presentation_epoch: number;
  input_device: string; input_channel_start: number; send_target: string | null;
  standby: LiveVjStandby | null; projection_open: boolean; projection_error: string;
  mode: "vj" | "send" | ""; bluetooth: LiveVjBluetooth | null;
  session: string; revision: number; clock_ms: number; set_id: string; phase: string; error: string; indexed: number; total: number;
  preparing: string | null; matched: LiveVjMatch | null; candidate: LiveVjMatch | null; priority: string[]; scan: number; scan_ms: number;
  rescue: LiveVjListener | null; tracking: LiveVjListener | null;
  scanned: {entry_id: string; title: string; block_start: number; elapsed_ms: number; matched: boolean; reason: string}[];
  scanning: string | null; input: LiveVjInput | null;
  output: {entry_id: string; state: "loading" | "ready" | "visible" | "failed"; error: string; reported_at_ms: number; metrics: LiveVjOutputMetrics | null} | null;
}
export type LiveVjEdit = {kind: "create"; name: string} | {kind: "rename"; set_id: string; name: string}
  | {kind: "delete"; set_id: string} | {kind: "remove"; set_id: string; entry_id: string}
  | {kind: "move"; set_id: string; entry_id: string; before_id: string | null};
export const liveVjSupported = () => ["darwin", "win32", "linux"].includes(getBridge().platform);
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI_INTERNALS__ || !liveVjSupported()) return Promise.reject(new Error("实时 VJ 需要桌面版 KDJ"));
  return window.__TAURI_INTERNALS__.invoke<T>(command, args);
}
// Minimum-RTT IPC mapping between Rust Instant and this WebView's performance
// clock. Wall time is used only before the first status response, never for drift.
let clockOffset: number | null = null;
let bestRoundTrip = Infinity;
export const liveVjClockNow = () => clockOffset === null ? null : performance.now() + clockOffset;
export function liveVjAge(match: LiveVjMatch): number {
  const now = liveVjClockNow();
  return Math.max(0, now === null ? Date.now() - match.observed_at_ms : now - match.clock_at_ms);
}
export const liveVjApi = {
  document: () => invoke<LiveVjDocument>("live_vj_document"),
  edit: (revision: number, edit: LiveVjEdit) => invoke<LiveVjDocument>("live_vj_edit", {revision, edit}),
  import: (revision: number, setId: string, paths: string[], trackIds: number[]) => invoke<LiveVjDocument>("live_vj_import", {revision, setId, paths, trackIds}),
  pickFiles: () => invoke<string[]>("live_vj_pick_files"),
  inputs: () => invoke<LiveVjInputDevice[]>("live_vj_inputs"),
  outputs: () => invoke<{id: string; label: string}[]>("live_vj_outputs"),
  prepare: (setId: string) => invoke<LiveVjView>("live_vj_prepare", {setId}),
  start: (setId: string, input: string, output: string, channelStart: number) => invoke<LiveVjView>("live_vj_start", {setId, input, output, channelStart}),
  scanBluetooth: (inquiry = false) => invoke<BluetoothDevice[]>("live_vj_bluetooth_scan", {inquiry}),
  connectBluetooth: (device: BluetoothDevice) => invoke<void>("live_vj_bluetooth_connect", {device}),
  disconnectBluetooth: (id: string) => invoke<void>("live_vj_bluetooth_disconnect", {id}),
  selectBluetooth: (id: string | null) => invoke<void>("live_vj_bluetooth_select", {id}),
  pairBluetooth: () => invoke<void>("live_vj_bluetooth_pair"),
  standby: (revision: number, clear = false) => invoke<LiveVjDocument>("live_vj_standby", {revision, clear}),
  openProjection: (output: string) => invoke<void>("live_vj_projection_open", {output}),
  closeProjection: () => invoke<void>("live_vj_projection_close"),
  projectionError: (error: string) => invoke<void>("live_vj_projection_error", {error}),
  sendStart: (input: string, channelStart: number, peer: BluetoothDevice) => invoke<LiveVjView>("live_vj_send_start", {input, channelStart, peer}),
  stop: () => invoke<void>("live_vj_stop"),
  status: async (afterLogId?: number) => {
    const sent = performance.now();
    const result = await invoke<LiveVjView & {logs: LiveVjLog[]}>("live_vj_status", {afterLogId});
    const received = performance.now(), roundTrip = received - sent;
    if (roundTrip < bestRoundTrip) {
      bestRoundTrip = roundTrip;
      clockOffset = result.clock_ms - (sent + received) / 2;
    }
    return result;
  },
  outputStatus: (session: string, entryId: string, lockRevision: number, state: "loading" | "ready" | "visible" | "failed", error?: string,
    metrics?: LiveVjOutputMetrics) =>
    invoke<void>("live_vj_output_status", {session, entryId, lockRevision, state, error, metrics}),
};
export const liveVjRunning = (view: LiveVjView | null) => liveVjActive(view) || Boolean(view?.mode === "send" && ["permission", "connecting", "sending"].includes(view.phase));
export const liveVjBluetoothSupported = () => ["darwin", "win32"].includes(getBridge().platform);
export const liveVjActive = (view: LiveVjView | null) => Boolean(view && view.mode !== "send" && ["indexing", "permission", "listening", "matched", "searching"].includes(view.phase));
export const liveVjPosition = (match: LiveVjMatch) => Math.min(match.entry.duration, Math.max(0, match.position + liveVjAge(match) / 1000 * match.rate));
