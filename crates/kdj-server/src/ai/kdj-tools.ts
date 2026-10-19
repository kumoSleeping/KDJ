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
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
    return result(await kdj(["search", params.text, ...flags({ kind: params.kind, platform: params.platforms, limit: params.limit })], signal));
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
const askUser = defineTool({
  name: "ask_user",
  label: "询问",
  description: "需要用户决定时调用：在 KDJ 右下角弹出一句问题和 2 到 4 个简短选项。给了 timeout（秒）就显示倒计时，到时没选则按 default（必须是选项之一）。返回 choice：用户选的选项；用户关掉为 null。",
  parameters: Type.Object({
    question: Type.String(),
    options: Type.Array(Type.String(), { minItems: 2, maxItems: 4 }),
    default: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Integer({ minimum: 3, maximum: 120 })),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const timeout = params.timeout ? params.timeout * 1000 : undefined;
    const choice = await ctx.ui.select(params.question, params.options, { signal, timeout });
    const fallback = timeout && params.default && params.options.includes(params.default) ? params.default : null;
    return result({ choice: choice ?? fallback });
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
  for (const tool of [status, search, download, login, libraryList, libraryGet, peek, align, play, askUser]) {
    pi.registerTool(tool);
  }
  registerWeb(pi);
}
