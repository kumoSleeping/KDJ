/**
 * One card per tool pi called, drawn as it happens (docs/ai-dock.md). The tools are the KDJ CLI's
 * commands (`kdj_search` = `kdj search`, …), the window's own `kdj_play` and the browser's;
 * `details` of a result is the command's own JSON.
 *
 * What the listener came for moves with the window: found rows arrive with the list's own
 * gesture (listArrival.ts), a download shows the very tasks of the download list with their live
 * progress, and a song that plays here shows the playing mark.
 */
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  Play,
  ScanEye,
  Search,
  Type,
  Waypoints,
  Wrench,
  X,
} from "lucide-react";
import { playLibraryTrack } from "../../lib/aiPlay";
import { api } from "../../lib/api";
import { formatDuration, thumbUrl } from "../../lib/format";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { AiToolStep } from "../../types/ai";
import type { DownloadTask, Platform } from "../../types";
import { AnalysisGlyph } from "../chrome/ActivityRail";
import { createListArrival } from "../common/listArrival";
import { VinylPlaceholder } from "../common/VinylPlaceholder";
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
const ROWS_SHOWN = 6;

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The id of the track playing now, kept current. */
function usePlayingId(): number | null {
  return useSyncExternalStore(subscribePlayingTrack, () => getPlayingTrack()?.id ?? null, () => null);
}

/** Rows of a card arrive with the list's gesture once they are there, inside the log's scroller. */
function useRowsArrival(count: number) {
  const box = useRef<HTMLUListElement>(null);
  const presented = useRef(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || count <= presented.current) return;
    const scroller = element.closest<HTMLElement>(".kd-ai-log");
    if (!scroller) return;
    const fresh = [...element.querySelectorAll<HTMLElement>(":scope > .kd-list-row")].slice(presented.current);
    presented.current = count;
    const arrival = createListArrival(scroller);
    // After the log has followed its end: the gesture lets go when its scroller moves.
    const frame = requestAnimationFrame(() => arrival.present(fresh));
    return () => { cancelAnimationFrame(frame); };
  }, [count]);
  return box;
}

function Cover({ urls, platform }: { urls: string[]; platform?: Platform | null }) {
  const [at, setAt] = useState(0);
  const url = urls[at];
  return <span className="kd-thumb kd-ai-thumb">
    {url ? <img src={url} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setAt(at + 1)} />
      : platform ? <span className="kd-ai-thumb-mark"><PlatformMark id={platform} size={13} branded /></span>
        : <VinylPlaceholder />}
  </span>;
}

function PlayKey({ trackId, title }: { trackId: number; title: string }) {
  const playing = usePlayingId() === trackId;
  return playing
    ? <span className="kd-ai-row-playing" role="img" aria-label="正在播放"><AnalysisGlyph /></span>
    : <button type="button" className="kd-ai-key kd-ai-row-play" aria-label={`播放 ${title}`} title="播放"
      onClick={() => void playLibraryTrack(trackId)}>
      <Play size={12} fill="currentColor" aria-hidden="true" />
    </button>;
}

interface RowFace {
  key: string;
  covers: string[];
  platform?: Platform | null;
  title: string;
  sub: string;
  tail?: string;
  trackId?: number | null;
  state?: string;
  progress?: number | null;
  error?: string;
}

