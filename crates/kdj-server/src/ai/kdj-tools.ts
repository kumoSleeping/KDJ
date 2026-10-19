/**
 * KDJ's tools for the pi it runs (docs/ai-dock.md). Each tool is one `kdj` CLI command
 * (docs/ai-cli.md): the CLI prints one line of JSON, `{"ok":true,"data":…}` or
 * `{"ok":false,"error":{…}}`. `data` goes to the model as text and to KDJ's AI corner as the
 * result's `details`, where the step is drawn from it.
 *
 * The model is not told that a CLI is behind them: the descriptions name what KDJ does, and
 * what the CLI says about itself (its commands, notes and usage hints) is left out of what the
 * model gets. KDJ's own AI uses KDJ's tools; the CLI is for AIs outside KDJ.
 *
 * Beside them: a web search, pi-web-access's or one of KDJ's built-in ways (kdj-web.ts).
 *
 * Written into KDJ's own pi directory by kdj-server; edits here, not there.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { folderScore, walk } from "./kdj-folders.ts";
import { blindLine, registerVideo, videoHeight } from "./kdj-video.ts";
import { registerWeb } from "./kdj-web.ts";

const CLI = process.env.KDJ_CLI || "kdj";
const DATA_DIR = process.env.KDJ_DATA_DIR;

type Progress = { event: "progress"; done: number; total: number; detail?: string };

/**
 * Runs one CLI command to its end. Aborting the tool ends the command, which KDJ takes as a
 * cancel. `kdj download` and `kdj project render` write `{"event":"progress",…}` lines to stderr while they run; they go
 * to `onProgress`, everything else on stderr is kept for an error message.
 */
function kdj(args: string[], signal?: AbortSignal, onProgress?: (progress: Progress) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, DATA_DIR ? ["--data-dir", DATA_DIR, ...args] : args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let partial = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        let progress: Progress | null = null;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.event === "progress") progress = parsed;
        } catch { /* a plain line */ }
        if (progress) onProgress?.(progress);
        else err += `${line}\n`;
      }
    });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", error => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", code => {
      signal?.removeEventListener("abort", abort);
      const last = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
      let reply: { ok?: boolean; data?: unknown; error?: unknown } | null = null;
      try { reply = JSON.parse(last); } catch { /* not JSON: told below */ }
      if (reply?.ok) { resolve(reply.data); return; }
      const error = reply?.error;
      // The CLI's hint points at its own usage, which the model does not have.
      const told = error && typeof error === "object" ? { ...(error as Record<string, unknown>), hint: undefined } : error;
      const message = typeof told === "string" ? told
        : told && typeof told === "object" ? JSON.stringify(told)
          : (err + partial).trim() || `KDJ 出错（退出码 ${code}）`;
      reject(new Error(message));
    });
  });
}

/** `data` for the AI corner as it is; for the model without cover addresses, which only draw. */
function result(data: unknown) {
  const text = JSON.stringify(data, (key, value) => (key === "cover" ? undefined : value));
  return { content: [{ type: "text" as const, text }], details: data };
}

/** `--flag value` for each value that is set. */
function flags(values: Record<string, string | number | boolean | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === false || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (value === true) out.push(`--${name}`);
    else out.push(`--${name}`, Array.isArray(value) ? value.join(",") : String(value));
  }
  return out;
}

const status = defineTool({
  name: "kdj_status",
  label: "KDJ 状态",
  description: "KDJ 的状态：各平台登录状态与登录方式、本机浏览器、账号歌单 ref、下载位置。",
  parameters: Type.Object({}),
  async execute(_id, _params, signal) {
    // What the CLI says about itself is for AIs outside KDJ.
    const { cli: _cli, commands: _commands, notes: _notes, hint: _hint, running: _running, kdj: _kdj, ...state } =
      await kdj(["status"], signal) as Record<string, unknown>;
    return result(state);
  },
});

// ---------------------------------------------------------------- folders

