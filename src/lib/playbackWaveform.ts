import { invoke } from "@tauri-apps/api/core";
import type { Waveform } from "../types";
import {
  DETAIL_WAVEFORM_COLUMNS_PER_SECOND,
  MANAGER_WAVEFORM_SECONDS_PER_SCREEN,
  waveformSourceRange,
} from "./waveformViewport";

const WINDOW_WIRE_MAGIC = [
  0x4b, 0x44, 0x4a, 0x57, 0x49, 0x4e, 0x00, 0x00,
] as const; // KDJWIN\0\0
const WINDOW_WIRE_VERSION = 1;
const WINDOW_WIRE_HEADER_BYTES = 48;
// Two f32 contour values plus four u8 evidence channels. Keeping f32 here is intentional: unlike
// the full-track disk/HTTP cache, the live Manager lane promises bit-for-bit contour precision.
const WINDOW_WIRE_BYTES_PER_COLUMN = 12;
const MAX_WINDOW_COLUMNS = 10_000;
const NATIVE_LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
const ATLAS_CHUNK_COLUMNS = 1_024;
const GRID_ROUNDING_EPSILON = 1e-7;

interface PlaybackWaveformAtlasChunk {
  known: Uint8Array;
  amp: Float32Array;
  minimum: Float32Array;
  maximum: Float32Array;
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  transient: Uint8Array;
}

/**
 * Sparse session cache for the Manager's already-approved source-time columns.
 *
 * The native scratch owner deliberately keeps only a bounded PCM window. This atlas retains just
 * the analysed columns that have reached the frontend, in fixed-size typed chunks, so revisiting a
 * loop/seek does not let a differently normalised scratch window repaint the same sound.
 */
export interface PlaybackWaveformAtlas {
  readonly trackId: number;
  duration: number;
  readonly chunks: Map<number, PlaybackWaveformAtlasChunk>;
}

export function createPlaybackWaveformAtlas(
  trackId: number,
): PlaybackWaveformAtlas {
  return {
    trackId,
    duration: 0,
    chunks: new Map(),
  };
}

/**
 * Decide whether the next bounded Manager request is allowed to preempt whole-track work.
 *
 * A missing first paint and a real transport discontinuity are urgent. Ordinary playback merely
 * reaching the edge of an existing window is not a discontinuity: treating it as one repeatedly
 * cancelled and restarted the visible whole-track preview while the playhead advanced.
 */
export function playbackWaveformRequestIsUrgent(
  hasPublishedWindow: boolean,
  initialPaintPending: boolean,
  discontinuityPending: boolean,
): boolean {
  return !hasPublishedWindow || initialPaintPending || discontinuityPending;
}

export interface PlaybackWaveformTransportActivity {
  trackId: number | null;
  playing: boolean;
  scratchHeld: boolean;
  audibleRate: number;
}

/** Whole-track detail is a seek accelerator and may start only while its owning Deck is parked. */
export function playbackWaveformMayPrefetchFullDetail(
  trackId: number,
  transport: PlaybackWaveformTransportActivity | null,
): boolean {
  if (!transport || transport.trackId !== trackId) return true;
  return !transport.playing
    && !transport.scratchHeld
    && Number.isFinite(transport.audibleRate)
    && Math.abs(transport.audibleRate) <= 0.02;
}

/** Missing first paint upgrades whole-track work from optional prefetch to required fallback. */
export function playbackWaveformShouldLoadFullDetail(
  visibleWindowReady: boolean,
  trackId: number,
  transport: PlaybackWaveformTransportActivity | null,
): boolean {
  return !visibleWindowReady || playbackWaveformMayPrefetchFullDetail(trackId, transport);
}

/**
 * Place a wide urgent local request in the direction of travel without dropping either visible
 * side. Near a song boundary the centre shifts inward so the bounded decoder fills the complete
 * requested span instead of wasting half of it before zero or after the duration.
 */
export function playbackWaveformRequestCenter(
  positionSeconds: number,
  durationSeconds: number,
  visibleSeconds: number,
  requestSeconds: number,
  audibleRate: number,
): number {
  const duration = Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds)
    : 0;
  if (duration <= 0) return 0;
  const position = Number.isFinite(positionSeconds)
    ? Math.max(0, Math.min(duration, positionSeconds))
    : 0;
  const visible = Number.isFinite(visibleSeconds)
    ? Math.max(0, visibleSeconds)
    : 0;
  const request = Number.isFinite(requestSeconds)
    ? Math.max(visible, requestSeconds)
    : visible;
  if (request >= duration) return duration * 0.5;

  const halfRequest = request * 0.5;
  const directionalSpare = Math.max(0, (request - visible) * 0.5);
  const direction =
    Number.isFinite(audibleRate) && Math.abs(audibleRate) > 0.02
      ? Math.sign(audibleRate)
      : 0;
  const desired = position + direction * directionalSpare;
  return Math.max(halfRequest, Math.min(duration - halfRequest, desired));
}

