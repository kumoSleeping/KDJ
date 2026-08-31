import { copyText, copyTextSelection } from "./copyText";
import { finishApiActivity } from "./activityLog";
import { thumbUrl } from "./format";
import {
  buildShareClipboardTextHtml,
  SHARE_ARTWORK_SIZE,
} from "./shareClipboardMarkup";
import type { ShareContentMode } from "./sharePrefs";
import type { SongSource } from "../types";

export type ShareArtworkLoader = () => Promise<Blob>;

/** 视频与没有本地代理的平台可直接尝试 CDN；跨域不允许时会由调用方退回纯文本。 */
export function remoteArtwork(url: string): ShareArtworkLoader | undefined {
  const source = thumbUrl(url.trim(), SHARE_ARTWORK_SIZE * 2);
  if (!source) return undefined;
  return async () => {
    const started = performance.now();
    let target = "图片服务";
    try {
      target = new URL(source).hostname || target;
    } catch {
      // 非网络 URL 不会从这里带出查询串或资源路径。
    }
    let status = 0;
    try {
      const response = await fetch(source, { cache: "force-cache", referrerPolicy: "no-referrer" });
      status = response.status;
      if (!response.ok) throw new Error(`分享封面 HTTP ${response.status}`);
      const blob = await response.blob();
      finishApiActivity(
        { category: "network", action: "分享封面下载", target },
        { status: response.status, durationMs: performance.now() - started, ok: true },
      );
      return blob;
    } catch (error) {
      finishApiActivity(
        { category: "network", action: "分享封面下载", target },
        {
          status,
          durationMs: performance.now() - started,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }
  };
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("无法读取分享封面"));
    };
    image.src = objectUrl;
  });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("无法生成分享缩略图"));
    }, "image/png");
  });
}

async function thumbnailPng(source: Blob): Promise<Blob> {
  const image = await loadImage(source);
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (side <= 0) throw new Error("分享封面尺寸无效");

  const canvas = document.createElement("canvas");
  canvas.width = SHARE_ARTWORK_SIZE;
  canvas.height = SHARE_ARTWORK_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理分享封面");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    SHARE_ARTWORK_SIZE,
    SHARE_ARTWORK_SIZE,
  );
  return canvasPng(canvas);
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const separator = value.indexOf(",");
      if (separator < 0) {
        reject(new Error("无法编码分享缩略图"));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取分享缩略图"));
    reader.readAsDataURL(blob);
  });
}

