/**
 * KDJ's video tools for the pi it runs (docs/ai-dock.md, "视频"): what the kdj-video skill
 * (skills/kdj-video) works with. pi's own file tools stay off (bash is enabled separately); these reach only:
 *
 * - `read`: the skill's files, the AI's workspace, and `.kdjv` projects. pi lists the skill to the
 *   model only when a tool named `read` is active, and the model loads the skill with it.
 * - `write`: files inside the workspace (a Remotion composition's source, notes).
 * - `kdj_probe`: what a media file holds (ffprobe).
 * - `kdj_ffmpeg`: one FFmpeg run, its output inside the workspace.
 * - `kdj_remotion_render`: one Remotion render of the workspace's Remotion project, installed by
 *   KDJ (设置 → AI → 视频).
 * - `kdj_project_save` / `kdj_project_render` / `kdj_project_export`: a .kdjv project in the
 *   library, rendered for playing, and once the listener agrees, written out as one MP4.
 * - `kdj_visualizer_render`: KDJ's visualizer for a song (its cover in the default scene), as a
 *   clip for a project or, given a library folder, as the finished MP4.
 *
 * Written into KDJ's own pi directory by kdj-server; edits here, not there.
 */
import { spawn } from "node:child_process";
import { constants, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promptText, toolText } from "./kdj-prompts.ts";

const WORKSPACE = resolve(process.env.KDJ_WORKSPACE || process.cwd());
const SKILLS = process.env.KDJ_SKILLS ? resolve(process.env.KDJ_SKILLS) : null;
const REMOTION = join(WORKSPACE, "remotion");
const RENDERS = join(WORKSPACE, "renders");
const FFMPEG = process.env.KDJ_FFMPEG || "ffmpeg";
const FFPROBE = process.env.KDJ_FFPROBE || "ffprobe";

/** A text file is read this far; the model asks for more with `offset`. */
const READ_LIMIT = 120_000;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A path the model gave: relative ones are the workspace's. */
const at = (path: string) => resolve(WORKSPACE, path);

function readable(path: string): boolean {
  if (inside(WORKSPACE, path)) return true;
  if (SKILLS && inside(SKILLS, path)) return true;
  return extname(path).toLowerCase() === ".kdjv";
}

/** Inside the workspace, and not in the Remotion project's installed packages. */
function writable(path: string): boolean {
  return inside(WORKSPACE, path) && !inside(join(REMOTION, "node_modules"), path);
}

/**
 * The line a model that takes no pictures gets in its system prompt (kdj-tools.ts adds it at the
 * start of each run, so a model changed in 设置 is judged afresh): it cannot choose or check
 * footage, so it turns video work down instead of building it from titles alone. The visualizer
 * looks at no footage and stays open to it.
 */
export function blindLine(model: { id?: unknown; input?: unknown } | undefined): string | null {
  if (!model || !Array.isArray(model.input) || model.input.includes("image")) return null;
  return promptText("blind.md").replace("{model}", String(model.id ?? ""));
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  details: value,
});

/** Runs a program to its end; aborting the tool ends it. stdout and stderr lines go to `onLine`. */
function run(program: string, args: string[], options: { cwd: string; signal?: AbortSignal; onLine?: (line: string) => void }) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolveRun, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const lines = (chunk: string) => {
      if (!options.onLine) return;
      for (const line of chunk.split(/[\r\n]+/)) if (line.trim()) options.onLine(line);
    };
    child.stdout.setEncoding("utf8").on("data", chunk => { out += chunk; lines(chunk); });
    child.stderr.setEncoding("utf8").on("data", chunk => { err += chunk; lines(chunk); });
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", error => {
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", code => {
      options.signal?.removeEventListener("abort", abort);
      resolveRun({ code, out, err });
    });
  });
}

/** The picture height of a video file (ffprobe), or null when it has no picture or cannot be read. */
export async function videoHeight(path: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { code, out } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", path],
      { cwd: WORKSPACE, signal });
    const height = Number(out.trim().split("\n")[0]);
    return code === 0 && Number.isFinite(height) && height > 0 ? height : null;
  } catch {
    return null;
  }
}

/** The end of a long log: where a failure says why. */
const tail = (log: string, lines = 12) => log.trim().split("\n").slice(-lines).join("\n");

// ---------------------------------------------------------------- files

