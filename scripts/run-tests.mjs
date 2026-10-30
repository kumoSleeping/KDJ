// Run every frontend test in tests/: each file in its own Node process, several at a time.
//   npm test                         all of them
//   npm test -- lyrics workRail      only files whose name contains one of the words
// tests/*.test.ts(x) run bundled (scripts/bundle-test.mjs); a file that starts with the line
// `// @run tsx` runs under tsx instead (it imports Node-only modules such as the Vite config).
// tests/*.test.mjs / .cjs run as they are.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const filters = process.argv.slice(2);
const files = readdirSync("tests")
  .filter(name => /\.test\.(ts|tsx|mjs|cjs)$/.test(name))
  .filter(name => !filters.length || filters.some(word => name.includes(word)))
  .sort();
if (!files.length) {
  console.error(`no test matches ${filters.join(" ")}`);
  process.exit(1);
}

function command(name) {
  const file = `tests/${name}`;
  if (/\.(mjs|cjs)$/.test(name)) return ["--test", file];
  if (readFileSync(file, "utf8").startsWith("// @run tsx")) return ["--import", "tsx", "--test", file];
  return ["scripts/bundle-test.mjs", file];
}

function run(name) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, command(name), { env: { ...process.env, NODE_ENV: "test" } });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("close", code => resolve({ name, ok: code === 0, output, ms: Date.now() - started }));
  });
}

const queue = [...files];
const results = [];
// The DOM tests run real timers (list arrivals, scroll settling): a fully loaded CPU makes them
// miss their moments, so leave half of it free.
const workers = Array.from({ length: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))) }, async () => {
  for (let name = queue.shift(); name; name = queue.shift()) {
    const result = await run(name);
    results.push(result);
    console.log(`${result.ok ? "ok  " : "FAIL"} ${name} (${result.ms} ms)`);
  }
});
await Promise.all(workers);

const failed = results.filter(result => !result.ok).sort((a, b) => a.name.localeCompare(b.name));
for (const result of failed) console.log(`\n── ${result.name} ──\n${result.output.trimEnd()}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