/** The library's roots (kdj status), asked again after a minute. */
let roots: { at: number; dirs: string[] } | null = null;
async function libraryRoots(signal?: AbortSignal): Promise<string[]> {
  if (roots && Date.now() - roots.at < 60_000) return roots.dirs;
  const status = await kdj(["status"], signal) as { download?: { library_roots?: unknown; default_dir?: unknown } };
  const dirs = Array.isArray(status?.download?.library_roots)
    ? status.download.library_roots.filter((dir): dir is string => typeof dir === "string" && dir.length > 0)
    : [];
  roots = { at: Date.now(), dirs };
  return dirs;
}

const folders = defineTool({
  name: "kdj_folders",
  label: "找文件夹",
  description: "在曲库根目录和它们的全部子文件夹里按名字找文件夹（不分空格、分隔符，八=8，yue=月），按相似度排序，返回绝对路径 path、相对路径和歌曲数。下到某个文件夹前先用它找到准确的 path，不要自己猜路径。query 留空则列出全部文件夹。",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "用户说的文件夹名" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
  async execute(_id, params, signal) {
    const query = params.query?.trim() ?? "";
    const dirs = await libraryRoots(signal);
    const found = dirs.flatMap(rootDir => walk(rootDir).map(folder => {
      const rel = relative(rootDir, folder.path) || ".";
      const score = Math.max(folderScore(basename(folder.path), query), folderScore(rel, query) - 5);
      return { path: folder.path, relative: rel, root: rootDir, songs: folder.songs, score };
    }));
    const ranked = found
      .filter(folder => folder.score > 0)
      .sort((a, b) => b.score - a.score || a.relative.split("/").length - b.relative.split("/").length || a.relative.length - b.relative.length)
      .slice(0, params.limit ?? (query ? 8 : 50));
    return result({ query, roots: dirs, folders: ranked });
  },
});

/**
 * What a search or the library gave, by ref: a question or a plan can offer those songs and videos
 * with their covers. Library rows are `library:<id>`.
 */
type Song = { ref: string; title: string; artists: string[]; platform: string; cover: string; duration: number | null; kind?: string };
const songs = new Map<string, Song>();
function rememberLibrary(data: unknown) {
  const items = (data as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    const item = raw as { id?: unknown; title?: unknown; artist?: unknown; duration?: unknown; path?: unknown };
    if (typeof item.id !== "number") continue;
    const ref = `library:${item.id}`;
    const path = typeof item.path === "string" ? item.path : "";
    songs.set(ref, {
      ref, title: typeof item.title === "string" && item.title ? item.title : basename(path) || ref,
      artists: typeof item.artist === "string" && item.artist ? [item.artist] : [], platform: "library", cover: "",
      duration: typeof item.duration === "number" ? item.duration : null,
      kind: /\.(mp4|mov|m4v|mkv|webm|avi|kdjv)$/i.test(path) ? "video" : "song",
    });
  }
}

/** The frames kdj_peek cut in this pi: the only pictures a plan may show as evidence. */
const peeked = new Set<string>();
function rememberFrames(data: unknown) {
  const cut = data as { sheet?: { path?: unknown }; frames?: { path?: unknown }[] } | null;
  if (typeof cut?.sheet?.path === "string") peeked.add(cut.sheet.path);
  for (const frame of cut?.frames ?? []) if (typeof frame.path === "string") peeked.add(frame.path);
}
function remember(data: unknown) {
  const items = (data as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    const item = raw as Partial<Song> & { ref?: string };
    if (!item.ref) continue;
    songs.set(item.ref, {
      ref: item.ref, title: item.title ?? item.ref, artists: Array.isArray(item.artists) ? item.artists : [],
      platform: item.platform ?? "", cover: item.cover ?? "", duration: typeof item.duration === "number" ? item.duration : null,
      kind: typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : undefined,
    });
  }
}