function atlasChunk(
  atlas: PlaybackWaveformAtlas,
  absoluteColumn: number,
  create: boolean,
): PlaybackWaveformAtlasChunk | null {
  const chunkIndex = Math.floor(absoluteColumn / ATLAS_CHUNK_COLUMNS);
  const existing = atlas.chunks.get(chunkIndex);
  if (existing || !create) return existing ?? null;
  const chunk: PlaybackWaveformAtlasChunk = {
    known: new Uint8Array(ATLAS_CHUNK_COLUMNS),
    amp: new Float32Array(ATLAS_CHUNK_COLUMNS),
    minimum: new Float32Array(ATLAS_CHUNK_COLUMNS),
    maximum: new Float32Array(ATLAS_CHUNK_COLUMNS),
    r: new Uint8Array(ATLAS_CHUNK_COLUMNS),
    g: new Uint8Array(ATLAS_CHUNK_COLUMNS),
    b: new Uint8Array(ATLAS_CHUNK_COLUMNS),
    transient: new Uint8Array(ATLAS_CHUNK_COLUMNS),
  };
  atlas.chunks.set(chunkIndex, chunk);
  return chunk;
}

function atlasChunkOffset(absoluteColumn: number): number {
  return absoluteColumn % ATLAS_CHUNK_COLUMNS;
}

/**
 * Freeze a native scratch window onto the song's absolute 400-column/s lattice.
 *
 * Native FFT/contrast analysis uses the PCM that is locally available at request time. A later
 * rolling window can therefore assign a different height or colour to its overlap. The first
 * approved value for each absolute column wins here; later windows may fill unknown/future cells
 * but can never rewrite a pixel that the listener has already seen.
 */
export function stabilizePlaybackWaveformWindow(
  atlas: PlaybackWaveformAtlas,
  next: Waveform,
): Waveform {
  if (atlas.trackId !== next.track_id) {
    throw new Error("局部波形缓存与歌曲不匹配");
  }
  const [incomingStart, incomingEnd] = waveformSourceRange(next);
  const sourceCount = next.amp.length;
  const hasContour =
    next.minimum?.length === sourceCount &&
    next.maximum?.length === sourceCount &&
    next.transient?.length === sourceCount;
  if (sourceCount === 0 || incomingEnd <= incomingStart || !hasContour)
    return next;

  // Keep only complete global cells. At most 2.5 ms is trimmed from either PCM edge, and the
  // coverage predicate explicitly allows that single lattice step.
  const firstColumn = Math.max(
    0,
    Math.ceil(
      incomingStart * DETAIL_WAVEFORM_COLUMNS_PER_SECOND -
        GRID_ROUNDING_EPSILON,
    ),
  );
  const lastColumn = Math.max(
    firstColumn,
    Math.floor(
      incomingEnd * DETAIL_WAVEFORM_COLUMNS_PER_SECOND + GRID_ROUNDING_EPSILON,
    ),
  );
  const count = lastColumn - firstColumn;
  if (count <= 0) return next;

  atlas.duration = Math.max(atlas.duration, next.duration, incomingEnd);
  const amp = new Float32Array(count);
  const minimum = new Float32Array(count);
  const maximum = new Float32Array(count);
  const r = new Uint8Array(count);
  const g = new Uint8Array(count);
  const b = new Uint8Array(count);
  const transient = new Uint8Array(count);
  const known = new Uint8Array(count);
  const incomingSpan = incomingEnd - incomingStart;

  for (let output = 0; output < count; output += 1) {
    const absoluteColumn = firstColumn + output;
    const offset = atlasChunkOffset(absoluteColumn);
    let chunk = atlasChunk(atlas, absoluteColumn, false);
    if (!chunk?.known[offset]) {
      const centerSeconds =
        (absoluteColumn + 0.5) / DETAIL_WAVEFORM_COLUMNS_PER_SECOND;
      const source = Math.min(
        sourceCount - 1,
        Math.max(
          0,
          Math.floor(
            ((centerSeconds - incomingStart) / incomingSpan) * sourceCount,
          ),
        ),
      );
      if (!next.known || next.known[source]) {
        chunk = atlasChunk(atlas, absoluteColumn, true);
        if (chunk) {
          chunk.amp[offset] = next.amp[source] ?? 0;
          chunk.minimum[offset] =
            next.minimum?.[source] ?? -(next.amp[source] ?? 0);
          chunk.maximum[offset] =
            next.maximum?.[source] ?? next.amp[source] ?? 0;
          chunk.r[offset] = next.r[source] ?? 0;
          chunk.g[offset] = next.g[source] ?? 0;
          chunk.b[offset] = next.b[source] ?? 0;
          chunk.transient[offset] = next.transient?.[source] ?? 0;
          chunk.known[offset] = 1;
        }
      }
    }
    if (!chunk?.known[offset]) continue;
    amp[output] = chunk.amp[offset];
    minimum[output] = chunk.minimum[offset];
    maximum[output] = chunk.maximum[offset];
    r[output] = chunk.r[offset];
    g[output] = chunk.g[offset];
    b[output] = chunk.b[offset];
    transient[output] = chunk.transient[offset];
    known[output] = 1;
  }

  return {
    track_id: next.track_id,
    duration: atlas.duration,
    source_start: firstColumn / DETAIL_WAVEFORM_COLUMNS_PER_SECOND,
    source_end: lastColumn / DETAIL_WAVEFORM_COLUMNS_PER_SECOND,
    amp,
    minimum,
    maximum,
    r,
    g,
    b,
    transient,
    known,
  };
}