function Row({ row }: { row: RowFace }) {
  const Mark = row.state === "done" ? Check : row.state === "failed" ? AlertTriangle : row.state === "canceled" ? X : null;
  return <li className="kd-list-row kd-ai-row" data-state={row.state}>
    <Cover urls={row.covers} platform={row.platform} />
    <span className="kd-ai-row-copy">
      <span className="kd-ai-row-title" title={row.title}>{row.title}</span>
      {(row.sub || row.error) && <span className="kd-ai-row-sub" data-tone={row.error ? "error" : undefined}>{row.error || row.sub}</span>}
      {row.progress != null && <span className="kd-ai-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(row.progress * 100)}><i style={{ transform: `scaleX(${row.progress})` }} /></span>}
    </span>
    {row.tail && <span className="kd-ai-row-tail">{row.tail}</span>}
    {row.platform && row.covers.length > 0 && <span className="kd-ai-row-source" role="img" aria-label={platformName(row.platform)}>
      <PlatformMark id={row.platform} size={11} branded />
    </span>}
    {Mark && <span className="kd-ai-row-mark" data-kd-motion="pop"><Mark size={13} aria-hidden="true" /></span>}
    {row.state === "running" && <LoaderCircle size={13} className="kd-spin kd-ai-row-mark" aria-hidden="true" />}
    {row.trackId != null && row.trackId > 0 && row.state !== "running" && <PlayKey trackId={row.trackId} title={row.title} />}
  </li>;
}

function Rows({ rows }: { rows: RowFace[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);
  const box = useRowsArrival(shown.length);
  if (rows.length === 0) return null;
  return <>
    <ul ref={box} className="kd-ai-rows">{shown.map(row => <Row key={row.key} row={row} />)}</ul>
    {rows.length > shown.length && <button type="button" className="kd-ai-more" onClick={() => setAll(true)}>
      +{rows.length - shown.length}
    </button>}
  </>;
}

/** A song, video or collection of `kdj search`. */
function searchRow(item: Fields, index: number): RowFace {
  const kind = str(item.type);
  const artists = Array.isArray(item.artists) ? item.artists.map(str).filter(Boolean).join(" / ") : str(item.subtitle);
  const duration = num(item.duration);
  const count = num(item.count);
  const alternatives = Array.isArray(item.alternatives) ? item.alternatives.length : 0;
  const cover = str(item.cover);
  return {
    key: str(item.ref) || String(index),
    covers: cover ? [thumbUrl(cover, 96), cover] : [],
    platform: platformOf(item.platform),
    title: str(item.title) || str(item.ref),
    sub: [kind && kind !== "song" ? KIND_NAMES[kind] ?? kind : "", artists, alternatives ? `另有 ${alternatives} 个来源` : ""].filter(Boolean).join(" · "),
    tail: duration !== null ? formatDuration(duration) : count !== null ? `${count} 首` : undefined,
  };
}

/** A track of `kdj library list|get`. */
function libraryRow(item: Fields, index: number): RowFace {
  const id = num(item.id);
  const bpm = num(item.bpm);
  const key = str(item.key);
  return {
    key: id !== null ? String(id) : String(index),
    covers: id !== null ? [api.coverUrl(id, undefined, 96)] : [],
    title: str(item.title) || str(item.path),
    sub: str(item.artist),
    tail: bpm !== null ? `${Math.round(bpm)}${key ? ` · ${key}` : ""}` : undefined,
    trackId: id,
  };
}

function PlatformErrors({ errors }: { errors: unknown }) {
  const entries = Object.entries(fields(errors)).filter(([, message]) => str(message));
  if (entries.length === 0) return null;
  return <ul className="kd-ai-errors">
    {entries.map(([platform, message]) => <li key={platform}>{platformName(platform)}：{str(message)}</li>)}
  </ul>;
}

/** The text the model was given back, for a card that has nothing better to show. */
function textBody(text: string | undefined): ReactNode {
  return text ? <pre className="kd-ai-step-text">{text}</pre> : null;
}

/** What a source argument names, short: a library id, a file's name, or a ref / link. */
function sourceName(value: unknown): string {
  const text = str(value);
  if (/^\d+$/.test(text)) return `#${text}`;
  if (/^https?:/i.test(text)) return hostOf(text);
  return text.split(/[\\/]/).pop() || text;
}

interface StepFace {
  icon: ReactNode;
  title: string;
  facts: string[];
  body?: ReactNode;
  /** The body is open from the start (rows the listener came for). */
  open?: boolean;
}

function searchFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const rows = [...list(data.items), ...list(data.collections).map(item => ({ ...item, type: str(item.type) || "playlist" }))];
  const platforms = Array.isArray(args.platforms) ? args.platforms : [];
  const kind = str(args.kind);
  const title = str(data.title);
  return {
    icon: <Search size={14} aria-hidden="true" />,
    title: `搜索“${str(args.text)}”`,
    facts: [
      kind && kind !== "song" ? KIND_NAMES[kind] ?? kind : "",
      platforms.map(platformName).filter(Boolean).join(" "),
      step.state === "done" ? `${rows.length} 条` : "",
    ].filter(Boolean),
    open: true,
    body: step.state === "running" || (!title && rows.length === 0 && Object.keys(fields(data.errors)).length === 0) ? null : <>
      {title && <span className="kd-ai-step-caption">{title}</span>}
      <Rows rows={rows.map(searchRow)} />
      <PlatformErrors errors={data.errors} />
    </>,
  };
}

/** `wyy:123`, `bilibili:BV…:p2`: the task's own `platform:source_key`, page left off. */
function songRef(ref: string): string {
  return ref.replace(/:p\d+$/, "");
}

/**
 * A download, drawn from the download list's own tasks: those this step started (its refs, or for
 * a collection every task of that platform), from when it started. Their progress is the list's.
 */
function DownloadBody({ step }: { step: AiToolStep }) {
  const tasks = useDownloadStore(state => state.tasks);
  const refs = useMemo(() => (Array.isArray(step.args.refs) ? step.args.refs.map(str) : []), [step.args.refs]);
  const outcome = useMemo(() => list(fields(step.details).items), [step.details]);
  const mine = useMemo(() => {
    const since = (step.startedAt ?? 0) / 1000 - 2;
    const songs = new Set(refs.map(songRef));
    const collections = new Set(refs.filter(ref => ref.split(":").length === 3 && !/:p\d+$/.test(ref)).map(ref => ref.split(":")[0]));
    return [...tasks.values()]
      .filter(task => task.created_at >= since && !task.id.startsWith("local:"))
      .filter(task => songs.has(`${task.platform}:${task.source_key ?? ""}`) || collections.has(task.platform))
      .sort((a, b) => a.created_at - b.created_at);
  }, [tasks, refs, step.startedAt]);
  const rows: RowFace[] = mine.length > 0 ? mine.map((task: DownloadTask) => {
    const finished = outcome.find(item => songRef(str(item.ref)) === `${task.platform}:${task.source_key ?? ""}`);
    const state = task.state === "done" ? "done" : task.state === "failed" ? "failed" : task.state === "canceled" ? "canceled" : "running";
    return {
      key: task.id,
      covers: [task.cover ? thumbUrl(task.cover, 96) : "", task.track_id ? api.coverUrl(task.track_id, undefined, 96) : ""].filter(Boolean),
      platform: task.platform,
      title: task.title || `${task.platform}:${task.source_key}`,
      sub: task.artist,
      state,
      progress: state === "running" ? Math.min(1, Math.max(0, task.progress)) : null,
      error: state === "failed" ? task.error || str(finished?.error) : undefined,
      trackId: task.track_id ?? num(finished?.track_id),
    };
  }) : outcome.map((item, index) => ({
    key: str(item.ref) || String(index),
    covers: num(item.track_id) ? [api.coverUrl(num(item.track_id)!, undefined, 96)] : [],
    title: str(item.title) || str(item.ref),
    sub: "",
    state: str(item.state),
    error: str(item.error) || undefined,
    trackId: num(item.track_id),
  }));
  const partial = fields(step.partial);
  return <>
    {rows.length === 0 && step.state === "running" && num(partial.total) !== null && <span className="kd-ai-progress" role="progressbar">
      <i style={{ transform: `scaleX(${Math.min(1, (num(partial.done) ?? 0) / Math.max(1, num(partial.total) ?? 1))})` }} />
    </span>}
    <Rows rows={rows} />
  </>;
}

function downloadFace(step: AiToolStep): StepFace {
  const { args } = step;
  const refs = Array.isArray(args.refs) ? args.refs : [];
  const partial = fields(step.partial);
  const items = list(fields(step.details).items);
  const count = Math.max(refs.length, items.length, num(partial.total) ?? 0);
  return {
    icon: <Download size={14} aria-hidden="true" />,
    title: count > 0 ? `下载 ${count} 项` : "下载",
    facts: [
      str(args.as) === "audio" ? "仅音轨" : "",
      str(args.quality),
      num(args.height) !== null ? `${num(args.height)}p` : "",
      step.state === "running" && num(partial.total) !== null ? `${num(partial.done) ?? 0}/${num(partial.total)}` : "",
      step.state !== "running" && items.length > 0 ? `完成 ${items.filter(item => str(item.state) === "done").length}/${items.length}` : "",
    ].filter(Boolean),
    open: true,
    body: <DownloadBody step={step} />,
  };
}

function libraryFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const items = Array.isArray(data.items) ? list(data.items) : data.id !== undefined ? [data] : [];
  const query = [str(args.q), str(args.key), str(args.bpm) && `${str(args.bpm)} BPM`, str(args.folder) && sourceName(args.folder)]
    .filter(Boolean).join(" · ");
  return {
    icon: <Library size={14} aria-hidden="true" />,
    title: step.tool === "kdj_library_get" ? "读取曲目" : query ? `曲库“${query}”` : "曲库",
    facts: step.state === "done" && items.length > 0 ? [`${items.length} 首`] : [],
    open: true,
    body: step.state === "running" || items.length === 0 ? null : <Rows rows={items.map(libraryRow)} />,
  };
}

