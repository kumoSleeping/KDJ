/**
 * H.264 marked above level 5.2, asked of the system decoder as 5.2.
 *
 * WebKit's WebCodecs on macOS answers "not supported" for `avc1.xxxx3C`–`3E` (levels 6–6.2) and
 * fails to create a decoder for them, while VideoToolbox decodes the very same stream once it is
 * asked for 5.2: a level only raises limits, and many encoders mark ordinary 1080p with 6.2. Such
 * a library video was refused by the codec picture and fell back to a `<video>` that stuck
 * seeking (black window; track 8981, a 1080p30 file at 6.2, 2026-11-04). The stream is not
 * touched — the decoder reads the level from its own SPS — only the codec string the decoder is
 * configured and checked with.
 */
const HIGHEST = 0x34;

/** `codec` with an H.264 level above 5.2 lowered to 5.2; anything else as it is. */
export function decodableCodec(codec: string): string {
  const found = /^(avc[13])\.([0-9a-f]{4})([0-9a-f]{2})$/i.exec(codec);
  if (!found || parseInt(found[3], 16) <= HIGHEST) return codec;
  return `${found[1]}.${found[2]}${HIGHEST.toString(16)}`;
}

type Decoder = typeof VideoDecoder & { kdjAvcLevel?: true };

/** Every VideoDecoder of this window or worker checked and configured through `decodableCodec`. */
export function installAvcLevel(): void {
  if (typeof VideoDecoder === "undefined") return;
  const decoder = VideoDecoder as Decoder;
  if (decoder.kdjAvcLevel) return;
  decoder.kdjAvcLevel = true;
  const supported = decoder.isConfigSupported.bind(decoder);
  decoder.isConfigSupported = config => supported({ ...config, codec: decodableCodec(config.codec) });
  const configure = decoder.prototype.configure;
  decoder.prototype.configure = function (this: VideoDecoder, config: VideoDecoderConfig) {
    configure.call(this, { ...config, codec: decodableCodec(config.codec) });
  };
}
