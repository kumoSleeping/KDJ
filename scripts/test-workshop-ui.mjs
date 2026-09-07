import { buildSync } from "esbuild";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
const requested = process.argv.slice(2);
for (const name of requested.length ? requested : ["workshop-ui", "workstation-ui", "workshop-transitions-ui", "marquee-ui"]) {
const entry = new Module(`${process.cwd()}/tests/${name}.test.cjs`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("react");
entry._compile(
  buildSync({
    entryPoints: [`tests/${name}.test.ts`],
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

}
