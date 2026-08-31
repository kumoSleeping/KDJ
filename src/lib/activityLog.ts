import type { ActivityLogCategory, ActivityLogLevel } from "../types";

interface ActivityDraft {
  category: ActivityLogCategory;
  level: ActivityLogLevel;
  action: string;
  detail: string;
  target: string;
  status?: number;
  duration_ms?: number;
  count: number;
}

export interface ApiActivityDescriptor {
  category: ActivityLogCategory;
  action: string;
  target?: string;
  detail?: string;
  /** 分析的正常路径不落日志，只有失败才写。 */
  onlyFailures?: boolean;
}

export type ApiActivityHint = ApiActivityDescriptor | null;

const PLATFORM_TARGET: Record<string, string> = {
  wyy: "网易云音乐 · music.163.com",
  qqm: "QQ 音乐 · y.qq.com",
  soundcloud: "SoundCloud · soundcloud.com",
  ytm: "YouTube Music · music.youtube.com",
  youtube: "YouTube · youtube.com",
  bilibili: "哔哩哔哩 · bilibili.com",
};

const QUEUE_LIMIT = 200;
const BATCH_LIMIT = 50;
const FLUSH_DELAY_MS = 800;
const RETRY_DELAY_MS = 5_000;
const MERGE_WINDOW_MS = 1_500;

type QueuedDraft = ActivityDraft & { queuedAt: number };

let queue: QueuedDraft[] = [];
let flushTimer: number | null = null;
let flushing = false;
let lifecycleInstalled = false;

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string" || body.length === 0 || body.length > 1_000_000) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];
}

function bodyPlatforms(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const result = new Set<string>();
  for (const value of strings(body.platforms)) result.add(value);
  for (const value of strings(body.engines)) result.add(value);
  for (const value of strings(body.platform)) result.add(value);
  const source = body.source;
  if (source && typeof source === "object" && "platform" in source) {
    for (const value of strings((source as { platform?: unknown }).platform)) result.add(value);
  }
  if (Array.isArray(body.sources)) {
    for (const item of body.sources) {
      if (item && typeof item === "object" && "platform" in item) {
        for (const value of strings((item as { platform?: unknown }).platform)) result.add(value);
      }
    }
  }
  return [...result];
}

function targetFromUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function requestTarget(path: string, body: Record<string, unknown> | null): string {
  const platforms = bodyPlatforms(body);
  const pathPlatform = path.match(/^\/(?:accounts|stream\/playlists)\/([^/?]+)/)?.[1];
  if (pathPlatform) platforms.push(pathPlatform);
  if (path.includes("/ytm/")) platforms.push("ytm");
  if (path.includes("/youtube/")) platforms.push("youtube");
  const targets = [...new Set(platforms)]
    .map((platform) => PLATFORM_TARGET[platform])
    .filter((value): value is string => Boolean(value));
  const urlTarget = targetFromUrl(body?.url);
  if (urlTarget) targets.push(urlTarget);
  return [...new Set(targets)].join("、");
}

function itemCountDetail(body: Record<string, unknown> | null): string {
  if (!body) return "";
  for (const key of ["sources", "track_ids", "paths"] as const) {
    const value = body[key];
    if (Array.isArray(value)) return `${value.length} 项`;
  }
  return "";
}

function routePlatform(path: string): string {
  const platform = path.match(/^\/stream\/playlists\/([^/?]+)/)?.[1];
  return platform && PLATFORM_TARGET[platform] ? PLATFORM_TARGET[platform] : "";
}

function disposalAction(value: unknown): string {
  return value === "trash"
    ? "将本地文件移到废纸篓"
    : value === "remove" || value === true
      ? "永久删除本地文件"
      : "从曲库移除曲目";
}

/**
 * API 路由是唯一语义钩子：同一次点击不会再额外生成“点了某按钮”的重复记录。
 * 只列出会访问第三方平台或改变本地文件/目录的路由；普通读取、切页和轮询都忽略。
 */