/** `kdj_play`: the window plays the track as the call goes by; the card shows it, and the playing mark while it plays. */
function PlayBody({ trackId }: { trackId: number }) {
  const summary = useLibraryStore(state => state.summaryById.get(trackId));
  const [fetched, setFetched] = useState<{ title: string; artist: string } | null>(null);
  useLayoutEffect(() => {
    if (summary || trackId <= 0) return;
    let live = true;
    void api.trackSummaries([trackId]).then(([found]) => { if (live && found) setFetched({ title: found.title, artist: found.artist }); }).catch(() => undefined);
    return () => { live = false; };
  }, [summary, trackId]);
  const title = summary?.title ?? fetched?.title ?? `#${trackId}`;
  return <ul className="kd-ai-rows kd-ai-play">
    <Row row={{ key: String(trackId), covers: [api.coverUrl(trackId, summary?.modified_at, 192)], title, sub: summary?.artist ?? fetched?.artist ?? "", trackId }} />
  </ul>;
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
    body: textBody(step.state === "error" ? step.text : ""),
  });
  switch (action) {
    case "probe":
      return {
        icon: <Globe size={14} aria-hidden="true" />,
        title: "探测网络",
        facts: step.state !== "done" ? [] : data.google === true ? ["Google 可用"]
          : data.bing === true ? ["Google 不可用", "使用必应"] : ["Google、必应都无法访问"],
        body: textBody(step.state === "error" ? step.text : ""),
      };
    case "search": {
      const results = list(data.results).map((result, index): RowFace => ({
        key: str(result.url) || String(index),
        covers: [],
        title: str(result.title),
        sub: [hostOf(str(result.url)), str(result.snippet)].filter(Boolean).join(" · "),
      }));
      return {
        ...face(<Search size={14} aria-hidden="true" />, `网页搜索“${str(args.query) || str(args.text)}”`),
        facts: [str(data.engine) === "google" ? "Google" : str(data.engine) === "bing" ? "必应" : "", results.length ? `${results.length} 条` : ""].filter(Boolean),
        open: true,
        body: results.length > 0 ? <Rows rows={results} /> : textBody(step.state === "error" ? step.text : ""),
      };
    }
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

function peekFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const frames = list(data.frames);
  const failed = Array.isArray(data.failed) ? data.failed.length : 0;
  const at = str(args.at) || (num(args.every) !== null ? `每 ${num(args.every)} 秒` : "");
  return {
    icon: <ScanEye size={14} aria-hidden="true" />,
    title: `截帧 ${sourceName(args.source)}`,
    facts: [at, step.state === "done" ? `${frames.length} 张` : "", failed ? `${failed} 张失败` : ""].filter(Boolean),
    body: step.state === "done" ? textBody(str(fields(data.sheet).path) || str(data.dir)) : null,
  };
}

