// What a report says at a glance, shared by the Worker (the list's columns) and scripts/reports.mjs.

/** Ordinary states older builds still logged as errors: shown folded, never as the report's top error. */
export const ORDINARY = [
  /没有可用封面/, /没有内嵌封面/, /cover\/\{id\}.*曲目不存在/, /本地没有歌词/, /未找到匹配歌词/, /没找到「.*」的歌词/, /曲库根目录离线或不可读/,
  /failed to check for updates/, /读取更新清单失败/, /更新检查 API/, /ResizeObserver loop/,
  /invalid main_data_begin/, /Using bitrate to estimate duration/, /ignoring (?:stss|ctts) atom/,
  /Merged or dropped \d+ repeated/,
];

export const isOrdinary = entry => ORDINARY.some(pattern => pattern.test(`${entry.source} ${entry.message}`));

/** One line of an entry with its numbers taken out, so that repeats of it group together. */
export function shape(entry) {
  const first = String(entry.message).split("\n").find(line => line.trim()) ?? "";
  return `${entry.level.toLowerCase()} · ${entry.source} · ${first.trim().replace(/\d+/g, "#").slice(0, 160)}`;
}

/** The report's warnings and errors grouped by shape, most often first; ordinary states apart. */
export function groups(report) {
  const found = new Map();
  for (const entry of report.entries ?? []) {
    if (entry.level.toLowerCase() === "info") continue;
    const key = shape(entry);
    const group = found.get(key) ?? { key, count: 0, first: entry.timestamp, last: entry.timestamp, ordinary: isOrdinary(entry), sample: entry };
    group.count += 1;
    group.last = entry.timestamp;
    found.set(key, group);
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.first.localeCompare(b.first));
}

/** The description's first line and the commonest real error, for the list. */
export function summarize(report) {
  const top = groups(report).find(group => !group.ordinary && group.sample.level.toLowerCase() === "error")
    ?? groups(report).find(group => !group.ordinary);
  const note = String(report.note ?? "").split("\n").map(line => line.trim()).filter(Boolean).join(" / ");
  return { note: note.slice(0, 300), top_error: top ? `${top.key.slice(0, 200)} ×${top.count}` : "" };
}

/** Orders `1.1.0-rc9` below `1.1.0-rc13` below `1.1.0`; null for something that is not a version. */
export function compareVersions(a, b) {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(String(value));
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const parts = value => value.split(/[.-]/).flatMap(part => part.match(/\d+|\D+/g) ?? []);
  const p = parts(x[4]), q = parts(y[4]);
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const numeric = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]);
    const order = numeric ? Number(p[i]) - Number(q[i]) : p[i].localeCompare(q[i]);
    if (order) return order;
  }
  return 0;
}