const search = defineTool({
  name: "kdj_search",
  label: "搜索",
  description: "在 KDJ 的聚合搜索里搜索，搜索页同时显示这次搜索。text 可以是关键词、分享链接或之前给出的 ref；集合 ref 会直接展开。结果里的 ref 交给 kdj_download。" +
    "只用来找要下载的东西（新歌、别的版本、视频素材）。曲库里已有的歌（用户拖进来的、kdj_library_list 找到的）不要搜它本身：" +
    "歌名、歌手、专辑、出自哪部作品看 kdj_library_get，段落看它的小节线和段落，还不清楚用网页搜索。",
  parameters: Type.Object({
    text: Type.String({ description: "关键词、链接或 ref" }),
    kind: Type.Optional(Type.Union([Type.Literal("song"), Type.Literal("playlist"), Type.Literal("album"), Type.Literal("artist"), Type.Literal("radio")])),
    platforms: Type.Optional(Type.Array(Type.String(), { description: "只搜这些平台：wyy qqm soundcloud ytm youtube bilibili；默认用 KDJ 设置" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "每个平台的结果数" })),
  }),
  async execute(_id, params, signal) {
    const data = await kdj(["search", params.text, ...flags({ kind: params.kind, platform: params.platforms, limit: params.limit })], signal);
    remember(data);
    return result(data);
  },
});

/** Videos are fetched at this height unless the AI asks for another; the best below it otherwise. */
const VIDEO_HEIGHT = 1080;
const VIDEO_FILE = /\.(mp4|mov|m4v|mkv|webm)$/i;

/** Each downloaded video's picture height, and a word when one came smaller than asked for. */
async function withHeights(data: unknown, asked: number, signal?: AbortSignal): Promise<unknown> {
  const done = data as { items?: unknown[] } | null;
  if (!done || !Array.isArray(done.items)) return data;
  const smaller: string[] = [];
  const items = await Promise.all(done.items.map(async raw => {
    const item = raw as { path?: unknown; title?: unknown };
    if (typeof item.path !== "string" || !VIDEO_FILE.test(item.path)) return raw;
    const height = await videoHeight(item.path, signal);
    if (height !== null && height < asked) smaller.push(`${typeof item.title === "string" ? item.title : basename(item.path)}：${height}p`);
    return { ...(raw as object), height };
  }));
  const note = smaller.length > 0
    ? { note: `没有 ${asked}p，下到的是更低的画质（${smaller.join("、")}）。照常使用，在给用户的报告里写明画质。` }
    : {};
  return { ...done, items, ...note };
}

const download = defineTool({
  name: "kdj_download",
  label: "下载",
  description: "立即下载 kdj_search 给出的 ref（或链接），用户能在下载栏看到，全部结束才返回路径和 track_id。" +
    "视频默认按 1080p 下载（height 可改）；没有 1080p 时自动取最接近的较低画质（通常 720p），返回里每个视频带 height，" +
    "画质低于要的会有 note：照常使用，在给用户的报告里写明。",
  parameters: Type.Object({
    refs: Type.Array(Type.String(), { minItems: 1 }),
    to: Type.Optional(Type.String({ description: "目标文件夹的绝对路径，须在曲库根目录内；默认下载文件夹" })),
    quality: Type.Optional(Type.Union([Type.Literal("flac"), Type.Literal("320"), Type.Literal("128")])),
    as: Type.Optional(Type.Union([Type.Literal("audio"), Type.Literal("video")], { description: "视频只要音轨（audio）或保留画面（video，默认）" })),
    height: Type.Optional(Type.Integer({ description: "视频最高画面高度，默认 1080" })),
  }),
  async execute(_id, params, signal, onUpdate) {
    const height = params.as === "audio" ? undefined : params.height ?? VIDEO_HEIGHT;
    const args = ["download", ...params.refs, ...flags({ to: params.to, quality: params.quality, as: params.as, height })];
    // Each progress line becomes a partial result: the AI corner draws its bar from `details`.
    const data = await kdj(args, signal, ({ done, total }) => onUpdate?.({
      content: [{ type: "text", text: `${done}/${total}` }],
      details: { done, total },
    }));
    return result(height ? await withHeights(data, height, signal) : data);
  },
});

const login = defineTool({
  name: "kdj_login",
  label: "登录",
  description: "登录平台。wyy/qqm/bilibili 默认扫码，二维码会在用户屏幕上打开；youtube/ytm/soundcloud 或给了 browser 时从本机浏览器导入（见 kdj_status 的 browsers）。完成才返回。",
  parameters: Type.Object({
    platform: Type.String(),
    browser: Type.Optional(Type.String()),
    profile: Type.Optional(Type.String()),
  }),
  async execute(_id, params, signal) {
    return result(await kdj(["login", params.platform, ...flags({ browser: params.browser, profile: params.profile })], signal));
  },
});