const EVIDENCE: Record<string, string> = { verified: "已核实", melody: "旋律候选", partial: "部分" };

function alignFace(step: AiToolStep): StepFace {
  const { args } = step;
  const data = fields(step.details);
  const plans = list(data.plans);
  return {
    icon: <Waypoints size={14} aria-hidden="true" />,
    title: `对齐 ${sourceName(args.video)} → ${sourceName(args.ref)}`,
    facts: step.state === "done" ? [data.matched === true ? `${plans.length} 个方案` : "未对上"] : [],
    open: true,
    body: step.state !== "done" ? null : plans.length > 0
      ? <Rows rows={plans.map((plan, index): RowFace => {
        const offset = num(plan.offset), speed = num(plan.speed);
        return {
          key: str(plan.id) || String(index),
          covers: [],
          title: str(plan.label) || str(plan.id),
          sub: [EVIDENCE[str(plan.evidence)] ?? str(plan.evidence), plan.auto === false ? "需试听" : ""].filter(Boolean).join(" · "),
          tail: [offset !== null ? `${offset >= 0 ? "+" : ""}${offset.toFixed(2)}s` : "", speed !== null && speed !== 1 ? `×${speed.toFixed(3)}` : ""].filter(Boolean).join(" "),
        };
      })} />
      : textBody(str(data.reason) || str(data.note)),
  };
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
    case "kdj_play": {
      const trackId = num(args.track_id) ?? 0;
      return { icon: <Play size={14} aria-hidden="true" />, title: "播放", facts: [], open: true, body: trackId > 0 ? <PlayBody trackId={trackId} /> : null };
    }
    case "kdj_peek":
      return peekFace(step);
    case "kdj_align":
      return alignFace(step);
    case "kdj_status":
      return { icon: <Info size={14} aria-hidden="true" />, title: "读取 KDJ 状态", facts: [], body: textBody(step.text) };
    case "kdj_login": {
      const browser = str(args.browser);
      return {
        icon: <LogIn size={14} aria-hidden="true" />,
        title: `登录 ${platformName(args.platform)}`,
        facts: [browser ? `从 ${browser} 导入` : "", step.state === "running" && !browser ? "请扫屏幕上的二维码" : ""].filter(Boolean),
        body: textBody(step.state === "running" ? "" : step.text),
      };
    }
    default:
      if (step.tool.startsWith("browser_")) return browserFace(step);
      return { icon: <Wrench size={14} aria-hidden="true" />, title: step.tool, facts: [], body: textBody(step.text) };
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
  return <div className="kd-ai-step" data-state={step.state} data-tool={step.tool} data-kd-motion="fade">
    <div className="kd-ai-step-head">
      <span className="kd-ai-step-mark">{mark}</span>
      <span className="kd-ai-step-title" title={face.title}>{face.title}</span>
      {face.facts.length > 0 && <span className="kd-ai-step-facts">{face.facts.join(" · ")}</span>}
      {hasBody && !face.open && <button type="button" className="kd-ai-key kd-ai-step-toggle"
        aria-expanded={open} aria-label={open ? "收起" : "展开"} title={open ? "收起" : "展开"} onClick={() => setOwn(!open)}>
        <ChevronsUpDown size={12} aria-hidden="true" />
      </button>}
    </div>
    {hasBody && open && <div className="kd-ai-step-body">{body}</div>}
  </div>;
}
