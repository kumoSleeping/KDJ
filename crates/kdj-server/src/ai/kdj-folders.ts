/**
 * Finding a folder by the name the listener says (docs/ai-dock.md): every folder under the
 * library's roots, and how well each name answers. No pi imports, so the tests read it as it is.
 *
 * Written into KDJ's own pi directory by kdj-server; edits here, not there.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const AUDIO = /\.(mp3|flac|m4a|aac|wav|aiff?|ogg|opus|mp4|mkv|webm|mov)$/i;
const MAX_DEPTH = 6;
const MAX_FOLDERS = 8000;

/** Every folder under a root (hidden ones and KDJ's own .kdj left out), with how many songs it holds. */
export function walk(root: string): { path: string; songs: number }[] {
  const out: { path: string; songs: number }[] = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < MAX_FOLDERS) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    let songs = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) stack.push({ dir: join(dir, entry.name), depth: depth + 1 }); }
      else if (AUDIO.test(entry.name)) songs += 1;
    }
    out.push({ path: dir, songs });
  }
  return out;
}

const CN_DIGITS: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
/** A name as it is said rather than typed: no spaces or separators, 八 as 8, yue as 月. */
export function foldName(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[零〇一二三四五六七八九]/g, char => CN_DIGITS[char])
    .replace(/yue/g, "月")
    .replace(/[\s_\-.·,，、()（）[\]【】]+/g, "");
}

/** How well a folder's name answers what was asked: 100 the same, down to 0 nothing alike. */
export function folderScore(name: string, query: string): number {
  const a = foldName(name), q = foldName(query);
  if (!q) return 1;
  if (!a) return 0;
  if (a === q) return 100;
  if (a.startsWith(q)) return 80;
  if (a.includes(q)) return 60;
  if (q.includes(a) && a.length >= 2) return 45;
  let at = 0;
  for (const char of a) if (char === q[at]) at += 1;
  if (at === q.length) return 30;
  const wanted = new Set(q);
  const shared = [...wanted].filter(char => a.includes(char)).length / wanted.size;
  return shared >= 0.6 ? Math.round(20 * shared) : 0;
}

