/**
 * KDJ's tools for the pi it runs (docs/ai-dock.md). Each tool is one `kdj` CLI command
 * (docs/ai-cli.md): the CLI prints one line of JSON, `{"ok":true,"data":…}` or
 * `{"ok":false,"error":{…}}`. `data` goes to the model as text and to KDJ's AI corner as the
 * result's `details`, where the step is drawn from it.
 *
 * Beside them: a web search, pi-web-access's or one of KDJ's built-in ways (kdj-web.ts).
 *
 * Written into KDJ's own pi directory by kdj-server; edits here, not there.
 */
import { spawn } from "node:child_process";
import { basename, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { folderScore, walk } from "./kdj-folders.ts";
import { registerWeb } from "./kdj-web.ts";

const CLI = process.env.KDJ_CLI || "kdj";
const DATA_DIR = process.env.KDJ_DATA_DIR;

type Progress = { event: "progress"; done: number; total: number };

/**
 * Runs one CLI command to its end. Aborting the tool ends the command, which KDJ takes as a
 * cancel. `kdj download` writes `{"event":"progress",…}` lines to stderr while it runs; they go
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
      const message = typeof error === "string" ? error
        : error && typeof error === "object" ? JSON.stringify(error)
          : (err + partial).trim() || `kdj 退出码 ${code}`;
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
  description: "kdj status：KDJ 的命令说明、各平台登录状态与登录方式、本机浏览器、账号歌单 ref、下载位置。",
  parameters: Type.Object({}),
  async execute(_id, _params, signal) {
    return result(await kdj(["status"], signal));
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

/** What a search found, by ref: a question can offer those songs with their covers. */
type Song = { ref: string; title: string; artists: string[]; platform: string; cover: string; duration: number | null };
const songs = new Map<string, Song>();
function remember(data: unknown) {
  const items = (data as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    const item = raw as Partial<Song> & { ref?: string };
    if (!item.ref) continue;
    songs.set(item.ref, {
      ref: item.ref, title: item.title ?? item.ref, artists: Array.isArray(item.artists) ? item.artists : [],
      platform: item.platform ?? "", cover: item.cover ?? "", duration: typeof item.duration === "number" ? item.duration : null,
    });
  }
}

const search = defineTool({
  name: "kdj_search",
  label: "搜索",
  description: "kdj search：和 KDJ 搜索框同一路径。text 可以是关键词、分享链接或之前给出的 ref；集合 ref 会直接展开。结果里的 ref 交给 kdj_download。",
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

const download = defineTool({
  name: "kdj_download",
  label: "下载",
  description: "kdj download：立即下载 search 给出的 ref（或链接），用户能在下载栏看到，全部结束才返回路径和 track_id。",
  parameters: Type.Object({
    refs: Type.Array(Type.String(), { minItems: 1 }),
    to: Type.Optional(Type.String({ description: "目标文件夹的绝对路径，须在曲库根目录内；默认下载文件夹" })),
    quality: Type.Optional(Type.Union([Type.Literal("flac"), Type.Literal("320"), Type.Literal("128")])),
    as: Type.Optional(Type.Union([Type.Literal("audio"), Type.Literal("video")], { description: "视频只要音轨（audio）或保留画面（video，默认）" })),
    height: Type.Optional(Type.Integer({ description: "视频最高画面高度，例如 1080" })),
  }),
  async execute(_id, params, signal, onUpdate) {
    const args = ["download", ...params.refs, ...flags({ to: params.to, quality: params.quality, as: params.as, height: params.height })];
    // Each progress line becomes a partial result: the AI corner draws its bar from `details`.
    return result(await kdj(args, signal, ({ done, total }) => onUpdate?.({
      content: [{ type: "text", text: `${done}/${total}` }],
      details: { done, total },
    })));
  },
});

const login = defineTool({
  name: "kdj_login",
  label: "登录",
  description: "kdj login：登录平台。wyy/qqm/bilibili 默认扫码，二维码会在用户屏幕上打开；youtube/ytm/soundcloud 或给了 browser 时从本机浏览器导入（见 kdj_status 的 browsers）。完成才返回。",
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
  description: "kdj library list：按文本、调性、BPM 区间（如 124..130）、能量或文件夹筛选本地曲库，不触发分析。",
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
    return result(await kdj(["library", "list", ...flags(params)], signal));
  },
});

const libraryGet = defineTool({
  name: "kdj_library_get",
  label: "曲目",
  description: "kdj library get：曲目详情（bpm、调性、小节线、段落、cue），缺分析时当场补齐。按 id、文件路径或唯一匹配的文本取。",
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
  description: "kdj peek：从曲库视频、文件路径、bilibili ref 或链接截帧（在线 B 站不用下载），返回图片路径和拼好的 sheet。at 是逗号分隔的时间（75,1:30），或用 every 秒数均匀截取。",
  parameters: Type.Object({
    source: Type.String(),
    at: Type.Optional(Type.String()),
    every: Type.Optional(Type.Number()),
    width: Type.Optional(Type.Integer()),
  }),
  async execute(_id, params, signal) {
    return result(await kdj(["peek", params.source, ...flags({ at: params.at, every: params.every, width: params.width })], signal));
  },
});

const align = defineTool({
  name: "kdj_align",
  label: "对齐",
  description: "kdj align：把视频对齐到参考曲，返回定位表 plans。auto=false 的方案需要用户试听确认。",
  parameters: Type.Object({
    ref: Type.String({ description: "参考曲：曲库 id 或文件路径" }),
    video: Type.String({ description: "视频：曲库 id、文件路径、bilibili ref 或链接" }),
  }),
  async execute(_id, params, signal) {
    return result(await kdj(["align", ...flags({ ref: params.ref, video: params.video })], signal));
  },
});

/**
 * The only way to ask the listener anything: a question with a few choices, shown as a bubble at
 * the bottom right of the KDJ window, with a countdown when `timeout` is given — when it runs
 * out, `default` is taken.
 */
/**
 * The question is drawn by the KDJ window from this call's partial result (the songs with their
 * covers); the answer comes back through an editor dialog titled `kdj:ask:<call id>`, as JSON
 * `{ choices, note }`.
 */
const askUser = defineTool({
  name: "ask_user",
  label: "询问",
  description: "需要用户决定时调用：KDJ 右下角弹出一句问题，可以给文字选项（options），也可以给歌曲选项（songs：kdj_search 给出的 ref，显示封面、歌名、艺术家和来源），multiple 允许多选。用户还可以写一句补充（note），要照着做。给了 timeout（秒）就显示倒计时，到时没选则按 default。返回 choices（选中的选项文字或 ref）和 note；用户关掉则 choices 为空。",
  parameters: Type.Object({
    question: Type.String(),
    options: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
    songs: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "kdj_search 给出的 ref" })),
    multiple: Type.Optional(Type.Boolean()),
    default: Type.Optional(Type.Array(Type.String(), { description: "选项文字或 ref" })),
    timeout: Type.Optional(Type.Integer({ minimum: 3, maximum: 300 })),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const asked = {
      question: params.question,
      options: params.options ?? [],
      songs: (params.songs ?? []).map(ref => songs.get(ref) ?? { ref, title: ref, artists: [], platform: ref.split(":")[0], cover: "", duration: null }),
      multiple: params.multiple ?? false,
      defaults: params.default ?? [],
      timeout: params.timeout ?? 0,
    };
    onUpdate?.({ content: [{ type: "text", text: "等待用户回答" }], details: asked });
    const timeout = params.timeout ? params.timeout * 1000 : undefined;
    const reply = await ctx.ui.editor(`kdj:ask:${id}`, "", { signal, timeout });
    let answer: { choices?: unknown; note?: unknown } = {};
    try { answer = reply ? JSON.parse(reply) : {}; } catch { answer = { note: reply }; }
    const choices = Array.isArray(answer.choices) ? answer.choices.filter((item): item is string => typeof item === "string") : [];
    const note = typeof answer.note === "string" && answer.note.trim() ? answer.note.trim() : null;
    if (reply === undefined && timeout) return result({ choices: asked.defaults, note: null, timedOut: true });
    return result({ choices, note });
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
}