/**
 * Read a sparse bounded window back from already-approved session columns.
 *
 * This gives online tracks instant revisits to places the active playback stream has already
 * exposed. Unknown columns stay explicitly blank, so the hook keeps polling the one transport
 * stream for new PCM instead of mistaking a sparse atlas window for complete coverage.
 */
export function playbackWaveformAtlasWindow(
  atlas: PlaybackWaveformAtlas,
  centerSeconds: number,
  windowSeconds: number,
): Waveform | null {
  const range = playbackWaveformAtlasColumnRange(
    atlas,
    centerSeconds,
    windowSeconds,
  );
  return range
    ? playbackWaveformAtlasColumnWindow(atlas, range[0], range[1])
    : null;
}

function playbackWaveformAtlasColumnRange(
  atlas: PlaybackWaveformAtlas,
  centerSeconds: number,
  windowSeconds: number,
): [number, number] | null {
  const duration = Number.isFinite(atlas.duration)
    ? Math.max(0, atlas.duration)
    : 0;
  if (duration <= 0 || atlas.chunks.size === 0) return null;
  const center = Math.max(0, Math.min(duration, centerSeconds));
  const half = Math.max(0, windowSeconds) * 0.5;
  const startSeconds = Math.max(0, center - half);
  const endSeconds = Math.min(duration, center + half);
  const firstColumn = Math.max(
    0,
    Math.floor(
      startSeconds * DETAIL_WAVEFORM_COLUMNS_PER_SECOND + GRID_ROUNDING_EPSILON,
    ),
  );
  const finalSongColumn = Math.max(
    1,
    Math.floor(
      duration * DETAIL_WAVEFORM_COLUMNS_PER_SECOND + GRID_ROUNDING_EPSILON,
    ),
  );
  const lastColumn = Math.min(
    finalSongColumn,
    Math.max(
      firstColumn + 1,
      Math.ceil(endSeconds * DETAIL_WAVEFORM_COLUMNS_PER_SECOND),
    ),
  );
  const count = lastColumn - firstColumn;
  if (count <= 0) return null;

  return [firstColumn, lastColumn];
}

