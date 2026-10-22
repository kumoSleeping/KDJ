#!/usr/bin/env node
// Reads and clears the reports users sent from 设置 → 日志 → 上报错误.
//
//   node scripts/reports.mjs list                  newest first: time, version, description, top error
//   node scripts/reports.mjs show <id> [--all]     one report: description, errors by count, timeline
//   node scripts/reports.mjs rm <id>… [--yes]      delete those reports (ids may be shortened)
//   node scripts/reports.mjs rm --below <version> [--yes]   delete every report older than a fix
//
// Without --yes, rm only says what it would delete. The admin key is read from
// $KDJ_BUG_ADMIN_TOKEN or ~/.config/kdj-bug-collector/admin-token and is never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions, groups, isOrdinary, shape } from "../src/summary.js";

const BASE = process.env.KDJ_BUG_COLLECTOR ?? "https://bug.kdj.kumo.ltd";
const token = (process.env.KDJ_BUG_ADMIN_TOKEN ?? readFileSync(join(homedir(), ".config/kdj-bug-collector/admin-token"), "utf8")).trim();

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function all() {
  const reports = [];
  let next = "";
  do {
    const page = await call(`/admin/reports?before=${encodeURIComponent(next)}`);
    reports.push(...page.reports);
    next = page.next ?? "";
  } while (next);
  return reports;
}

const when = value => new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const clock = value => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });

async function resolve(prefixes, reports) {
  return prefixes.map(prefix => {
    const found = reports.filter(report => report.id.startsWith(prefix));
    if (found.length !== 1) throw new Error(`${prefix}: ${found.length ? "不止一份报告以此开头" : "没有这份报告"}`);
    return found[0];
  });
}

async function list() {
  for (const report of await all()) {
    console.log(`${report.id.slice(0, 8)}  ${when(report.received_at)}  ${report.app_version} ${report.os}  ${String(report.event_count).padStart(3)} 条`);
    if (report.note) console.log(`          描述：${report.note}`);
    if (report.top_error) console.log(`          最多：${report.top_error}`);
  }
}

async function show(prefix, everything) {
  const [meta] = await resolve([prefix], await all());
  const report = await call(`/admin/reports/${meta.id}`);
  console.log(`${report.id}  收到 ${when(meta.received_at)}  ${report.app_version} ${report.os} ${report.arch}  ${report.cpu_threads} 线程  ${report.entries.length} 条（舍弃 ${report.omitted}，丢失 ${report.dropped}）`);
  console.log(`描述：${report.note ? `\n${report.note.replace(/^/gm, "  ")}` : "（空）"}\n`);
  const found = groups(report);
  console.log("错误与警告，按次数：");
  for (const group of found.filter(group => !group.ordinary)) {
    console.log(`  ×${String(group.count).padEnd(3)} ${group.key}  [${clock(group.first)}${group.count > 1 ? `–${clock(group.last)}` : ""}]`);
  }
  const ordinary = found.filter(group => group.ordinary);
  if (ordinary.length) {
    console.log(`\n已知的正常情况：${ordinary.reduce((sum, group) => sum + group.count, 0)} 条${everything ? "" : "（--all 展开）"}`);
    if (everything) for (const group of ordinary) console.log(`  ×${String(group.count).padEnd(3)} ${group.key}`);
  }
  console.log("\n时间线（操作、错误与警告；同样的连续几条合并）：");
  let previous = null, repeat = 0, printed = 0;
  const flush = () => { if (repeat > 1) console.log(`           ……同上 ×${repeat}`); };
  for (const entry of report.entries) {
    if (!everything && isOrdinary(entry)) continue;
    const kind = entry.level.toLowerCase() === "info" ? (entry.category === "action" ? "操作" : "信息") : entry.level.toLowerCase();
    const key = shape(entry);
    if (key === previous) { repeat += 1; continue; }
    flush();
    previous = key; repeat = 1;
    if (!everything && ++printed > 200) { console.log("  ……（--all 看全部）"); break; }
    const lines = String(entry.message).split("\n").map(line => line.trim()).filter(Boolean);
    console.log(`  ${clock(entry.timestamp)}  ${kind.padEnd(5)} ${entry.category} · ${entry.source} · ${(lines[0] ?? "").slice(0, 300)}`);
    if (everything) for (const line of lines.slice(1, 12)) console.log(`           ${line.slice(0, 300)}`);
  }
  flush();
}

async function remove(args) {
  const yes = args.includes("--yes");
  const at = args.indexOf("--below");
  const reports = await all();
  let doomed;
  if (at >= 0) {
    const below = args[at + 1];
    if (compareVersions(below, "0.0.0") === null) throw new Error("--below 后面要跟一个版本，例如 1.1.0-rc11");
    doomed = reports.filter(report => compareVersions(report.app_version, below) < 0);
  } else {
    doomed = await resolve(args.filter(arg => !arg.startsWith("--")), reports);
  }
  for (const report of doomed) console.log(`${report.id.slice(0, 8)}  ${when(report.received_at)}  ${report.app_version} ${report.os}  ${report.note || ""}`);
  if (!doomed.length) return console.log("没有要删除的报告");
  if (!yes) return console.log(`\n以上 ${doomed.length} 份；加 --yes 才会删除`);
  const result = await call("/admin/reports/delete", { method: "POST", body: JSON.stringify({ ids: doomed.map(report => report.id) }) });
  console.log(`\n已删除 ${result.deleted} 份`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "list") await list();
  else if (command === "show" && args[0]) await show(args[0], args.includes("--all"));
  else if (command === "rm" && args.length) await remove(args);
  else console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).map(line => line.replace(/^\/\/ ?/, "")).join("\n"));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
