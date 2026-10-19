/**
 * The little Markdown a model writes in a chat: paragraphs, lists, **bold**, `code` and links.
 * Links open in the system browser. Anything else is left as the text it is.
 */
import type { ReactNode } from "react";
import { getBridge } from "../../lib/bridge";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;

function open(url: string) {
  const openExternal = getBridge().openExternal;
  if (openExternal) void openExternal(url);
}

function inline(text: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((piece, index) => {
    if (piece.startsWith("**") && piece.endsWith("**")) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith("`") && piece.endsWith("`")) return <code key={index}>{piece.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece);
    if (link) {
      return <a key={index} href={link[2]} className="kd-ai-link" target="_blank" rel="noreferrer"
        onClick={event => { event.preventDefault(); open(link[2]); }}>{link[1]}</a>;
    }
    return piece;
  });
}

export function AiMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return <>{blocks.map((block, index) => {
    const lines = block.split("\n");
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (lines.every(line => bullet.test(line))) {
      return <ul key={index}>{lines.map((line, at) => <li key={at}>{inline(line.replace(bullet, ""))}</li>)}</ul>;
    }
    if (lines.every(line => numbered.test(line))) {
      return <ol key={index}>{lines.map((line, at) => <li key={at}>{inline(line.replace(numbered, ""))}</li>)}</ol>;
    }
    return <p key={index}>{lines.map((line, at) => <span key={at}>{at > 0 && <br />}{inline(line)}</span>)}</p>;
  })}</>;
}
