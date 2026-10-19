/**
 * What each of pi's tool calls says while it runs (docs/ai-dock.md): one line for a bubble at the
 * top, where the search row is. Pure, so the window and the tests read the same thing.
 *
 * Downloads say nothing here — they are in the download list and its bubbles like any other —
 * nor does playing (the song's own bubble) or a question to the listener (its own bubble).
 */
export type AiNoticeIcon = "search" | "web" | "login" | "library" | "video" | "tool";

export interface AiNotice {
  icon: AiNoticeIcon;
  title: string;
  detail?: string;
  tone: "info" | "success" | "error";
}

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => (value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {});
const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

const PLATFORM_NAMES: Record<string, string> = {
  wyy: "网易云",
  qqm: "QQ 音乐",
  soundcloud: "SoundCloud",
  ytm: "YouTube Music",
  youtube: "YouTube",
  bilibili: "B站",
};

/** Tools that report elsewhere, or not at all. */
const SILENT = new Set(["kdj_download", "kdj_play", "kdj_status", "ask_user", "tell_user", "read", "write"]);

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function sourceName(value: unknown): string {
  const text = str(value);
  if (/^\d+$/.test(text)) return `#${text}`;
  if (/^https?:/i.test(text)) return hostOf(text);
  return text.split(/[\\/]/).pop() || text;
}

/** The running line of a tool, and the icon it keeps. */
function running(tool: string, args: Fields): Omit<AiNotice, "tone"> {
  switch (tool) {
    case "kdj_search":
      return { icon: "search", title: `AI 搜索“${str(args.text)}”` };
    case "kdj_login":
      return { icon: "login", title: `登录${PLATFORM_NAMES[str(args.platform)] ?? str(args.platform)}`, detail: args.browser ? undefined : "请扫屏幕上的二维码" };
    case "kdj_library_list":
      return { icon: "library", title: str(args.q) ? `查曲库“${str(args.q)}”` : "查曲库" };
    case "kdj_library_get":
      return { icon: "library", title: "读取曲目" };
    case "kdj_folders":
      return { icon: "library", title: str(args.query) ? `找文件夹“${str(args.query)}”` : "列出文件夹" };
    case "kdj_peek":
      return { icon: "video", title: `截帧 ${sourceName(args.source)}` };
    case "kdj_align":
      return { icon: "video", title: `对齐 ${sourceName(args.video)}` };
    // KDJ's own web tools (kdj-web.ts) and pi-web-access's.
    case "kdj_web_search":
    case "web_search": {
      const queries = Array.isArray(args.queries) ? args.queries.map(str).filter(Boolean) : [];
      return { icon: "web", title: `网页搜索“${str(args.query) || queries.join("、")}”` };
    }
    case "kdj_web_fetch":
    case "fetch_content": {
      const urls = Array.isArray(args.urls) ? args.urls.map(str).filter(Boolean) : [];
      const first = str(args.url) || urls[0] || "";
      return { icon: "web", title: `读取 ${hostOf(first)}${urls.length > 1 ? ` 等 ${urls.length} 个网页` : ""}` };
    }
    case "get_search_content":
      return { icon: "web", title: "读取搜索结果" };
    case "source_check":
      return { icon: "web", title: "核对来源" };
    // The video tools (kdj-video.ts).
    case "kdj_probe":
      return { icon: "video", title: `读取 ${sourceName(args.path)}` };
    case "kdj_ffmpeg":
      return { icon: "video", title: `渲染 ${sourceName(args.output)}` };
    case "kdj_remotion_render":
      return { icon: "video", title: `Remotion 渲染 ${sourceName(args.output)}` };
    case "kdj_project_save":
      return { icon: "video", title: `保存工程 ${sourceName(args.path)}` };
    case "kdj_project_render":
      return { icon: "video", title: `准备工程 ${sourceName(args.path)}` };
    case "kdj_project_export":
      return { icon: "video", title: `导出工程 ${sourceName(args.path)}` };
    case "kdj_visualizer_render":
      return { icon: "video", title: "渲染可视化" };
    default:
      return { icon: "tool", title: tool };
  }
}