function writeClipboardItems(
  text: string,
  loadPng: () => Promise<Blob>,
): Promise<boolean> | null {
  if (
    typeof navigator === "undefined"
    || !navigator.clipboard?.write
    || typeof ClipboardItem === "undefined"
  ) {
    return null;
  }
  try {
    // WebKit 要求 write 本身必须在点击手势的同步调用栈内发生，PNG
    // 可以作为 Promise 延后交付，不能先 await 封面再调 write。
    const png = loadPng();
    // QQ for macOS 会预览 HTML data URL，却无法在发送时把它上传成图片。
    // 把真实 PNG 放在第一个 pasteboard item，文字放在第二个 item，既让
    // 接收端得到可上传的图片附件，也明确保证封面排在文字之前。
    const pending = navigator.clipboard.write([
      new ClipboardItem({
        "image/png": png,
      }, { presentationStyle: "attachment" }),
      new ClipboardItem({
        "text/html": Promise.resolve(new Blob(
          [buildShareClipboardTextHtml(text)],
          { type: "text/html" },
        )),
        "text/plain": Promise.resolve(new Blob([text], { type: "text/plain" })),
      }, { presentationStyle: "inline" }),
    ]);
    return pending.then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** 老 WebView 不开放 ClipboardItem 时，用一次离屏富文本选区写入同样的载荷。 */
function writeRichSelection(text: string, html: string): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const previousRanges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneRange()
  );
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const node = document.createElement("div");
  node.contentEditable = "true";
  node.innerHTML = html;
  node.style.position = "fixed";
  node.style.left = "-10000px";
  node.style.top = "0";
  node.style.opacity = "0";
  node.style.pointerEvents = "none";
  document.body.appendChild(node);
  let wrote = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", html);
    wrote = true;
  };
  node.addEventListener("copy", onCopy);
  node.focus({ preventScroll: true });

  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    document.execCommand("copy");
    return wrote;
  } catch {
    return false;
  } finally {
    selection.removeAllRanges();
    for (const previousRange of previousRanges) selection.addRange(previousRange);
    node.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

/**
 * 「更多信息」在普通文本之外附带固定小尺寸 PNG；任一步失败时仍保证文字能复制。
 * 另外两档完全沿用纯文本，避免目标应用把普通分享误判成图片消息。
 */
export async function copyShareContent(
  text: string,
  mode: ShareContentMode,
  artwork?: ShareArtworkLoader,
): Promise<void> {
  const value = text.trim();
  if (!value) return;
  if (mode !== "more_info" || !artwork) {
    await copyText(value);
    return;
  }

  // 先在点击这一刻放一份纯文本保底。封面请求可能需要几百毫秒，
  // 等它回来才复制会丢掉 WebKit 的用户手势，最终剪贴板什么也收不到。
  const plainWritten = copyTextSelection(value);
  const plainWrite = plainWritten ? null : copyText(value);

  // macOS 原生 pasteboard 能可靠保留“图片 item + 文字 item”。WebKit 的
  // Clipboard API 在 Tauri 壳里会把多 item 写入折叠或回退成单项，QQ 因而
  // 只能得到图片或文字之一。原生命令不受网页用户手势时限影响，可以先完成缩图。
  const nativeWrite = typeof window !== "undefined"
    ? window.kdj?.writeShareClipboard
    : undefined;
  if (nativeWrite) {
    try {
      const png = await thumbnailPng(await artwork());
      await nativeWrite({ text: value, png: await blobBase64(png) });
      return;
    } catch {
      if (plainWrite) await plainWrite;
      return;
    }
  }

  const richWrite = writeClipboardItems(
    value,
    async () => thumbnailPng(await artwork()),
  );
  if (richWrite && await richWrite) return;

  // 旧 WebView 或封面读取失败时只保留文字，不能再退回 data URL 图片，
  // 否则 QQ 草稿看似正常，发送后仍会变成“加载失败”。
  if (writeRichSelection(value, buildShareClipboardTextHtml(value))) return;
  if (plainWrite) {
    await plainWrite;
  }
}

/** 为合并搜索结果挑一张真实可读取的封面；一张失败会继续尝试下一来源。 */
export function songSourcesArtwork(
  sources: readonly SongSource[],
  preferredIndex = 0,
): ShareArtworkLoader | undefined {
  const preferred = sources[preferredIndex];
  const ordered = preferred
    ? [preferred, ...sources.filter((source) => source !== preferred)]
    : [...sources];
  const candidates = ordered.flatMap<ShareArtworkLoader>((source) => {
    if (source.platform === "local") {
      const trackId = Number(source.payload?.track_id);
      return Number.isFinite(trackId) && trackId > 0
        ? [async () => (await import("./api")).api.coverBlob(trackId)]
        : [];
    }
    if (
      (source.platform === "wyy" || source.platform === "qqm")
      && source.cover.trim()
    ) {
      const platform = source.platform;
      const cover = source.cover;
      return [async () => (await import("./api")).api.onlineCover(platform, cover)];
    }
    const remote = remoteArtwork(source.cover);
    return remote ? [remote] : [];
  });
  if (candidates.length === 0) return undefined;
  return async () => {
    let lastError: unknown = new Error("没有可用的分享封面");
    for (const load of candidates) {
      try {
        return await load();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
}