export function describeApiActivity(
  path: string,
  init: RequestInit = {},
  hint?: ApiActivityHint,
): ApiActivityDescriptor | null {
  if (hint !== undefined) return hint;
  if (path.startsWith("/activity/")) return null;
  const method = (init.method ?? "GET").toUpperCase();
  const body = parseBody(init.body);
  const target = requestTarget(path, body);
  const detail = itemCountDetail(body);
  const network = (action: string, fallbackTarget = ""): ApiActivityDescriptor => ({
    category: "network",
    action,
    target: target || fallbackTarget,
    detail,
  });
  const user = (action: string): ApiActivityDescriptor => ({
    category: "user",
    action,
    detail,
  });
  const analysisFailure = (action: string): ApiActivityDescriptor => ({
    category: "analysis",
    action,
    onlyFailures: true,
  });

  if (method === "POST" && path === "/search") return network("搜索 API");
  if (method === "POST" && path === "/search/collection") return network("集合展开 API");
  if (method === "POST" && path === "/search/cover") return network("在线封面 API");
  if (method === "POST" && path === "/lyrics") return network("歌词 API");
  if (method === "POST" && path === "/resolve") return network("链接解析 API");
  if (method === "POST" && path === "/intake") return network("批量检索 API");
  if (method === "POST" && path === "/downloads") return network("下载 API");
  if (method === "POST" && path === "/downloads/start") return network("启动下载 API");
  if (method === "POST" && path === "/video/download") return network("视频下载 API");
  if (method === "POST" && path === "/video/resolve") return network("视频解析 API");
  if (method === "POST" && path === "/video/calibrate") {
    return network("视频校准 API", PLATFORM_TARGET.bilibili);
  }
  if (method === "POST" && path === "/song/preview") return network("在线预览 API");
  // YTM 播放会拆成多个证明/分段请求，只在创建实际媒体 spool 时记一条。
  if (method === "POST" && path === "/song/preview/ytm/sabr/spools") {
    return network("在线预览 API", PLATFORM_TARGET.ytm);
  }
  // YouTube HLS 同样只记 begin，不重复记录 complete/session/segment。
  if (method === "POST" && path === "/video/youtube/hls/begin") {
    return network("视频在线播放 API", PLATFORM_TARGET.youtube);
  }
  if (method === "GET" && path === "/accounts") {
    return network("账号状态 API", "已连接的音乐平台");
  }
  // 登录状态轮询不产生日志；只记录真正发起登录、回调或退出的请求。
  if (method === "POST" && /^\/accounts\/[^/]+\/(?:login|logout)/.test(path)) {
    return network("账号 API");
  }
  if (method === "GET" && path === "/update/check") {
    return network("更新检查 API", "GitHub · github.com");
  }
  if (method === "GET" && /^\/stream\/playlists\/[^/?]+/.test(path)) {
    return network("在线歌单 API", routePlatform(path));
  }
  if (method === "POST" && path === "/stream/playlist") return network("在线歌单内容 API");
  if (method === "POST" && path === "/stream/playlist/remove-track") {
    return network("在线歌单移除 API");
  }
  if (method === "POST" && /^\/downloads\/[^/]+\/retry$/.test(path)) {
    return network("重试下载 API");
  }

  if (/^\/library\/(?:analyze|duplicates\/analyze|waveforms\/upgrade)/.test(path)) {
    return analysisFailure("分析请求异常");
  }
  if (/^\/library\/waveform\//.test(path)) return analysisFailure("波形分析异常");

  if (method === "DELETE" && /^\/library\/tracks\//.test(path)) {
    const query = new URLSearchParams(path.split("?", 2)[1] ?? "");
    return user(disposalAction(query.get("file") ?? query.get("delete_file") === "true"));
  }
  if (method === "POST" && path === "/library/tracks/delete") {
    return user(disposalAction(body?.file));
  }
  if (method === "PATCH" && /^\/library\/tracks\//.test(path)) return user("修改本地曲目信息");
  if (method === "PUT" && /^\/library\/cover\//.test(path)) return user("更换本地封面");
  if (method === "PUT" && /^\/library\/lyrics\//.test(path)) return user("保存本地歌词");
  if (method === "POST" && /\/library\/tracks\/[^/]+\/(?:write-tags|reread-tags)$/.test(path)) {
    return user(path.endsWith("write-tags") ? "写入本地文件标签" : "重读本地文件标签");
  }
  if (method === "POST" && path === "/library/scan") return user("扫描本地曲库");
  if (method === "POST" && path.startsWith("/library/folders/")) {
    const action = path.slice("/library/folders/".length);
    const labels: Record<string, string> = {
      create: "创建本地文件夹",
      rename: "重命名本地文件夹",
      delete: "删除本地文件夹",
      forget: "从曲库移出文件夹",
      init: "初始化本地文件夹",
      upgrade: "升级文件夹元数据",
      move: "移动本地文件夹",
      merge: "合并本地文件夹",
      order: "调整本地文件夹顺序",
      undo: "撤回本地文件操作",
      apply: body?.op === "copy" ? "复制本地文件" : "移动本地文件",
    };
    return labels[action] ? user(labels[action]) : null;
  }
  if (method === "DELETE" && path === "/song/cache") return user("清理在线媒体缓存");
  if (method === "DELETE" && /^\/cache\/(?:media|waveform|lyrics|basic)$/.test(path)) {
    return user("清理本地存储");
  }
  if (method === "POST" && /^\/downloads\/[^/]+\/cancel$/.test(path)) {
    return user("取消下载任务");
  }
  if (method === "DELETE" && /^\/downloads\/[^/]+$/.test(path)) {
    return user("移除下载记录");
  }
  if (method === "POST" && path === "/downloads/cancel-all") {
    return user("取消全部下载任务");
  }
  if (method === "POST" && path === "/downloads/clear") return user("清理下载记录");
  return null;
}

export function settingsActivityHint(changedKeys: readonly string[]): ApiActivityHint {
  return changedKeys.some((key) => key === "download_dir" || key === "video_download_dir")
    ? { category: "user", action: "设定下载文件夹" }
    : null;
}

function cleanFailureDetail(value: string): string {
  const trimmed = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 160);
  const lower = trimmed.toLowerCase();
  if (/https?:\/\//.test(trimmed) || ["token", "cookie", "authorization", "password", "secret"]
    .some((word) => lower.includes(word))) {
    return "请求失败，敏感详情已隐藏";
  }
  return trimmed;
}

export function finishApiActivity(
  descriptor: ApiActivityDescriptor | null,
  outcome: { status: number; durationMs: number; ok: boolean; error?: string },
): void {
  if (!descriptor || (descriptor.onlyFailures && outcome.ok)) return;
  const error = outcome.ok ? "" : cleanFailureDetail(outcome.error || `HTTP ${outcome.status || "连接失败"}`);
  const detail = [descriptor.detail, error].filter(Boolean).join(" · ");
  enqueue({
    category: descriptor.category,
    level: outcome.ok ? "info" : outcome.status === 429 ? "warn" : "error",
    action: descriptor.action,
    detail,
    target: descriptor.target ?? "",
    status: outcome.status || undefined,
    duration_ms: Math.max(0, Math.round(outcome.durationMs)),
    count: 1,
  });
}

function fingerprint(entry: ActivityDraft): string {
  return [entry.category, entry.level, entry.action, entry.detail, entry.target, entry.status ?? ""].join("\u0000");
}

function enqueue(entry: ActivityDraft): void {
  const now = Date.now();
  const previous = queue.at(-1);
  if (previous && now - previous.queuedAt <= MERGE_WINDOW_MS && fingerprint(previous) === fingerprint(entry)) {
    previous.count = Math.min(10_000, previous.count + entry.count);
    previous.duration_ms = Math.max(previous.duration_ms ?? 0, entry.duration_ms ?? 0);
    previous.queuedAt = now;
  } else {
    queue.push({ ...entry, queuedAt: now });
    if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
  }
  installLifecycleFlush();
  scheduleFlush(FLUSH_DELAY_MS);
}

function installLifecycleFlush(): void {
  if (lifecycleInstalled || typeof window === "undefined") return;
  lifecycleInstalled = true;
  const flush = () => void flushQueue(true);
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}

function scheduleFlush(delay: number): void {
  if (flushTimer !== null || typeof window === "undefined") return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushQueue(false);
  }, delay);
}

async function flushQueue(keepalive: boolean): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const selected = queue.splice(0, BATCH_LIMIT);
  const entries = selected.map(({ queuedAt: _queuedAt, ...entry }) => entry);
  try {
    const { getBridge } = await import("./bridge");
    const { baseUrl, authToken } = getBridge();
    const response = await fetch(`${baseUrl}/api/activity/logs/batch`, {
      method: "POST",
      keepalive,
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    queue = [...selected, ...queue].slice(0, QUEUE_LIMIT);
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush(queue[0] === selected[0] ? RETRY_DELAY_MS : FLUSH_DELAY_MS);
  }
}

export function flushActivityLogs(): void {
  void flushQueue(true);
}