function playbackWaveformAtlasColumnWindow(
  atlas: PlaybackWaveformAtlas,
  firstColumn: number,
  lastColumn: number,
): Waveform | null {
  const count = lastColumn - firstColumn;
  if (count <= 0) return null;

  const amp = new Float32Array(count);
  const minimum = new Float32Array(count);
  const maximum = new Float32Array(count);
  const r = new Uint8Array(count);
  const g = new Uint8Array(count);
  const b = new Uint8Array(count);
  const transient = new Uint8Array(count);
  const known = new Uint8Array(count);
  let knownCount = 0;
  for (let output = 0; output < count; output += 1) {
    const absoluteColumn = firstColumn + output;
    const chunk = atlasChunk(atlas, absoluteColumn, false);
    const offset = atlasChunkOffset(absoluteColumn);
    if (!chunk?.known[offset]) continue;
    amp[output] = chunk.amp[offset];
    minimum[output] = chunk.minimum[offset];
    maximum[output] = chunk.maximum[offset];
    r[output] = chunk.r[offset];
    g[output] = chunk.g[offset];
    b[output] = chunk.b[offset];
    transient[output] = chunk.transient[offset];
    known[output] = 1;
    knownCount += 1;
  }
  if (knownCount === 0) return null;

  return {
    track_id: atlas.trackId,
    duration: atlas.duration,
    source_start: firstColumn / DETAIL_WAVEFORM_COLUMNS_PER_SECOND,
    source_end: lastColumn / DETAIL_WAVEFORM_COLUMNS_PER_SECOND,
    amp,
    minimum,
    maximum,
    r,
    g,
    b,
    transient,
    known,
  };
}

/**
 * Read only the continuous approved atlas run that owns the required visible interval.
 *
 * The session atlas is intentionally sparse: a dropped optional observer batch or a seek can leave
 * an unknown interval between two already-visited islands. Publishing the full sparse span makes
 * that internal hole scroll through the Manager rail and then appear to recover when the later
 * island arrives. Keep sparse lookup available above for diagnostics/revisits, but presentation
 * must stop at the first unknown cell on either side of the currently complete viewport.
 */
export function playbackWaveformContiguousAtlasWindow(
  atlas: PlaybackWaveformAtlas,
  centerSeconds: number,
  windowSeconds: number,
  requiredCenterSeconds: number,
  requiredWindowSeconds: number,
): Waveform | null {
  const candidate = playbackWaveformAtlasColumnRange(
    atlas,
    centerSeconds,
    windowSeconds,
  );
  const required = playbackWaveformAtlasColumnRange(
    atlas,
    requiredCenterSeconds,
    requiredWindowSeconds,
  );
  if (!candidate || !required) return null;
  if (required[0] < candidate[0] || required[1] > candidate[1]) return null;

  // Build the same bounded typed-array payload as the old sparse presentation path, then expose a
  // zero-copy view of its continuous run. The extra check walks only one byte per column; contour
  // and colour channels are neither rebuilt nor copied a second time.
  const sparse = playbackWaveformAtlasColumnWindow(atlas, candidate[0], candidate[1]);
  const known = sparse?.known as Uint8Array | undefined;
  if (!sparse || !known) return null;
  const requiredFirst = required[0] - candidate[0];
  const requiredLast = required[1] - candidate[0];
  for (let column = requiredFirst; column < requiredLast; column += 1) {
    if (!known[column]) return null;
  }

  let first = requiredFirst;
  while (first > 0 && known[first - 1]) {
    first -= 1;
  }
  let last = requiredLast;
  while (last < known.length && known[last]) {
    last += 1;
  }
  if (first === 0 && last === known.length) return sparse;

  const firstColumn = candidate[0] + first;
  const lastColumn = candidate[0] + last;
  return {
    track_id: sparse.track_id,
    duration: sparse.duration,
    source_start: firstColumn / DETAIL_WAVEFORM_COLUMNS_PER_SECOND,
    source_end: lastColumn / DETAIL_WAVEFORM_COLUMNS_PER_SECOND,
    amp: (sparse.amp as Float32Array).subarray(first, last),
    minimum: (sparse.minimum as Float32Array).subarray(first, last),
    maximum: (sparse.maximum as Float32Array).subarray(first, last),
    r: (sparse.r as Uint8Array).subarray(first, last),
    g: (sparse.g as Uint8Array).subarray(first, last),
    b: (sparse.b as Uint8Array).subarray(first, last),
    transient: (sparse.transient as Uint8Array).subarray(first, last),
    known: known.subarray(first, last),
  };
}

export function supportsPlaybackWaveformWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.__TAURI_INTERNALS__) &&
    window.kdj?.platform !== "ios"
  );
}

function validWaveformWindow(
  value: Waveform | null,
  trackId: number,
): value is Waveform {
  if (!value || value.track_id !== trackId || value.amp.length === 0)
    return false;
  const [start, end] = waveformSourceRange(value);
  const count = value.amp.length;
  return (
    end > start &&
    value.r.length === count &&
    value.g.length === count &&
    value.b.length === count &&
    // The bounded rail must never fall back to the old symmetric chunky renderer. Reject an
    // incomplete payload and quietly retry instead of relabelling it as approved detail.
    value.minimum?.length === count &&
    value.maximum?.length === count &&
    value.transient?.length === count
  );
}

function exactArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

/**
 * Decode the Manager-only bounded waveform wire.
 *
 * This is deliberately separate from the full-track HTTP waveform format: source_start and
 * source_end are part of the payload, so a twelve-second PCM asset can never be stretched across
 * the whole song by mistake. Keeping the seven evidence channels in typed arrays also avoids
 * constructing tens of thousands of short-lived JavaScript Number objects during playback.
 */
export function decodePlaybackWaveformWindow(
  input: ArrayBuffer | Uint8Array,
  expectedTrackId: number,
): Waveform | null {
  const payload = exactArrayBuffer(input);
  if (payload.byteLength === 0) return null;
  if (payload.byteLength < WINDOW_WIRE_HEADER_BYTES) {
    throw new Error("局部波形二进制响应不完整");
  }
  const bytes = new Uint8Array(payload);
  for (let index = 0; index < WINDOW_WIRE_MAGIC.length; index += 1) {
    if (bytes[index] !== WINDOW_WIRE_MAGIC[index]) {
      throw new Error("局部波形二进制魔数不匹配");
    }
  }
  const view = new DataView(payload);
  const version = view.getUint16(8, true);
  const flags = view.getUint16(10, true);
  if (version !== WINDOW_WIRE_VERSION || flags !== 0) {
    throw new Error(`不支持的局部波形版本：${version}/${flags}`);
  }
  const trackIdBigInt = view.getBigInt64(12, true);
  if (
    trackIdBigInt < BigInt(Number.MIN_SAFE_INTEGER) ||
    trackIdBigInt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("局部波形 track id 超出 JavaScript 安全整数范围");
  }
  const trackId = Number(trackIdBigInt);
  const duration = view.getFloat64(20, true);
  const sourceStart = view.getFloat64(28, true);
  const sourceEnd = view.getFloat64(36, true);
  const columns = view.getUint32(44, true);
  const expectedBytes =
    WINDOW_WIRE_HEADER_BYTES + columns * WINDOW_WIRE_BYTES_PER_COLUMN;
  if (
    trackId !== expectedTrackId ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isFinite(sourceStart) ||
    !Number.isFinite(sourceEnd) ||
    sourceStart < 0 ||
    sourceEnd <= sourceStart ||
    sourceEnd > duration + 1e-3 ||
    columns === 0 ||
    columns > MAX_WINDOW_COLUMNS ||
    payload.byteLength !== expectedBytes
  ) {
    throw new Error("局部波形二进制元数据无效");
  }

  let offset = WINDOW_WIRE_HEADER_BYTES;
  const decodeContour = (byteOffset: number): Float32Array => {
    if (NATIVE_LITTLE_ENDIAN) {
      return new Float32Array(payload, byteOffset, columns);
    }
    return Float32Array.from({ length: columns }, (_, index) =>
      view.getFloat32(byteOffset + index * 4, true),
    );
  };
  const minimum = decodeContour(offset);
  offset += columns * 4;
  const maximum = decodeContour(offset);
  offset += columns * 4;
  const amp = Float32Array.from({ length: columns }, (_, index) =>
    Math.min(1, Math.max(0, maximum[index] ?? 0, -(minimum[index] ?? 0))),
  );
  const r = bytes.subarray(offset, offset + columns);
  offset += columns;
  const g = bytes.subarray(offset, offset + columns);
  offset += columns;
  const b = bytes.subarray(offset, offset + columns);
  offset += columns;
  const transient = bytes.subarray(offset, offset + columns);
  return {
    track_id: trackId,
    duration,
    source_start: sourceStart,
    source_end: sourceEnd,
    amp,
    minimum,
    maximum,
    r,
    g,
    b,
    transient,
  };
}

/** Ask the native playback owner for a bounded detail asset; `null` means retry later. */
export async function requestPlaybackWaveformWindow(
  trackId: number,
  positionSeconds: number,
  viewportSeconds = MANAGER_WAVEFORM_SECONDS_PER_SCREEN,
  urgent = true,
): Promise<Waveform | null> {
  if (!supportsPlaybackWaveformWindow()) return null;
  const payload = await invoke<ArrayBuffer | Uint8Array>(
    "playback_waveform_window",
    {
      trackId,
      position: positionSeconds,
      viewportSeconds,
      urgent,
    },
  );
  const waveform = decodePlaybackWaveformWindow(payload, trackId);
  return validWaveformWindow(waveform, trackId) ? waveform : null;
}
