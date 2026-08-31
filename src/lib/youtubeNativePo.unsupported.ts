/**
 * Non-macOS builds do not expose the native BotGuard/player bridge. Keeping a tiny module with the
 * same contract lets Vite replace the macOS implementation at build time instead of shipping its
 * worker and JavaScript parser to platforms that can never call them.
 */
export const YOUTUBE_NATIVE_PROOF_SUPPORTED = false;

export const YOUTUBE_NATIVE_PROOF_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36(KHTML, like Gecko)";

export const YOUTUBE_HLS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/18.5 Safari/605.1.15";

function unsupported(): never {
  throw new Error("当前系统没有可用的 YouTube 原生 proof 运行器");
}

export async function mintNativeYoutubeGvsPoToken(
  _binding: string,
  _forceFresh = false,
): Promise<string> {
  return unsupported();
}

export async function nativeYoutubePlayerConfig(
  _playerUrl: string,
  _javascript: string,
): Promise<{ signatureTimestamp: number }> {
  return unsupported();
}

export async function decipherNativeYoutubeUrl(
  _cipherOrUrl: string,
  _playerUrl: string,
  _javascript: string,
): Promise<string> {
  return unsupported();
}

export async function transformNativeYoutubeN(
  _challenge: string,
  _playerUrl: string,
  _javascript: string,
): Promise<string> {
  return unsupported();
}
