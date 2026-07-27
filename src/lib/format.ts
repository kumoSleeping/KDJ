/**
 * 展示层格式化。
 * 输入一律允许 null/undefined —— 后端大量字段是可空的（未分析的曲目没有 bpm/duration），
 * 让每个调用点自己写 `?? "—"` 只会到处不一致，所以缺值在这里统一收口。
 */

/** 缺值占位符（EM DASH，比 "-" 在等宽数字里更好认）。 */
export const DASH = "—";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 秒 → `m:ss`（不足一小时）或 `h:mm:ss`。缺值给 `--:--`，因为它和时长同宽。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** 字节 → `1.4 MB`。1024 进制，KB 以上保留 1 位小数。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!isNum(bytes) || bytes < 0) return DASH;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** 字节/秒 → `1.4 MB/s`。0 或负数当作"没在跑"，给占位符而不是 `0 B/s`。 */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!isNum(bytesPerSecond) || bytesPerSecond <= 0) return DASH;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** BPM 保留 1 位小数（DJ 对 0.1 的差异敏感，2 位又太吵）。 */
export function formatBpm(bpm: number | null | undefined): string {
  if (!isNum(bpm) || bpm <= 0) return DASH;
  return bpm.toFixed(1);
}

/**
 * 日期 → `YYYY-MM-DD HH:mm`（本地时区）。
 * 同时吃两种输入：曲库是 ISO8601 字符串，下载任务是 Unix 秒（float），
 * 所以数字小于 1e12 时按秒解释。
 */
export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return DASH;
  const date =
    typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** 0..1 的比例 → `42%`。超出范围先夹取，避免进度条文案出现 `120%`。 */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (!isNum(ratio)) return DASH;
  const clamped = Math.min(1, Math.max(0, ratio));
  return `${(clamped * 100).toFixed(digits)}%`;
}


/**
 * 把封面地址换成尽量小的缩略图。
 *
 * 搜索结果一屏几十行，每行都拉一张 500×500 的原图，网络和内存都白扔——
 * 表格里那格只有 24px。网易云和 QQ 都支持在 URL 上指定尺寸，认识就改，
 * 不认识的原样返回（大不了是拉了张大图，不会因此挂掉）。
 */
export function thumbUrl(cover: string, size = 48): string {
  if (!cover) return "";
  // 网易云接口回的是 http://p1.music.126.net/...，B 站还有协议相对的 //i2.hdslb.com/...，
  // 而 CSP 的 img-src 只放行 https 外链——不归一协议图根本到不了 <img>。
  const url = (cover.startsWith("//") ? `https:${cover}` : cover).replace(
    /^http:\/\/(?!127\.0\.0\.1)/i,
    "https://",
  );
  // B 站：hdslb 用 @宽w_高h_1c 后缀出缩略图；已带 @ 参数的不再叠加
  if (/hdslb\.com/.test(url)) {
    return url.includes("@") ? url : `${url}@${size * 2}w_${size * 2}h_1c.jpg`;
  }
  // 网易云：?param=48y48
  if (/music\.126\.net|126\.net\/image/.test(url)) {
    return `${url}${url.includes("?") ? "&" : "?"}param=${size}y${size}`;
  }
  // QQ：photo_new 链接里的 R300x300 是尺寸档，最小有 R90x90（实测存在）
  if (/y\.qq\.com|qpic\.cn|y\.gtimg\.cn|music\.tc\.qq\.com/.test(url)) {
    const sized = url.replace(/R\d{2,4}x\d{2,4}M/, "R90x90M");
    if (sized !== url) return sized;
    // 旧式 CDN 链接：路径尾部的 300 / 500 尺寸段换成 90
    return url.replace(/(\/|_)(\d{3})(\.(jpg|png|webp))/i, (_, sep, __, ext) => `${sep}90${ext}`);
  }
  return url;
}

/** 目录路径只显示最后一段：完整路径会把工具条挤爆；悬停给全路径。 */
export function folderName(path: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 曲库里混着 VJ 素材和 MV，它们和音频在列表里长得一模一样。
 *
 * 这份后缀表必须和后端 `crates/kdj-providers/src/tags.rs::VIDEO_EXTENSIONS`
 * 保持一致——两边不一致的表现是"有的视频有角标有的没有"，很难联想到是表漂移了。
 */
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);

export function isVideoTrack(format: string): boolean {
  return VIDEO_EXTENSIONS.has(format.trim().toLowerCase());
}