const read = defineTool({
  name: "read",
  label: "读取",
  description: toolText("read").description,
  parameters: Type.Object({
    path: Type.String({ description: toolText("read").param("path") }),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: toolText("read").param("offset") })),
  }),
  async execute(_id, params) {
    const path = at(params.path);
    if (!readable(path)) throw new Error("只能读取技能文件、工作目录和 .kdjv 工程");
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) throw new Error(`没有这个文件：${path}`);
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      return text(entries.filter(entry => entry.name !== "node_modules").map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name).join("\n"));
    }
    if (IMAGE.test(path)) {
      const data = (await readFile(path)).toString("base64");
      return { content: [{ type: "image" as const, data, mimeType: MIME[extname(path).toLowerCase()] ?? "image/png" }], details: { path } };
    }
    const all = await readFile(path, "utf8");
    const from = params.offset ?? 0;
    const part = all.slice(from, from + READ_LIMIT);
    const more = from + part.length < all.length ? `\n\n[还有 ${all.length - from - part.length} 个字符，用 offset=${from + part.length} 继续读]` : "";
    return text(part + more);
  },
});

const write = defineTool({
  name: "write",
  label: "写入",
  description: toolText("write").description,
  parameters: Type.Object({
    path: Type.String({ description: toolText("write").param("path") }),
    content: Type.String(),
  }),
  async execute(_id, params) {
    const path = at(params.path);
    if (!writable(path)) throw new Error("只能写在工作目录里（remotion/node_modules 除外）");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
    return text({ path, bytes: Buffer.byteLength(params.content) });
  },
});

// ---------------------------------------------------------------- media

const probe = defineTool({
  name: "kdj_probe",
  label: "媒体信息",
  description: toolText("kdj_probe").description,
  parameters: Type.Object({ path: Type.String({ description: toolText("kdj_probe").param("path") }) }),
  async execute(_id, params, signal) {
    const path = at(params.path);
    const { code, out, err } = await run(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], { cwd: WORKSPACE, signal });
    if (code !== 0) throw new Error(tail(err) || `无法读取 ${path}`);
    const parsed = JSON.parse(out) as { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };
    const streams = (parsed.streams ?? []).map(stream => ({
      type: stream.codec_type,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      fps: stream.avg_frame_rate,
      sample_rate: stream.sample_rate,
      channels: stream.channels,
      duration: stream.duration,
    }));
    return text({ path, duration: Number(parsed.format?.duration), size: Number(parsed.format?.size), streams });
  },
});

/** Where a render goes: relative paths land in the workspace's renders/. */
function outputPath(output: string): string {
  const path = isAbsolute(output) ? resolve(output) : join(RENDERS, output);
  if (!writable(path)) throw new Error("输出只能放在工作目录里（相对路径会放进 renders/）");
  return path;
}

const ffmpeg = defineTool({
  name: "kdj_ffmpeg",
  label: "FFmpeg",
  description: toolText("kdj_ffmpeg").description,
  parameters: Type.Object({
    args: Type.Array(Type.String(), { minItems: 1 }),
    output: Type.String({ description: toolText("kdj_ffmpeg").param("output") }),
  }),
  async execute(_id, params, signal, onUpdate) {
    const output = outputPath(params.output);
    await mkdir(dirname(output), { recursive: true });
    const args = ["-hide_banner", "-nostdin", "-y", ...params.args.filter(arg => arg !== "-y"), output];
    let last = 0;
    const { code, err } = await run(FFMPEG, args, {
      cwd: WORKSPACE,
      signal,
      onLine: line => {
        const time = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
        if (!time) return;
        const seconds = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
        if (seconds - last < 1) return;
        last = seconds;
        onUpdate?.({ content: [{ type: "text", text: `${seconds.toFixed(0)}s` }], details: { seconds } });
      },
    });
    if (code !== 0 || !existsSync(output)) throw new Error(tail(err) || `FFmpeg 退出码 ${code}`);
    return text({ output, seconds: last });
  },
});

const remotionCli = () => join(REMOTION, "node_modules", "@remotion", "cli", "remotion-cli.js");