const libraryList = defineTool({
  name: "kdj_library_list",
  label: "曲库",
  description: "按文本、调性、BPM 区间（如 124..130）、能量或文件夹（绝对路径）筛选本地曲库，不触发分析；KDJ 的曲库页同时显示这次筛选。",
  parameters: Type.Object({
    q: Type.Optional(Type.String()),
    key: Type.Optional(Type.String()),
    bpm: Type.Optional(Type.String()),
    energy: Type.Optional(Type.Integer()),
    folder: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer()),
    offset: Type.Optional(Type.Integer()),
  }),
  async execute(_id, params, signal) {
    const data = await kdj(["library", "list", ...flags(params)], signal);
    rememberLibrary(data);
    return result(data);
  },
});

const libraryGet = defineTool({
  name: "kdj_library_get",
  label: "曲目",
  description: "曲目详情（bpm、调性、小节线、段落、cue），缺分析时当场补齐（可能要几十秒）。按 id、文件路径或唯一匹配的文本取。时间单位都是秒，grid.downbeats 是小节线。",
  parameters: Type.Object({
    id: Type.Optional(Type.Array(Type.Integer())),
    path: Type.Optional(Type.String()),
    q: Type.Optional(Type.String()),
    beats: Type.Optional(Type.Boolean({ description: "同时返回每一拍的时间" })),
  }),
  async execute(_id, params, signal) {
    return result(await kdj(["library", "get", ...flags({ id: params.id?.map(String), path: params.path, q: params.q, beats: params.beats })], signal));
  },
});

const peek = defineTool({
  name: "kdj_peek",
  label: "截帧",
  description: "看视频的画面：从曲库视频、文件路径、bilibili ref 或链接截帧（只有在线 B 站不用下载；YouTube 等其它在线视频截不了，先 kdj_download 下载再截），截下的画面直接给你看（多张时是按时间顺序拼好的一张）。at 是逗号分隔的时间（75,1:30），或用 every 秒数均匀截取。画面只用来核对内容，判断不了音画是否同步。",
  parameters: Type.Object({
    source: Type.String(),
    at: Type.Optional(Type.String()),
    every: Type.Optional(Type.Number()),
    width: Type.Optional(Type.Integer()),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const data = await kdj(["peek", params.source, ...flags({ at: params.at, every: params.every, width: params.width })], signal);
    rememberFrames(data);
    // A model that takes no pictures is not handed pictures it never sees.
    if (blindLine(ctx?.model)) return result({ ...(data as object), blind: "你看不到图片，这些画面没有交给你" });
    const told = result(data);
    return { ...told, content: [...told.content, ...await pictures(data)] };
  },
});

/** What peek cut, as pictures the model sees: the sheet when there is one, else the frames. */
async function pictures(data: unknown) {
  const peeked = data as { sheet?: { path?: unknown }; frames?: { path?: unknown }[] } | null;
  const paths = typeof peeked?.sheet?.path === "string"
    ? [peeked.sheet.path]
    : (peeked?.frames ?? []).map(frame => frame.path).filter((path): path is string => typeof path === "string").slice(0, 4);
  const out: { type: "image"; data: string; mimeType: string }[] = [];
  for (const path of paths) {
    try {
      out.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType: "image/jpeg" });
    } catch { /* A frame that cannot be read is left out; its path is still in the text. */ }
  }
  return out;
}

const align = defineTool({
  name: "kdj_align",
  label: "对齐",
  description: "把视频按声音对齐到参考曲（音视频合并的核心；short 版 MV/NCED 对整首歌也用它），返回几套定位方案 plans：segments 里 ref = ref_at + (video - video_in) / speed（秒）；ref_bar 是参考曲的小节号。evidence 为 verified 的经过声学核实，auto=true 的可以直接采用；melody / partial 只是候选，auto=false 的方案需要用户试听确认。只有部分对得上时用「裁切匹配段」（sections）。每套方案的 gaps 是参考曲里没有画面的空档（start、end、length，秒）：空档要问用户怎么处理，不要自己拉别的素材填。matched 为 false 是对不上，告诉用户，不要硬拼。",
  parameters: Type.Object({
    ref: Type.String({ description: "参考曲：曲库 id 或文件路径" }),
    video: Type.String({ description: "视频：曲库 id、文件路径、bilibili ref 或链接" }),
  }),
  async execute(_id, params, signal) {
    return result(withGaps(await kdj(["align", ...flags({ ref: params.ref, video: params.video })], signal)));
  },
});

