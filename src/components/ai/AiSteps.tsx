/**
 * One step per tool pi called, drawn as it happens (docs/ai-dock.md). The tools are the KDJ CLI's
 * commands (`kdj_search` = `kdj search`, …) and the browser's; `details` of a result is the
 * command's own JSON, so a search shows its rows and a download its progress and outcome.
 */
import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Download,
  Globe,
  Info,
  Library,
  LoaderCircle,
  LogIn,
  MousePointerClick,
  ScanEye,
  Search,
  Type,
  Waypoints,
  Wrench,
  X,
} from "lucide-react";
import { formatDuration } from "../../lib/format";
import type { AiToolStep } from "../../types/ai";
import type { Platform } from "../../types";
import { PlatformMark } from "../download/PlatformMark";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => (value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {});
const list = (value: unknown): Fields[] => (Array.isArray(value) ? value.map(fields) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const PLATFORMS = new Set<string>(["wyy", "qqm", "soundcloud", "ytm", "youtube", "bilibili", "local"]);
const platformOf = (value: unknown): Platform | null => (PLATFORMS.has(str(value)) ? str(value) as Platform : null);
const platformName = (value: unknown): string => {
  const platform = platformOf(value);
  return platform ? PLATFORM_LABEL[platform] : str(value);
};

const KIND_NAMES: Record<string, string> = {
  playlist: "歌单",
  album: "专辑",
  artist: "歌手",
  radio: "电台",
  mine: "我的歌单",
  video: "视频",
};

/** Rows shown before the rest are folded behind "+N". */
const ROWS_SHOWN = 5;

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

interface StepFace {
  icon: ReactNode;
  title: string;
  facts: string[];
  body?: ReactNode;
  /** The body is open from the start (rows the listener came for). */
  open?: boolean;
}

/** A song, video or collection row of `kdj search` / `kdj library`. */
function ResultRow({ item }: { item: Fields }) {
  const platform = platformOf(item.platform);
  const kind = str(item.type);
  const artists = Array.isArray(item.artists) ? item.artists.map(str).filter(Boolean).join(" / ") : str(item.artist) || str(item.subtitle);
  const duration = num(item.duration);
  const extra = kind && kind !== "song" ? KIND_NAMES[kind] ?? kind : "";
  const alternatives = Array.isArray(item.alternatives) ? item.alternatives.length : 0;
  const count = num(item.count);
  const bpm = num(item.bpm);
  const key = str(item.key);
  const tail = duration !== null ? formatDuration(duration)
    : count !== null ? `${count} 首`
      : bpm !== null ? `${Math.round(bpm)}${key ? ` · ${key}` : ""}` : "";
  return <li className="kd-ai-row">
    <span className="kd-ai-row-mark">{platform ? <PlatformMark id={platform} size={12} branded /> : null}</span>
    <span className="kd-ai-row-copy">
      <span className="kd-ai-row-title" title={str(item.title)}>{str(item.title) || str(item.ref)}</span>
      {(artists || extra) && <span className="kd-ai-row-sub">{[extra, artists].filter(Boolean).join(" · ")}</span>}
    </span>
    {alternatives > 0 && <span className="kd-ai-row-tail" title={`另有 ${alternatives} 个来源`}>+{alternatives}</span>}
    {tail && <span className="kd-ai-row-tail">{tail}</span>}
  </li>;
}

function Rows({ items }: { items: Fields[] }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, ROWS_SHOWN);
  return <>
    <ul className="kd-ai-rows">{shown.map((item, index) => <ResultRow key={str(item.ref) || index} item={item} />)}</ul>
    {items.length > shown.length && <button type="button" className="kd-ai-more" onClick={() => setAll(true)}>
      +{items.length - shown.length}
    </button>}
  </>;
}

function PlatformErrors({ errors }: { errors: unknown }) {
  const entries = Object.entries(fields(errors)).filter(([, message]) => str(message));
  if (entries.length === 0) return null;
  return <ul className="kd-ai-errors">
    {entries.map(([platform, message]) => <li key={platform}>{platformName(platform)}：{str(message)}</li>)}
  </ul>;
}

