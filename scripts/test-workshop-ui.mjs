import { buildSync } from "esbuild";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
const entry = new Module(`${process.cwd()}/tests/workshop-ui.test.cjs`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("react");
entry._compile(
  buildSync({
    entryPoints: ["tests/workshop-ui.test.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    define: { "import.meta.env": "{}" },
    logOverride: { "empty-import-meta": "silent" },
    write: false,
  }).outputFiles[0].text,
  entry.filename,
);
