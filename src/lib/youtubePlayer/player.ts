/**
 * KDJ's narrow YouTube player-script extractor.
 *
 * The AST extraction machinery is adapted from YouTube.js 17.2.0 under MIT, but this wrapper
 * deliberately omits its general InnerTube client, parser registry, protobufs, OAuth and cache.
 * Extracted transforms execute only in KDJ's dedicated native, isolated YouTube-origin WebView.
 */
import { JsAnalyzer } from "./JsAnalyzer";
import { JsExtractor } from "./JsExtractor";
import { nsigMatcher, timestampMatcher } from "./matchers";

interface PlayerProgram {
  output: string;
  exported: string[];
  exportedRawValues?: Record<string, unknown>;
}

function nsigProcessor(n?: string | null, sp?: string | null, s?: string | null): string {
  return [
    "function process(n = '', sp = '', s = '') {",
    "  const mockStreamingURL = 'https://ytjs.googlevideo.com/videoplayback?expire=1234567890&n=' + encodeURIComponent(n);",
    "  const urlCtorFunction = exportedVars.nsigFunction || (() => { throw new Error('No n/sig decipher function extracted'); });",
    "  const urlCtor = urlCtorFunction(mockStreamingURL, sp, s);",
    "  const proto = Object.getPrototypeOf(urlCtor);",
    "  const methodBlacklist = ['constructor', 'clone', 'set', 'get'];",
    "  for (const prop of Object.getOwnPropertyNames(proto)) {",
    "    if (!methodBlacklist.includes(prop) && typeof urlCtor[prop] === 'function') urlCtor[prop]();",
    "  }",
    "  const sigResult = urlCtor.get(sp);",
    "  const nResult = urlCtor.get('n');",
    "  return { sig: sigResult ? decodeURIComponent(sigResult) : undefined, n: nResult ? decodeURIComponent(nResult) : undefined };",
    "}",
    "return process(" + JSON.stringify(n ?? "") + ", " + JSON.stringify(sp ?? "") + ", " + JSON.stringify(s ?? "") + ");",
  ].join("\n");
}

/** This function must only run inside the dedicated, opaque-origin YouTube proof sandbox. */
function evaluate(program: PlayerProgram, args: Record<string, string | undefined>): unknown {
  const names = Object.keys(args);
  const values = Object.values(args);
  return new Function(...names, program.output + "\n" + nsigProcessor(args.n, args.sp, args.sig))(
    ...values,
  );
}

function assertTrustedMediaUrl(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "googlevideo.com" && !host.endsWith(".googlevideo.com"))) {
    throw new Error("YouTube 媒体地址不受信任");
  }
}

export class LightweightYoutubePlayer {
  private constructor(
    readonly signatureTimestamp: number,
    private readonly program: PlayerProgram,
    private readonly hasTransform: boolean,
  ) {}

  static create(javascript: string): LightweightYoutubePlayer {
    const nsigFunctionName = "nsigFunction";
    const timestampVarName = "signatureTimestampVar";
    const analyzer = new JsAnalyzer(javascript, {
      extractions: [
        { friendlyName: nsigFunctionName, match: nsigMatcher },
        { friendlyName: timestampVarName, match: timestampMatcher, collectDependencies: false },
      ],
    });
    const result = new JsExtractor(analyzer).buildScript({
      disallowSideEffectInitializers: true,
      exportRawValues: true,
      rawValueOnly: [timestampVarName],
    }) as PlayerProgram;
    const hasTransform = result.exported.includes(nsigFunctionName);
    const signatureTimestamp = Number(result.exportedRawValues?.[timestampVarName] ?? 0);
    if (!Number.isSafeInteger(signatureTimestamp) || signatureTimestamp <= 0) {
      throw new Error("YouTube 播放器签名时间戳无效");
    }
    return new LightweightYoutubePlayer(signatureTimestamp, result, hasTransform);
  }

  decipher(signatureCipher: string): string {
    const args = new URLSearchParams(signatureCipher);
    const url = new URL(args.get("url") || signatureCipher);
    assertTrustedMediaUrl(url);
    const n = url.searchParams.get("n");
    const s = args.get("s");
    const sp = args.get("sp") || "signature";
    if (!n && !s) return url.toString();
    if ((n || s) && !this.hasTransform) {
      throw new Error("当前 YouTube 播放器未暴露可提取的 n/sig 变换");
    }
    const transformed = evaluate(this.program, {
      n: n ?? undefined,
      sp: s ? sp : undefined,
      sig: s ?? undefined,
    });
    if (!transformed || typeof transformed !== "object") {
      throw new Error("YouTube 播放器返回了无效签名结果");
    }
    const result = transformed as { sig?: unknown; n?: unknown };
    if (s) {
      if (typeof result.sig !== "string" || !result.sig) {
        throw new Error("YouTube 播放器没有还原视频签名");
      }
      url.searchParams.set(sp, result.sig);
    }
    if (n) {
      if (typeof result.n !== "string" || !result.n) {
        throw new Error("YouTube 播放器没有还原 n 参数");
      }
      url.searchParams.set("n", result.n);
    }
    return url.toString();
  }

  transformN(value: string): string {
    if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("YouTube HLS n challenge 无效");
    }
    if (!this.hasTransform) {
      throw new Error("当前 YouTube 播放器未暴露可提取的 n 变换");
    }
    const transformed = evaluate(this.program, { n: value });
    const result = transformed as { n?: unknown } | null;
    if (!result || typeof result.n !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(result.n)) {
      throw new Error("YouTube 播放器没有还原 HLS n challenge");
    }
    return result.n;
  }
}
