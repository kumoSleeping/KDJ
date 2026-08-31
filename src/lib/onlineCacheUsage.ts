import type { LyricsResponse, Waveform } from "../types";

function arrayBytes(
  values: number[] | boolean[] | Float32Array | Uint8Array | undefined,
  bytesPerValue: number,
): number {
  if (!values) return 0;
  return ArrayBuffer.isView(values) ? values.byteLength : values.length * bytesPerValue;
}

/** 波形各列的实际数值载荷；不把 JS 对象头等运行时实现细节冒充为缓存数据。 */
export function waveformCacheBytes(waveform: Waveform | null | undefined): number {
  if (!waveform) return 0;
  return (
    arrayBytes(waveform.amp, 4) +
    arrayBytes(waveform.minimum, 4) +
    arrayBytes(waveform.maximum, 4) +
    arrayBytes(waveform.r, 1) +
    arrayBytes(waveform.g, 1) +
    arrayBytes(waveform.b, 1) +
    arrayBytes(waveform.transient, 1) +
    arrayBytes(waveform.known, 1)
  );
}

/** 歌词缓存只统计真正保留的四层时间轴文本，标题等展示元数据不计入。 */
export function lyricsCacheBytes(lyrics: LyricsResponse | null | undefined): number {
  if (!lyrics) return 0;
  return new TextEncoder().encode(
    [lyrics.lrc, lyrics.word_lrc, lyrics.translated_lrc, lyrics.romaji_lrc]
      .filter(Boolean)
      .join("\n"),
  ).byteLength;
}