const remotion = defineTool({
  name: "kdj_remotion_render",
  label: "Remotion",
  description: toolText("kdj_remotion_render").description,
  parameters: Type.Object({
    entry: Type.String({ description: toolText("kdj_remotion_render").param("entry") }),
    composition: Type.String(),
    output: Type.String({ description: toolText("kdj_remotion_render").param("output") }),
    props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    args: Type.Optional(Type.Array(Type.String(), { description: toolText("kdj_remotion_render").param("args") })),
  }),
  async execute(_id, params, signal, onUpdate) {
    if (!existsSync(remotionCli())) throw new Error("Remotion 还没有安装：请用户在 设置 → AI → 视频 里安装");
    const entry = resolve(REMOTION, params.entry);
    if (!inside(REMOTION, entry)) throw new Error("入口必须在 remotion/ 里");
    const output = outputPath(params.output);
    await mkdir(dirname(output), { recursive: true });
    const args = [remotionCli(), "render", entry, params.composition, output, "--overwrite", "--log=warn"];
    if (params.props) args.push(`--props=${JSON.stringify(params.props)}`);
    args.push(...(params.args ?? []));
    // pi runs on node, so Remotion runs on the same one.
    const { code, out, err } = await run(process.execPath, args, {
      cwd: REMOTION,
      signal,
      onLine: line => {
        const frames = /(\d+)\s*\/\s*(\d+)/.exec(line);
        if (frames && /render|encod/i.test(line)) {
          onUpdate?.({ content: [{ type: "text", text: `${frames[1]}/${frames[2]}` }], details: { done: Number(frames[1]), total: Number(frames[2]) } });
        }
      },
    });
    if (code !== 0 || !existsSync(output)) throw new Error(tail(`${out}\n${err}`) || `Remotion 退出码 ${code}`);
    return text({ output });
  },
});

// ---------------------------------------------------------------- projects

/** What kdj-tools.ts lends: KDJ's own commands and the library's roots. */
export interface VideoDeps {
  kdj(args: string[], signal?: AbortSignal, onProgress?: (progress: { done: number; total: number; detail?: string }) => void): Promise<unknown>;
  libraryRoots(signal?: AbortSignal): Promise<string[]>;
}

/**
 * A copy of `document` that can be checked from the workspace: every relative `src` made
 * absolute against the folder the project will be saved in, where KDJ would resolve it.
 */
function checkable(document: Record<string, unknown>, folder: string): Record<string, unknown> {
  const copy = structuredClone(document) as { tracks?: unknown };
  for (const track of Array.isArray(copy.tracks) ? copy.tracks : []) {
    const clips = (track as { clips?: unknown } | null)?.clips;
    for (const clip of Array.isArray(clips) ? clips : []) {
      const item = clip as { src?: unknown } | null;
      if (item && typeof item.src === "string" && !isAbsolute(item.src)) item.src = resolve(folder, item.src);
    }
  }
  return copy as Record<string, unknown>;
}

/** Every top-level key of `was` that `now` leaves out: a save must not hold less than it read. */
function dropped(was: unknown, now: Record<string, unknown>): string[] {
  if (!was || typeof was !== "object" || Array.isArray(was)) return [];
  return Object.keys(was).filter(key => !(key in now));
}

