// Bundle the desktop player client in memory: its ESM-only native plugin import and
// import.meta.env cannot be loaded by the Node test runner directly.
import { buildSync } from "esbuild";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
const entry = new Module(`${process.cwd()}/tests/unifiedPlayerLanes.test.cjs`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("jsdom");
entry._compile(buildSync({
  entryPoints: ["tests/unifiedPlayerLanes.test.ts"], bundle: true, external: ["jsdom"],
  platform: "node", format: "cjs", define: { "import.meta.env": "{}" },
  logOverride: { "empty-import-meta": "silent" }, write: false,
}).outputFiles[0].text, entry.filename);
