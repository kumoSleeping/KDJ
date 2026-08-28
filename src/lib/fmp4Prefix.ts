const BOX_HEADER_BYTES = 8;

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4],
    bytes[offset + 5],
    bytes[offset + 6],
    bytes[offset + 7],
  );
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  );
}

/**
 * YouTube SABR audio is fragmented MP4. A decoder can start once one complete `moof` + `mdat`
 * pair is present; waiting for an arbitrary megabyte only turns available media into dead time.
 */
export function hasCompleteFmp4MediaSegment(bytes: Uint8Array): boolean {
  let offset = 0;
  let sawMoof = false;
  while (offset + BOX_HEADER_BYTES <= bytes.length) {
    let size = uint32(bytes, offset);
    let headerBytes = BOX_HEADER_BYTES;
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const high = uint32(bytes, offset + 8);
      const low = uint32(bytes, offset + 12);
      size = high * 0x100000000 + low;
      headerBytes = 16;
      if (!Number.isSafeInteger(size)) return false;
    } else if (size === 0) {
      // A box extending to EOF is not complete while the SABR stream is still growing.
      return false;
    }
    if (size < headerBytes || offset + size > bytes.length) return false;
    const type = boxType(bytes, offset);
    if (type === "moof") sawMoof = true;
    if (sawMoof && type === "mdat") return true;
    offset += size;
  }
  return false;
}