/** Gaps shorter than this are seams between segments, not a stretch without picture. */
const GAP_MIN_SECONDS = 0.5;

/**
 * Each plan gets the stretches of the reference its segments leave without picture, so the AI
 * can name them to the listener rather than working them out.
 */
function withGaps(data: unknown): unknown {
  const aligned = data as { reference?: { duration?: unknown }; plans?: unknown } | null;
  const duration = typeof aligned?.reference?.duration === "number" ? aligned.reference.duration : null;
  if (!aligned || duration === null || !Array.isArray(aligned.plans)) return data;
  const plans = aligned.plans.map(raw => {
    const plan = raw as { segments?: unknown };
    const covered = (Array.isArray(plan.segments) ? plan.segments : []).flatMap(item => {
      const seg = item as { video_in?: unknown; video_out?: unknown; ref_at?: unknown; speed?: unknown };
      if (typeof seg.video_in !== "number" || typeof seg.video_out !== "number" || typeof seg.ref_at !== "number") return [];
      const speed = typeof seg.speed === "number" && seg.speed > 0 ? seg.speed : 1;
      const start = Math.max(0, seg.ref_at);
      const end = Math.min(duration, seg.ref_at + (seg.video_out - seg.video_in) / speed);
      return end > start ? [[start, end] as const] : [];
    }).sort((a, b) => a[0] - b[0]);
    const gaps: { start: number; end: number; length: number }[] = [];
    let at = 0;
    for (const [start, end] of [...covered, [duration, duration] as const]) {
      if (start - at >= GAP_MIN_SECONDS) {
        const round = (value: number) => Math.round(value * 100) / 100;
        gaps.push({ start: round(at), end: round(start), length: round(start - at) });
      }
      at = Math.max(at, end);
    }
    return { ...(raw as object), gaps };
  });
  return { ...aligned, plans };
}

/**
 * The only way to ask the listener anything, as a bubble at the bottom right of the KDJ window:
 * a question with a few choices (a countdown when `timeout` is given — when it runs out,
 * `default` is taken), or a plan (`body`): Markdown with keys, material cards and evidence
 * frames in it, every question answered together with one 确定.
 *
 * The window draws it from this call's partial result: the songs and videos a search or the
 * library gave, by ref, and the frames kdj_peek cut, as pictures — the model names them, it never
 * hands the window a picture or a file of its own. The answer comes back through an editor
 * dialog titled `kdj:ask:<call id>`, as JSON `{ choices | answers, note, cancelled }`.
 */
const PLAN_TAG_ATTRS = /(\w+)="([^"]*)"/g;
const attrsOf = (raw: string) => Object.fromEntries([...raw.matchAll(PLAN_TAG_ATTRS)].map(match => [match[1], match[2]]));
/** A frame shown as evidence is at most this large; more frames than these are left out. */
const SHOT_BYTES = 600 * 1024;
const SHOTS = 6;

/** What a plan's body names: the questions its keys and cards answer, its cards and its frames. */
function planParts(body: string) {
  const ids = new Set<string>();
  const refs = new Set<string>();
  const shots = new Set<string>();
  for (const match of body.matchAll(/<choice\b([^>]*)>/g)) { const a = attrsOf(match[1]); if (a.q) ids.add(a.q); }
  for (const match of body.matchAll(/<media\b([^>]*)\/?>/g)) {
    const a = attrsOf(match[1]);
    if (a.ref) refs.add(a.ref);
    if (a.q) ids.add(a.q);
  }
  for (const match of body.matchAll(/<shot\b([^>]*)>/g)) { const a = attrsOf(match[1]); if (a.src) shots.add(a.src); }
  return { ids, refs, shots };
}

async function shotPictures(paths: Iterable<string>) {
  const out: Record<string, string> = {};
  for (const path of [...paths].slice(0, SHOTS)) {
    // Only frames kdj_peek cut: a plan cannot show an arbitrary file.
    if (!peeked.has(path)) continue;
    try {
      const data = await readFile(path);
      if (data.length <= SHOT_BYTES) out[path] = `data:image/jpeg;base64,${data.toString("base64")}`;
    } catch { /* A frame that is gone is left out; the plan says what it showed. */ }
  }
  return out;
}