function Progress({ done, total }: { done: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  return <span className="kd-ai-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
    <i style={{ transform: `scaleX(${ratio})` }} />
  </span>;
}

function DownloadOutcome({ items }: { items: Fields[] }) {
  if (items.length === 0) return null;
  return <ul className="kd-ai-rows">
    {items.map((item, index) => {
      const state = str(item.state);
      const Mark = state === "done" ? Check : state === "failed" ? AlertTriangle : state === "canceled" ? X : LoaderCircle;
      return <li key={str(item.ref) || index} className="kd-ai-row" data-state={state}>
        <span className="kd-ai-row-mark"><Mark size={12} aria-hidden="true" /></span>
        <span className="kd-ai-row-copy">
          <span className="kd-ai-row-title" title={str(item.path) || undefined}>{str(item.title) || str(item.ref)}</span>
          {str(item.error) && <span className="kd-ai-row-sub" data-tone="error">{str(item.error)}</span>}
        </span>
      </li>;
    })}
  </ul>;
}

/** The text the model was given back, for a step that has nothing better to show. */
function textBody(text: string | undefined): ReactNode {
  return text ? <pre className="kd-ai-step-text">{text}</pre> : null;
}

function searchFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const items = list(data.items);
  const collections = list(data.collections).map(item => ({ ...item, type: str(item.type) || "playlist" }));
  const platforms = Array.isArray(args.platforms) ? args.platforms : Array.isArray(args.platform) ? args.platform : [];
  const kind = str(args.kind);
  const facts = [
    kind && kind !== "song" ? KIND_NAMES[kind] ?? kind : "",
    platforms.map(platformName).filter(Boolean).join(" "),
    step.state === "done" ? `${items.length + collections.length} 条` : "",
  ].filter(Boolean);
  const title = str(data.title);
  const rows = [...items, ...collections];
  return {
    icon: <Search size={14} aria-hidden="true" />,
    title: `搜索“${str(args.text)}”`,
    facts,
    open: true,
    body: step.state === "running" || (!title && rows.length === 0 && Object.keys(fields(data.errors)).length === 0) ? null : <>
      {title && <span className="kd-ai-step-caption">{title}</span>}
      <Rows items={rows} />
      <PlatformErrors errors={data.errors} />
    </>,
  };
}

function downloadFace(step: AiToolStep): StepFace {
  const { args } = step;
  const refs = Array.isArray(args.refs) ? args.refs : [];
  const partial = fields(step.partial);
  const data = fields(step.details);
  const items = list(data.items);
  const total = num(partial.total) ?? refs.length;
  const count = Math.max(refs.length, items.length);
  const done = num(partial.done) ?? 0;
  const facts = [
    str(args.as) === "audio" ? "仅音轨" : "",
    str(args.quality),
    num(args.height) !== null ? `${num(args.height)}p` : "",
    step.state === "running" && step.partial !== undefined && total > 0 ? `${done}/${total}` : "",
    step.state !== "running" && items.length > 0 ? `完成 ${items.filter(item => str(item.state) === "done").length}/${items.length}` : "",
  ].filter(Boolean);
  return {
    icon: <Download size={14} aria-hidden="true" />,
    title: count > 0 ? `下载 ${count} 项` : "下载",
    facts,
    open: true,
    body: step.state === "running"
      ? step.partial !== undefined ? <Progress done={done} total={total} /> : null
      : items.length > 0 ? <DownloadOutcome items={items} /> : null,
  };
}

function libraryFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const items = Array.isArray(data.items) ? list(data.items) : data.id !== undefined ? [data] : [];
  const query = [str(args.q), str(args.key), str(args.bpm) && `${str(args.bpm)} BPM`, str(args.folder) && hostOf(str(args.folder))]
    .filter(Boolean).join(" · ");
  return {
    icon: <Library size={14} aria-hidden="true" />,
    title: step.tool === "kdj_library_get" ? "读取曲目" : query ? `曲库“${query}”` : "曲库",
    facts: step.state === "done" && items.length > 0 ? [`${items.length} 首`] : [],
    open: true,
    body: step.state === "running" || items.length === 0 ? null : <Rows items={items} />,
  };
}

/** What a source argument names, short: a library id, a file's name, or a ref / link. */
function sourceName(value: unknown): string {
  const text = str(value);
  if (/^\d+$/.test(text)) return `#${text}`;
  if (/^https?:/i.test(text)) return hostOf(text);
  return text.split(/[\\/]/).pop() || text;
}

function peekFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const frames = list(data.frames);
  const failed = Array.isArray(data.failed) ? data.failed.length : 0;
  const sheet = str(fields(data.sheet).path);
  const at = str(args.at) || (num(args.every) !== null ? `每 ${num(args.every)} 秒` : "");
  return {
    icon: <ScanEye size={14} aria-hidden="true" />,
    title: `截帧 ${sourceName(args.source)}`,
    facts: [at, step.state === "done" ? `${frames.length} 张` : "", failed ? `${failed} 张失败` : ""].filter(Boolean),
    body: step.state === "done" ? textBody(sheet || str(data.dir)) : null,
  };
}

const EVIDENCE: Record<string, string> = { verified: "已核实", melody: "旋律候选", partial: "部分" };

function alignFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const plans = list(data.plans);
  const matched = data.matched === true;
  return {
    icon: <Waypoints size={14} aria-hidden="true" />,
    title: `对齐 ${sourceName(args.video)} → ${sourceName(args.ref)}`,
    facts: step.state === "done" ? [matched ? `${plans.length} 个方案` : "未对上"] : [],
    open: true,
    body: step.state !== "done" ? null : plans.length > 0
      ? <ul className="kd-ai-rows">{plans.map((plan, index) => {
        const offset = num(plan.offset), speed = num(plan.speed);
        return <li key={str(plan.id) || index} className="kd-ai-row">
          <span className="kd-ai-row-mark" />
          <span className="kd-ai-row-copy">
            <span className="kd-ai-row-title">{str(plan.label) || str(plan.id)}</span>
            <span className="kd-ai-row-sub">{[EVIDENCE[str(plan.evidence)] ?? str(plan.evidence), plan.auto === false ? "需试听" : ""].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="kd-ai-row-tail">{[offset !== null ? `${offset >= 0 ? "+" : ""}${offset.toFixed(2)}s` : "", speed !== null && speed !== 1 ? `×${speed.toFixed(3)}` : ""].filter(Boolean).join(" ")}</span>
        </li>;
      })}</ul>
      : textBody(str(data.reason) || str(data.note)),
  };
}

function browserFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const url = str(data.url) || str(args.url);
  const page = str(data.title);
  const action = step.tool.replace(/^browser_/, "");
  const face = (icon: ReactNode, title: string): StepFace => ({
    icon,
    title,
    facts: [page && page !== title ? page : "", url ? hostOf(url) : ""].filter(Boolean),
    body: textBody(step.state === "error" ? step.text ?? "" : ""),
  });
  switch (action) {
    case "search": {
      const results = list(data.results).map(result => ({ ...result, artists: [hostOf(str(result.url))] }));
      return { ...face(<Search size={14} aria-hidden="true" />, `网页搜索“${str(args.query) || str(args.text)}”`), open: true,
        body: results.length > 0 ? <Rows items={results} /> : face(null, "").body };
    }
    case "probe":
      return {
        icon: <Globe size={14} aria-hidden="true" />,
        title: "探测网络",
        facts: step.state !== "done" ? [] : data.google === true ? ["Google 可用"]
          : data.bing === true ? ["Google 不可用", "使用必应"] : ["Google、必应都无法访问"],
        body: textBody(step.state === "error" ? step.text : ""),
      };
    case "open":
      return face(<Globe size={14} aria-hidden="true" />, `打开 ${hostOf(str(args.url))}`);
    case "read":
      return face(<Globe size={14} aria-hidden="true" />, "读取页面");
    case "click":
      return face(<MousePointerClick size={14} aria-hidden="true" />, `点击 ${str(args.text) || str(args.ref)}`.trim());
    case "type":
      return face(<Type size={14} aria-hidden="true" />, `输入“${str(args.text)}”`);
    default:
      return face(<Globe size={14} aria-hidden="true" />, action);
  }
}

function faceOf(step: AiToolStep): StepFace {
  const { args } = step;
  switch (step.tool) {
    case "kdj_search":
      return searchFace(step);
    case "kdj_download":
      return downloadFace(step);
    case "kdj_library_list":
    case "kdj_library_get":
      return libraryFace(step);
    case "kdj_peek":
      return peekFace(step);
    case "kdj_align":
      return alignFace(step);
    case "kdj_status":
      return { icon: <Info size={14} aria-hidden="true" />, title: "读取 KDJ 状态", facts: [], body: textBody(step.text ?? "") };
    case "kdj_login": {
      const browser = str(args.browser);
      return {
        icon: <LogIn size={14} aria-hidden="true" />,
        title: `登录 ${platformName(args.platform)}`,
        facts: [browser ? `从 ${browser} 导入` : ""].filter(Boolean),
        body: textBody(step.state === "running" ? "" : step.text ?? ""),
      };
    }
    default:
      if (step.tool.startsWith("browser_")) return browserFace(step);
      return { icon: <Wrench size={14} aria-hidden="true" />, title: step.tool, facts: [], body: textBody(step.text ?? "") };
  }
}

export function AiStep({ step }: { step: AiToolStep }) {
  const face = faceOf(step);
  const [own, setOwn] = useState<boolean | null>(null);
  const open = own ?? (!!face.open || step.state === "error");
  // A failed step says why: the result text is the error.
  const body = step.state === "error" && !face.open ? textBody(step.text) : face.body;
  const hasBody = body != null && body !== false;
  const mark = step.state === "running"
    ? <LoaderCircle size={14} className="kd-spin" aria-hidden="true" />
    : step.state === "error" ? <AlertTriangle size={14} aria-hidden="true" /> : face.icon;
  return <div className="kd-ai-step" data-state={step.state} data-tool={step.tool}>
    <div className="kd-ai-step-head">
      <span className="kd-ai-step-mark">{mark}</span>
      <span className="kd-ai-step-title" title={face.title}>{face.title}</span>
      {face.facts.length > 0 && <span className="kd-ai-step-facts">{face.facts.join(" · ")}</span>}
      {hasBody && step.state !== "running" && <button type="button" className="kd-ai-key kd-ai-step-toggle"
        aria-expanded={open} aria-label={open ? "收起" : "展开"} title={open ? "收起" : "展开"} onClick={() => setOwn(!open)}>
        <ChevronsUpDown size={12} aria-hidden="true" />
      </button>}
    </div>
    {hasBody && (open || step.state === "running") && <div className="kd-ai-step-body">{body}</div>}
  </div>;
}
