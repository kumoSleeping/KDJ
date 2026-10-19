/**
 * A plan from the AI (ask_user's `body`, docs/ai-dock.md "方案"): Markdown with three tags in it,
 * drawn by the window — the model writes text and names things, it never draws them:
 *
 * - `<choice q="id" value="v">label</choice>`: a key; pressing it picks `v` for question `id`.
 * - `<media q="id" ref="ref"/>`: a card for a song or video a search or the library gave (cover,
 *   title, source, length, a key that opens it); with `q`, pressing the card picks its ref.
 * - `<shot src="frame">caption</shot>`: a frame kdj_peek cut, shown as the evidence for a choice.
 *
 * The Markdown is the part a plan or a message needs: headings, lists, paragraphs, quotes,
 * tables, fenced code, **bold**, *italic*, ~~struck~~, `code` and links; a rule (---) is left out,
 * as the window draws no lines. Everything is built as elements; no markup from the model
 * reaches the page.
 *
 * A frame shows small; pressing it opens it to the bubble's width where it stands, and pressing
 * it again puts it back — no window of its own.
 */
import { useState, type ReactNode } from "react";
import { Check, ExternalLink, Music, Video } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { formatDuration, thumbUrl } from "../../lib/format";
import type { Platform } from "../../types";
import { VinylPlaceholder } from "../common/VinylPlaceholder";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { PlatformMark } from "../download/PlatformMark";

export interface PlanMedia { ref: string; title: string; artists: string[]; platform: string; cover: string; duration: number | null; kind?: string }

export interface PlanProps {
  body: string;
  media: Readonly<Record<string, PlanMedia>>;
  shots: Readonly<Record<string, string>>;
  picked: Readonly<Record<string, ReadonlySet<string>>>;
  onPick(question: string, value: string): void;
}

const attrsOf = (raw: string): Record<string, string> =>
  Object.fromEntries([...raw.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));

/** Where an online ref can be opened; library rows open nowhere. */
function linkOf(ref: string): string | null {
  const [platform, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (!id) return null;
  if (platform === "bilibili") return `https://www.bilibili.com/video/${id}`;
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${id}`;
  if (platform === "ytm") return `https://music.youtube.com/watch?v=${id}`;
  if (/^https?:\/\//.test(ref)) return ref;
  return null;
}

function openLink(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  void getBridge().openExternal?.(url).catch(() => undefined);
}

function MediaCover({ item }: { item: PlanMedia }) {
  const [failed, setFailed] = useState(false);
  const library = item.ref.startsWith("library:") ? Number(item.ref.slice("library:".length)) : null;
  const src = library !== null && Number.isFinite(library) ? api.coverUrl(library, undefined, 128) : item.cover ? thumbUrl(item.cover, 128) : "";
  return <span className="kd-ai-media-cover">
    {src && !failed
      ? <img src={src} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : item.kind === "video" ? <Video size={16} aria-hidden="true" /> : <VinylPlaceholder />}
  </span>;
}

function MediaCard({ refId, question, item, picked, onPick }: {
  refId: string; question?: string; item?: PlanMedia; picked: boolean; onPick(question: string, value: string): void;
}) {
  if (!item) return null;
  const platform = item.platform in PLATFORM_LABEL ? item.platform as Platform : null;
  const sub = [platform ? PLATFORM_LABEL[platform] : item.platform === "library" ? "曲库" : "", item.artists.join(" / "),
    item.duration ? formatDuration(item.duration) : ""].filter(Boolean).join(" · ");
  const link = linkOf(refId);
  const copy = <>
    <MediaCover item={item} />
    <span className="kd-ai-media-copy">
      <span className="kd-ai-media-title" title={item.title}>{item.title}</span>
      <span className="kd-ai-media-sub">
        {platform ? <PlatformMark id={platform} size={11} branded /> : item.platform === "library" ? <Music size={11} aria-hidden="true" /> : null}
        {sub}
      </span>
    </span>
  </>;
  return <span className="kd-ai-media" data-picked={picked || undefined}>
    {question
      ? <button type="button" className="kd-ai-media-main" aria-pressed={picked} onClick={() => onPick(question, refId)}>
          {copy}
          <span className="kd-ai-media-mark" aria-hidden="true">{picked && <Check size={14} />}</span>
        </button>
      : <span className="kd-ai-media-main">{copy}</span>}
    {link && <button type="button" className="kd-ai-media-open" title="打开" aria-label={`打开 ${item.title}`} onClick={() => openLink(link)}>
      <ExternalLink size={13} aria-hidden="true" />
    </button>}
  </span>;
}

function Shot({ src, caption, picture }: { src: string; caption: string; picture?: string }) {
  const [open, setOpen] = useState(false);
  if (!picture) return caption ? <span className="kd-ai-shot-missing">{caption}</span> : null;
  return <figure className="kd-ai-shot" data-open={open || undefined}>
    <button type="button" className="kd-ai-shot-key" aria-expanded={open} title={open ? "缩小" : "放大"}
      aria-label={`${open ? "缩小" : "放大"}${caption ? `：${caption}` : "截图"}`} onClick={() => setOpen(value => !value)}>
      <img src={picture} alt={caption || "截图"} draggable={false} data-src={src} />
    </button>
    {caption && <figcaption>{caption}</figcaption>}
  </figure>;
}

/** Bold, italic, code, links and the three tags inside one block of text. */
const INLINE = /(<choice\b[^>]*>[\s\S]*?<\/choice>)|(<media\b[^>]*\/?>(?:<\/media>)?)|(<shot\b[^>]*>[\s\S]*?<\/shot>|<shot\b[^>]*\/>)|\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*\s][^*]*)\*|~~([^~]+)~~/g;