/** What a finished tool found, as the bubble's second line. */
function outcome(tool: string, details: Fields): string | undefined {
  switch (tool) {
    case "kdj_search": {
      const found = count(details.items) + count(details.collections);
      return found ? `${found} 条结果` : "没有结果";
    }
    case "kdj_login":
      return "已登录";
    case "kdj_library_list":
      return `${count(details.items)} 首`;
    case "kdj_folders": {
      const first = fields(Array.isArray(details.folders) ? details.folders[0] : null);
      return count(details.folders) ? `${count(details.folders)} 个 · ${str(first.relative)}` : "没有找到";
    }
    case "kdj_peek":
      return `${count(details.frames)} 张`;
    case "kdj_align": {
      if (details.matched !== true) return "没有对上";
      // The first plan's stretches without picture, which the AI is to ask about.
      const first = fields(Array.isArray(details.plans) ? details.plans[0] : null);
      const gaps = Array.isArray(first.gaps) ? first.gaps.map(fields) : [];
      const open = gaps.reduce((sum, gap) => sum + (typeof gap.length === "number" ? gap.length : 0), 0);
      return [`${count(details.plans)} 个方案`, open >= 1 ? `空档 ${Math.round(open)} 秒` : ""].filter(Boolean).join(" · ");
    }
    case "kdj_web_search": {
      const engine = details.engine === "deepseek" ? "DeepSeek" : details.engine === "jina" ? "Jina" : "";
      return [engine, `${count(details.results)} 条`].filter(Boolean).join(" · ");
    }
    case "kdj_web_fetch":
      return str(details.title) || undefined;
    case "kdj_project_save": {
      const check = fields(details.check);
      if (details.problem) return str(details.problem).split("\n")[0];
      return typeof check.duration === "number" ? `${Math.round(check.duration)} 秒 · ${count(check.sources)} 个素材` : undefined;
    }
    case "kdj_project_export":
      return str(details.exported) ? sourceName(details.exported) : undefined;
    case "kdj_visualizer_render":
      return str(details.path) ? sourceName(details.path) : undefined;
    default:
      return undefined;
  }
}

/** The bubble of a tool call that has started; null for those that report elsewhere. */
export function noticeOnStart(tool: string, args: unknown): AiNotice | null {
  if (SILENT.has(tool)) return null;
  return { ...running(tool, fields(args)), tone: "info" };
}

/** The bubble of a tool call that has ended: what it found, or why it failed. */
export function noticeOnEnd(tool: string, args: unknown, details: unknown, failed: boolean, text: string): AiNotice | null {
  if (SILENT.has(tool) && !failed) return null;
  const base = running(tool, fields(args));
  if (failed) return { ...base, title: `${base.title} 失败`, detail: text.trim().split("\n")[0] || undefined, tone: "error" };
  return { ...base, detail: outcome(tool, fields(details)), tone: "success" };
}

/**
 * One step as the AI drawer lists it (任务 and 历史): every tool call, the ones that report
 * elsewhere too, in the words of its bubble where it has one.
 */
export function stepLine(tool: string, args: unknown, state: "running" | "done" | "failed", details: unknown, text: string): { title: string; detail?: string } {
  const a = fields(args);
  // The quiet tools have no words of their own in a bubble (a failure would only name the tool).
  const notice = SILENT.has(tool) ? null
    : state === "running" ? noticeOnStart(tool, args) : noticeOnEnd(tool, args, details, state === "failed", text);
  if (notice) return { title: notice.title, detail: notice.detail };
  const failure = state === "failed" ? text.trim().split("\n")[0] || undefined : undefined;
  const line = (title: string, detail?: string) => ({ title: failure ? `${title} 失败` : title, detail: failure ?? detail });
  switch (tool) {
    case "kdj_download": {
      const refs = Array.isArray(a.refs) ? a.refs.length : 0;
      return line(`下载 ${refs || ""} 项`.replace("  ", " "), str(a.to) ? sourceName(a.to) : undefined);
    }
    case "kdj_play":
      return line("播放");
    case "kdj_status":
      return line("查看 KDJ 的状态");
    case "ask_user": {
      const answer = fields(details);
      // A plan: its questions answered together, each as 问题：选了的.
      if (Array.isArray(a.questions)) {
        const answers = fields(answer.answers);
        const picked = a.questions.map(fields).map(item => {
          const chosen = answers[str(item.id)];
          return Array.isArray(chosen) && chosen.length ? `${str(item.question)}：${chosen.map(str).join("、")}` : "";
        }).filter(Boolean);
        return line(`方案：${str(a.question) || str(a.preview)}`, answer.cancelled === true ? "暂停了" : picked.join("；") || undefined);
      }
      const choices = answer.choices;
      return line(`询问：${str(a.question)}`, Array.isArray(choices) && choices.length ? `选了 ${choices.map(str).join("、")}` : undefined);
    }
    case "tell_user":
      // The whole message (a video task's report runs to several lines) below the step.
      return line("消息", str(a.message));
    case "read":
      return line(`读取 ${sourceName(a.path)}`);
    case "write":
      return line(`写入 ${sourceName(a.path)}`);
    default:
      return line(tool);
  }
}

/** The text blocks of a tool result (`{ content: [{ type: "text", text }] }`). */
export function resultText(result: unknown): string {
  const content = fields(result).content;
  if (!Array.isArray(content)) return "";
  return content.map(block => fields(block).type === "text" ? str(fields(block).text) : "").filter(Boolean).join("\n");
}