const askUser = defineTool({
  name: "ask_user",
  label: "询问",
  description: "需要用户决定时调用：KDJ 右下角弹出一个气泡。\n" +
    "一件事：question 加文字选项（options）或歌曲选项（songs：kdj_search 给出的 ref，显示封面、歌名、艺术家和来源），multiple 允许多选；" +
    "给了 timeout（秒）就显示倒计时，到时没选则按 default。返回 choices（选中的选项文字或 ref）和 note。\n" +
    "几件事一起定（比如视频方案）：写 body，用 Markdown 写清你打算怎么做（做法、会下什么、大约多大、最后交什么），短句、列表、粗体都可以；" +
    "要用户选的地方嵌进标签，系统负责画出来：\n" +
    "- <choice q=\"问题id\" value=\"值\">按钮上的字</choice>：一个按钮，点了就选这个值；\n" +
    "- <media q=\"问题id\" ref=\"ref\"/>：一张素材卡片（封面、标题、来源、时长、打开链接），ref 是 kdj_search 给的或 kdj_library_list 的 library:<id>；不给 q 只展示；\n" +
    "- <shot src=\"kdj_peek 给出的帧路径\">这张图说明什么</shot>：你看过的画面，贴给用户自己判断（字幕、水印、是不是原作）。" +
    "方案里有视频素材时必须给：每个推荐的视频素材至少一张；能截帧的（在线 B 站、曲库视频）没贴截图，方案会被退回。\n" +
    "同一个问题默认单选；questions 里给 {id, multiple, default} 改成多选或预选。返回 answers（每个问题选中的值）和 note。方案不给 timeout。\n" +
    "用户还可以写一句补充（note），要照着做。用户关掉或点「暂停」则 cancelled 为 true，停下。",
  parameters: Type.Object({
    question: Type.Optional(Type.String({ description: "一句问题；写 body 时是标题，可以不给" })),
    body: Type.Optional(Type.String({ description: "方案：Markdown，嵌 <choice> <media> <shot>" })),
    preview: Type.Optional(Type.String({ description: "（旧写法）写在问题上面：你打算怎么做" })),
    questions: Type.Optional(Type.Array(Type.Object({
      id: Type.String(),
      question: Type.Optional(Type.String({ description: "不写 body 时的问题" })),
      options: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "不写 body 时的选项" })),
      multiple: Type.Optional(Type.Boolean()),
      default: Type.Optional(Type.Array(Type.String())),
    }), { maxItems: 8 })),
    options: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
    songs: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "kdj_search 给出的 ref" })),
    multiple: Type.Optional(Type.Boolean()),
    default: Type.Optional(Type.Array(Type.String(), { description: "选项文字或 ref" })),
    timeout: Type.Optional(Type.Integer({ minimum: 3, maximum: 300 })),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const body = params.body ?? "";
    const parts = planParts(body);
    const meta = new Map((params.questions ?? []).map(item => [item.id, item]));
    // A plan's questions: those its keys and cards answer, then those listed without a body.
    const ids = body ? [...new Set([...parts.ids, ...meta.keys()])].filter(qid => parts.ids.has(qid)) : [...meta.keys()];
    const questions = ids.map(qid => {
      const item = meta.get(qid);
      return { id: qid, question: item?.question ?? "", options: item?.options ?? [], multiple: item?.multiple ?? false, defaults: item?.default ?? [] };
    });
    if (!params.question && !body && !params.preview && questions.length === 0) throw new Error("没有要问的：给 question，或 body");
    const unknown = [...parts.refs].filter(ref => !songs.has(ref));
    // A plan offering footage shows the listener what it looked like, not only the AI's verdict.
    const peekable = [...parts.refs].filter(ref => songs.get(ref)?.kind === "video" && /^(bilibili|library):/.test(ref));
    if (peekable.length > 0 && ![...parts.shots].some(src => peeked.has(src))) {
      throw new Error(`方案里有视频素材（${peekable.join("、")}），但没有贴出你看过的画面：先用 kdj_peek 截帧，再用 <shot src="帧路径">说明</shot> 贴进 body，然后再问`);
    }
    const asked = {
      question: params.question ?? "",
      body,
      preview: params.preview ?? "",
      questions,
      media: Object.fromEntries([...parts.refs].filter(ref => songs.has(ref)).map(ref => [ref, songs.get(ref)])),
      shots: await shotPictures(parts.shots),
      options: params.options ?? [],
      songs: (params.songs ?? []).map(ref => songs.get(ref) ?? { ref, title: ref, artists: [], platform: ref.split(":")[0], cover: "", duration: null }),
      multiple: params.multiple ?? false,
      defaults: params.default ?? [],
      timeout: body ? 0 : params.timeout ?? 0,
    };
    onUpdate?.({ content: [{ type: "text", text: "等待用户回答" }], details: asked });
    const timeout = asked.timeout ? asked.timeout * 1000 : undefined;
    const reply = await ctx.ui.editor(`kdj:ask:${id}`, "", { signal, timeout });
    let answer: { choices?: unknown; answers?: unknown; note?: unknown; cancelled?: unknown } = {};
    try { answer = reply ? JSON.parse(reply) : {}; } catch { answer = { note: reply }; }
    const picks = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const note = typeof answer.note === "string" && answer.note.trim() ? answer.note.trim() : null;
    const timedOut = reply === undefined && Boolean(timeout);
    const cancelled = !timedOut && (reply === undefined || answer.cancelled === true);
    // Cards the window could not draw: the model is told, so it does not count on them.
    const unseen = unknown.length > 0 ? { unseen: `这些 ref 不是 kdj_search 或 kdj_library_list 给出的，没有画出来：${unknown.join("、")}` } : {};
    if (questions.length > 0) {
      const given = answer.answers && typeof answer.answers === "object" ? answer.answers as Record<string, unknown> : {};
      const answers = Object.fromEntries(questions.map(item => [item.id, timedOut ? item.defaults : picks(given[item.id])]));
      return result(cancelled ? { cancelled, answers: {}, note, ...unseen } : { answers, note, ...(timedOut ? { timedOut } : {}), ...unseen });
    }
    if (timedOut) return result({ choices: asked.defaults, note: null, timedOut: true });
    return result(cancelled ? { cancelled, choices: [], note, ...unseen } : { choices: picks(answer.choices), note, ...unseen });
  },
});