function inline(text: string, props: PlanProps, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > at) out.push(text.slice(at, index));
    const k = `${key}-${n++}`;
    if (match[1]) {
      const head = /<choice\b([^>]*)>([\s\S]*?)<\/choice>/.exec(match[1]);
      const a = attrsOf(head?.[1] ?? "");
      const label = (head?.[2] ?? "").trim() || a.value || "";
      const value = a.value || label;
      const on = Boolean(a.q && props.picked[a.q]?.has(value));
      out.push(a.q
        ? <button key={k} type="button" className="kd-ai-choice" aria-pressed={on} onClick={() => props.onPick(a.q, value)}>
            {on && <Check size={12} aria-hidden="true" />}{label}
          </button>
        : <span key={k} className="kd-ai-choice" data-static="">{label}</span>);
    } else if (match[2]) {
      const a = attrsOf(match[2]);
      out.push(<MediaCard key={k} refId={a.ref ?? ""} question={a.q} item={props.media[a.ref ?? ""]}
        picked={Boolean(a.q && props.picked[a.q]?.has(a.ref ?? ""))} onPick={props.onPick} />);
    } else if (match[3]) {
      const head = /<shot\b([^>]*?)\/?>(?:([\s\S]*?)<\/shot>)?/.exec(match[3]);
      const a = attrsOf(head?.[1] ?? "");
      out.push(<Shot key={k} src={a.src ?? ""} caption={(head?.[2] ?? "").trim()} picture={props.shots[a.src ?? ""]} />);
    } else if (match[4]) out.push(<strong key={k}>{match[4]}</strong>);
    else if (match[5]) out.push(<code key={k}>{match[5]}</code>);
    else if (match[6] && match[7]) {
      const url = match[7];
      out.push(<a key={k} href={url} onClick={event => { event.preventDefault(); openLink(url); }}>{match[6]}</a>);
    } else if (match[8]) out.push(<em key={k}>{match[8]}</em>);
    else if (match[9]) out.push(<del key={k}>{match[9]}</del>);
    at = index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "para"; lines: string[] };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

/**
 * Lines into blocks: a heading, a run of list items, a quote, a fenced code block, a table, or a
 * paragraph up to a blank line.
 */
function blocks(body: string): Block[] {
  const out: Block[] = [];
  let fence: { kind: "code"; lines: string[] } | null = null;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence) fence = null;
      else { fence = { kind: "code", lines: [] }; out.push(fence); }
      continue;
    }
    if (fence) { fence.lines.push(raw); continue; }
    const last = out[out.length - 1];
    if (!line.trim()) { out.push({ kind: "para", lines: [] }); continue; }
    // A rule: the window draws no lines, and the blank space around it already parts the blocks.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ kind: "para", lines: [] }); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { out.push({ kind: "heading", level: Math.min(4, heading[1].length), text: heading[2] }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // The row under the head (| --- | :-: |) only says how to align; it is not shown.
      if (/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line)) continue;
      if (last?.kind === "table") last.rows.push(cells(line));
      else out.push({ kind: "table", rows: [cells(line)] });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      if (last?.kind === "quote") last.lines.push(quote[1]);
      else out.push({ kind: "quote", lines: [quote[1]] });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = Boolean(item[2]);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[3]);
      else out.push({ kind: "list", ordered, items: [item[3]] });
      continue;
    }
    if (last?.kind === "para" && last.lines.length > 0) last.lines.push(line.trim());
    else out.push({ kind: "para", lines: [line.trim()] });
  }
  return out.filter(block => (block.kind !== "para" && block.kind !== "quote") || block.lines.length > 0);
}

/** The plan's body, with its keys, cards and frames. */
export function PlanBody(props: PlanProps) {
  return <div className="kd-ai-md">
    {blocks(props.body).map((block, index) => {
      const key = `b${index}`;
      if (block.kind === "heading") return <p key={key} className="kd-ai-md-heading" data-level={block.level}>{inline(block.text, props, key)}</p>;
      if (block.kind === "list") {
        const items = block.items.map((item, i) => <li key={i}>{inline(item, props, `${key}-${i}`)}</li>);
        return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
      }
      if (block.kind === "code") return <pre key={key} className="kd-ai-md-code"><code>{block.lines.join("\n")}</code></pre>;
      if (block.kind === "table") {
        const [head, ...rows] = block.rows;
        return <div key={key} className="kd-ai-md-table kd-scroll">
          <table>
            <thead><tr>{head.map((cell, i) => <th key={i}>{inline(cell, props, `${key}-h${i}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i}>{inline(cell, props, `${key}-${r}-${i}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>;
      }
      if (block.kind === "quote") return <blockquote key={key} className="kd-ai-md-quote">
        {block.lines.map((line, i) => <div key={i} className="kd-ai-md-line">{inline(line, props, `${key}-${i}`)}</div>)}
      </blockquote>;
      return <div key={key} className="kd-ai-md-p">
        {block.lines.map((line, i) => <div key={i} className="kd-ai-md-line">{inline(line, props, `${key}-${i}`)}</div>)}
      </div>;
    })}
  </div>;
}

/** Markdown alone (a message, a preview, or a question written the old way). */
export function PlanText({ text }: { text: string }) {
  return <PlanBody body={text} media={{}} shots={{}} picked={{}} onPick={() => undefined} />;
}
