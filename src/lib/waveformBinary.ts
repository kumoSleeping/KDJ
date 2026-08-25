import type { Waveform } from "../types";

/** Stable HTTP media type for the compact waveform wire format. */
export const WAVEFORM_BINARY_MIME = "application/vnd.kdj.waveform";
export type WaveformProfile = "current" | "release-overview";

const WIRE_MAGIC = [0x4b, 0x44, 0x4a, 0x57, 0x56, 0x46, 0x4d, 0x00] as const; // KDJWVFM\0
const WIRE_VERSION = 1;
const WIRE_HEADER_BYTES = 36;
const WIRE_BYTES_PER_COLUMN = 7;
const MAX_WIRE_COLUMNS = 100_000;
const NATIVE_LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

const PROFILE_CONTRACT: Record<WaveformProfile, { code: number; revision: number }> = {
  current: { code: 1, revision: 6 },
  "release-overview": { code: 2, revision: 5 },
};

export function isWaveformBinaryContentType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === WAVEFORM_BINARY_MIME;
}

/**
 * Decode the server's little-endian waveform wire v1.
 *
 * The header includes the algorithm profile and revision, so a current-band detail response can
 * never silently enter the historical release-overview cache (or vice versa). Length and channel
 * counts are validated before allocating any JS arrays.
 */
export function decodeWaveformBinary(
  payload: ArrayBuffer,
  expectedProfile: WaveformProfile,
): Waveform {
  if (payload.byteLength < WIRE_HEADER_BYTES) {
    throw new Error("波形二进制响应不完整");
  }
  const bytes = new Uint8Array(payload);
  for (let index = 0; index < WIRE_MAGIC.length; index += 1) {
    if (bytes[index] !== WIRE_MAGIC[index]) throw new Error("波形二进制魔数不匹配");
  }

  const view = new DataView(payload);
  const version = view.getUint16(8, true);
  if (version !== WIRE_VERSION) throw new Error(`不支持的波形二进制版本：${version}`);
  if (view.getUint8(11) !== 0) throw new Error("波形二进制包含未知 flags");

  const contract = PROFILE_CONTRACT[expectedProfile];
  const profile = view.getUint8(10);
  const revision = view.getUint32(12, true);
  if (profile !== contract.code || revision !== contract.revision) {
    throw new Error(
      `波形 profile 不匹配：收到 ${profile}/r${revision}，需要 ${contract.code}/r${contract.revision}`,
    );
  }

  const trackIdBigInt = view.getBigInt64(16, true);
  if (
    trackIdBigInt < BigInt(Number.MIN_SAFE_INTEGER)
    || trackIdBigInt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("波形 track id 超出 JavaScript 安全整数范围");
  }
  const duration = view.getFloat64(24, true);
  if (!Number.isFinite(duration) || duration < 0) throw new Error("波形时长非法");

  const columns = view.getUint32(32, true);
  if (columns === 0 || columns > MAX_WIRE_COLUMNS) {
    throw new Error(`波形列数非法：${columns}`);
  }
  const expectedBytes = WIRE_HEADER_BYTES + columns * WIRE_BYTES_PER_COLUMN;
  if (payload.byteLength !== expectedBytes) {
    throw new Error(`波形二进制长度不匹配：${payload.byteLength}/${expectedBytes}`);
  }

  let offset = WIRE_HEADER_BYTES;
  // Every supported KDJ target is little-endian. Keep typed views into the response buffer so a
  // 24k detail rail occupies its 168 KiB wire size instead of expanding into four boxed JS arrays.
  // The fallback preserves the explicit little-endian contract on a theoretical big-endian host.
  const amp = NATIVE_LITTLE_ENDIAN
    ? new Float32Array(payload, offset, columns)
    : Float32Array.from(
        { length: columns },
        (_, index) => view.getFloat32(offset + index * 4, true),
      );
  for (let index = 0; index < columns; index += 1) {
    if (!Number.isFinite(amp[index])) throw new Error(`波形第 ${index} 列振幅非法`);
  }
  offset += columns * 4;
  const r = bytes.subarray(offset, offset + columns);
  offset += columns;
  const g = bytes.subarray(offset, offset + columns);
  offset += columns;
  const b = bytes.subarray(offset, offset + columns);

  return {
    track_id: Number(trackIdBigInt),
    duration,
    amp,
    r,
    g,
    b,
  };
}
