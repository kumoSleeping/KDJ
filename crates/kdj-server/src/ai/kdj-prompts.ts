/**
 * Every word KDJ puts before the model, read from prompts/ (prompts/README.md): the system
 * prompt's parts and each tool's description and parameter descriptions (prompts/tools.md).
 * The tools name their text by tool and parameter; the text itself lives only in those files, so
 * a person can read all of it in one place. kdj-server writes the folder beside this file and
 * names it in `KDJ_PROMPTS`.
 *
 * Written into KDJ's own pi directory by kdj-server; edits here, not there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.KDJ_PROMPTS ?? "";

/** One file of prompts/, as the model gets it. */
export function promptText(name: string): string {
  return readFileSync(join(DIR, name), "utf8").trim();
}

type ToolText = { description: string; params: Map<string, string> };

/**
 * prompts/tools.md: under `## name` the tool's description, under its `### 参数` one line
 * `` - `param`：text `` per parameter. Anything before the first tool, or under a `# ` heading, is
 * for the person reading the file.
 */
function parseTools(markdown: string): Map<string, ToolText> {
  const tools = new Map<string, ToolText>();
  let tool: ToolText | null = null;
  let lines: string[] = [];
  let inParams = false;
  const close = () => {
    if (tool) tool.description = lines.join("\n").trim();
    tool = null;
    lines = [];
    inParams = false;
  };
  for (const line of markdown.split("\n")) {
    const head = /^## (\S+)\s*$/.exec(line);
    if (head) {
      close();
      tool = { description: "", params: new Map() };
      tools.set(head[1], tool);
      continue;
    }
    if (/^# /.test(line)) { close(); continue; }
    if (!tool) continue;
    if (/^### 参数\s*$/.test(line)) { inParams = true; continue; }
    if (!inParams) { lines.push(line); continue; }
    const param = /^- `([^`]+)`：(.+)$/.exec(line);
    if (param) tool.params.set(param[1], param[2].trim());
  }
  close();
  return tools;
}

const TOOLS = parseTools(promptText("tools.md"));

/** A tool's words: its description, and `param(name)` for each parameter's. A missing one stops the load. */
export function toolText(name: string) {
  const text = TOOLS.get(name);
  if (!text) throw new Error(`prompts/tools.md 里没有工具 ${name}`);
  return {
    description: text.description,
    param(key: string): string {
      const value = text.params.get(key);
      if (value === undefined) throw new Error(`prompts/tools.md 的 ${name} 没有参数 ${key}`);
      return value;
    },
  };
}