function projectTools(deps: VideoDeps) {
  const save = defineTool({
    name: "kdj_project_save",
    label: "保存工程",
    description: toolText("kdj_project_save").description,
    parameters: Type.Object({
      path: Type.String(),
      document: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_id, params, signal) {
      const path = resolve(params.path);
      if (extname(path).toLowerCase() !== ".kdjv") throw new Error("工程文件要以 .kdjv 结尾");
      const roots = await deps.libraryRoots(signal);
      if (!roots.some(root => inside(resolve(root), path))) throw new Error(`工程要放在曲库根目录内：${roots.join("、")}`);
      // Saving a project never makes folders: it is not a way to lay out the library.
      if (!statSync(dirname(path), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`文件夹不存在：${dirname(path)}。工程只能存进已有的文件夹`);
      if (params.document.kdjv !== 1) throw new Error("document 需要 \"kdjv\": 1");
      // Checked before it is written: a project that cannot play never reaches the library.
      const checks = join(WORKSPACE, "checks");
      await mkdir(checks, { recursive: true });
      const trial = join(checks, `${process.pid}-${Date.now()}.kdjv`);
      await writeFile(trial, `${JSON.stringify(checkable(params.document, dirname(path)), null, 2)}\n`, "utf8");
      let check: unknown;
      try {
        check = await deps.kdj(["project", "check", trial], signal);
      } catch (error) {
        throw new Error(`工程没有保存，检查没通过：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await rm(trial, { force: true });
      }
      if (existsSync(path)) {
        const old = await readFile(path, "utf8");
        let parsed: unknown = null;
        try { parsed = JSON.parse(old); } catch { /* not JSON: kept as the backup below */ }
        const missing = dropped(parsed, params.document);
        if (missing.length > 0) throw new Error(`新内容少了原有的字段：${missing.join("、")}。读出整份再改，不要删掉不认识的字段`);
        const backups = join(WORKSPACE, "backups");
        await mkdir(backups, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await writeFile(join(backups, `${stamp}-${relative(dirname(path), path)}`), old, "utf8");
      }
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(params.document, null, 2)}\n`, "utf8");
      await rename(temporary, path);
      return text({ saved: path, check });
    },
  });

  const render = defineTool({
    name: "kdj_project_render",
    label: "预渲染工程",
    description: toolText("kdj_project_render").description,
    parameters: Type.Object({ path: Type.String({ description: toolText("kdj_project_render").param("path") }) }),
    async execute(_id, params, signal, onUpdate) {
      // The render's percentage, for the AI corner and the drawer's step.
      return text(await deps.kdj(["project", "render", resolve(params.path)], signal, ({ done, total, detail }) => onUpdate?.({
        content: [{ type: "text", text: `${done}/${total}` }],
        details: { done, total, detail },
      })));
    },
  });

  const exportProject = defineTool({
    name: "kdj_project_export",
    label: "导出工程",
    description: toolText("kdj_project_export").description,
    parameters: Type.Object({
      path: Type.String({ description: toolText("kdj_project_export").param("path") }),
      to: Type.Optional(Type.String({ description: toolText("kdj_project_export").param("to") })),
      name: Type.Optional(Type.String({ description: toolText("kdj_project_export").param("name") })),
    }),
    async execute(_id, params, signal, onUpdate) {
      const project = resolve(params.path);
      if (extname(project).toLowerCase() !== ".kdjv") throw new Error("要导出的是 .kdjv 工程");
      const folder = resolve(params.to ?? dirname(project));
      const roots = await deps.libraryRoots(signal);
      if (!roots.some(root => inside(resolve(root), folder))) throw new Error(`导出要放在曲库根目录内：${roots.join("、")}`);
      if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`文件夹不存在：${folder}`);
      const name = (params.name ?? basename(project, extname(project))).replace(/[\\/:*?"<>|]/g, "_").trim();
      if (!name) throw new Error("文件名为空");
      const target = join(folder, `${name}.mp4`);
      if (existsSync(target)) throw new Error(`已经有这个文件，换一个 name：${target}`);
      const rendered = await deps.kdj(["project", "render", project], signal, ({ done, total, detail }) => onUpdate?.({
        content: [{ type: "text", text: `${done}/${total}` }],
        details: { done, total, detail },
      })) as { path?: unknown };
      if (typeof rendered?.path !== "string") throw new Error("渲染没有给出文件");
      await copyFile(rendered.path, target, constants.COPYFILE_EXCL);
      return text({ exported: target, from: project });
    },
  });

  const visualizer = defineTool({
    name: "kdj_visualizer_render",
    label: "可视化",
    description: toolText("kdj_visualizer_render").description,
    parameters: Type.Object({
      track_id: Type.Integer(),
      width: Type.Optional(Type.Integer({ minimum: 320, maximum: 2560 })),
      height: Type.Optional(Type.Integer({ minimum: 180, maximum: 1440 })),
      to: Type.Optional(Type.String({ description: toolText("kdj_visualizer_render").param("to") })),
      name: Type.Optional(Type.String({ description: toolText("kdj_visualizer_render").param("name") })),
    }),
    async execute(_id, params, signal) {
      let folder = RENDERS;
      if (params.to) {
        folder = resolve(params.to);
        const roots = await deps.libraryRoots(signal);
        if (!roots.some(root => inside(resolve(root), folder))) throw new Error(`导出要放在曲库根目录内：${roots.join("、")}`);
        if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`文件夹不存在：${folder}`);
      }
      const name = (params.name ?? `visualizer-${params.track_id}-${Date.now()}`).replace(/[\\/:*?"<>|]/g, "_").trim();
      const target = join(folder, `${name}.mp4`);
      if (existsSync(target)) throw new Error(`已经有这个文件，换一个 name：${target}`);
      await mkdir(folder, { recursive: true });
      const size = { width: params.width, height: params.height };
      return text(await deps.kdj(["visualizer", "render", String(params.track_id), "--out", target,
        ...(size.width ? ["--width", String(size.width)] : []), ...(size.height ? ["--height", String(size.height)] : [])], signal));
    },
  });

  return [save, render, exportProject, visualizer];
}

export function registerVideo(pi: ExtensionAPI, deps: VideoDeps) {
  for (const tool of [read, write, probe, ffmpeg, remotion, ...projectTools(deps)]) pi.registerTool(tool);
}