/** A message for the listener, as a bubble at the top; it stays `seconds`, or until put away. */
const tellUser = defineTool({
  name: "tell_user",
  label: "告诉用户",
  description: "给用户发一条消息，显示在 KDJ 顶部。少用：只在用户问了问题、需要你回答时用；用户让你做事，做完不要发完成消息。seconds 是停留秒数，不给则一直停留到用户关掉。",
  parameters: Type.Object({
    message: Type.String(),
    seconds: Type.Optional(Type.Integer({ minimum: 3, maximum: 600 })),
  }),
  async execute(_id, params) {
    return result({ shown: true, seconds: params.seconds ?? null });
  },
});

/** Carried out by the KDJ window, which sees this call in pi's stream and plays the track. */
const play = defineTool({
  name: "kdj_play",
  label: "播放",
  description: "在 KDJ 里播放曲库中的一首歌：用 kdj_download 或 kdj_library_list 给出的 track_id。",
  parameters: Type.Object({ track_id: Type.Integer() }),
  async execute(_id, params) {
    return result({ track_id: params.track_id, playing: true });
  },
});

export default function (pi: ExtensionAPI) {
  for (const tool of [status, search, download, folders, login, libraryList, libraryGet, peek, align, play, askUser, tellUser]) {
    pi.registerTool(tool);
  }
  registerWeb(pi);
  // Video work (the kdj-video skill): files in the workspace, FFmpeg, Remotion and .kdjv projects.
  registerVideo(pi, { kdj, libraryRoots });
  // A model that takes no pictures is told so at the start of every run, and turns video work down.
  pi.on("before_agent_start", (event, ctx) => {
    const line = blindLine(ctx.model);
    return line ? { systemPrompt: `${event.systemPrompt}\n\n${line}` } : undefined;
  });
}
