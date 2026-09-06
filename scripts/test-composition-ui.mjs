// Bundle the Vite-facing graph in memory so its import.meta.env and ESM-only native
// plugin imports can be tested without launching native playback or creating artifacts.
import { buildSync } from "esbuild";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
const entry = new Module(`${process.cwd()}/tests/composition.test.cjs`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("react");
entry._compile(buildSync({
  entryPoints: ["tests/composition.test.ts"], bundle: true, packages: "external",
  platform: "node", format: "cjs", define: { "import.meta.env": "{}" },
  logOverride: { "empty-import-meta": "silent" }, write: false,
}).outputFiles[0].text, entry.filename);
