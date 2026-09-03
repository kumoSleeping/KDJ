import { getBridge } from "./bridge";

export const YOUTUBE_NATIVE_PROOF_SUPPORTED = true;

/** Fixed for the isolated BotGuard realm. This must match BgUtils' challenge identity. */
export const YOUTUBE_NATIVE_PROOF_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36(KHTML, like Gecko)";

/** Fixed across the authenticated watch page and every GVS HLS request. */
export const YOUTUBE_HLS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/18.5 Safari/605.1.15";

let bundlePromise: Promise<string> | null = null;

function nativeBundleUrl(): string {
  if (import.meta.env.DEV) return "/__kdj_youtube_native_po.js";
  const urls = import.meta.glob("./youtubeNativePo.worker.ts", {
    eager: true,
    import: "default",
    query: "?worker&url",
  }) as Record<string, string>;
  const url = Object.values(urls)[0];
  if (!url) throw new Error("YouTube 原生 proof 本地代码缺失");
  return url;
}

async function nativeBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = fetch(nativeBundleUrl(), { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error("YouTube 原生 proof 本地代码加载失败");
        const bundle = await response.text();
        if (
          !bundle
          || bundle.length > 256 * 1024
          || !bundle.includes("__KDJ_YOUTUBE_NATIVE_PO__")
        ) throw new Error("YouTube 原生 proof 本地代码无效");
        return bundle;
      })
      .catch((error) => {
        bundlePromise = null;
        throw error;
      });
  }
  return bundlePromise;
}

/** The sole GVS proof path used by ordinary YouTube and YouTube Music on desktop. */
export async function mintNativeYoutubeGvsPoToken(
  binding: string,
  forceFresh = false,
): Promise<string> {
  const mint = getBridge().mintYoutubeGvsPoToken;
  if (!mint) throw new Error("当前系统没有可用的 YouTube 原生 proof 运行器");
  return mint({
    bundle: await nativeBundle(),
    binding,
    forceFresh,
    userAgent: YOUTUBE_NATIVE_PROOF_USER_AGENT,
  });
}

async function runNativeYoutubePlayer(
  operation: "config" | "decipher" | "transform_n",
  playerUrl: string,
  javascript: string,
  value = "",
): Promise<string> {
  const run = getBridge().runYoutubePlayer;
  if (!run) throw new Error("当前系统没有可用的 YouTube 原生 player 运行器");
  return run({
    bundle: await nativeBundle(),
    playerUrl,
    javascript,
    operation,
    value,
  });
}

export async function nativeYoutubePlayerConfig(
  playerUrl: string,
  javascript: string,
): Promise<{ signatureTimestamp: number }> {
  const raw = await runNativeYoutubePlayer("config", playerUrl, javascript);
  const signatureTimestamp = Number(raw);
  if (!Number.isSafeInteger(signatureTimestamp) || signatureTimestamp <= 0) {
    throw new Error("YouTube 播放器签名时间戳无效");
  }
  return { signatureTimestamp };
}

export async function decipherNativeYoutubeUrl(
  cipherOrUrl: string,
  playerUrl: string,
  javascript: string,
): Promise<string> {
  if (!cipherOrUrl || cipherOrUrl.length > 16 * 1024) {
    throw new Error("YouTube 媒体 URL 无效");
  }
  return runNativeYoutubePlayer("decipher", playerUrl, javascript, cipherOrUrl);
}

export async function transformNativeYoutubeN(
  challenge: string,
  playerUrl: string,
  javascript: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(challenge)) {
    throw new Error("YouTube HLS n challenge 无效");
  }
  const value = await runNativeYoutubePlayer("transform_n", playerUrl, javascript, challenge);
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw new Error("YouTube HLS n challenge 变换无效");
  }
  return value;
}
