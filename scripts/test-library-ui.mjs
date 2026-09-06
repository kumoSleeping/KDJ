// Exercise the real React table/store without native playback or filesystem fixtures.
import { build } from "esbuild";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
const entry = new Module(`${process.cwd()}/tests/libraryTable.test.cjs`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("react");
entry._compile((await build({
  entryPoints: ["tests/libraryTable.test.tsx"], bundle: true,
  external: ["jsdom", "react", "react-dom", "react-dom/*"],
  platform: "node", format: "cjs", define: { "import.meta.env": "{}" },
  logOverride: { "empty-import-meta": "silent" }, write: false,
  plugins: [{ name: "library-test-bridge", setup(build) {
    build.onResolve({ filter: /(^|\/)bridge$/ }, () => ({ path: "bridge", namespace: "library-test" }));
    build.onLoad({ filter: /.*/, namespace: "library-test" }, () => ({ contents: `
      export const getBridge = () => ({
        baseUrl: "http://localhost", authToken: "library-test", mediaToken: "library-test", platform: "darwin",
      });
    ` }));
  } }],
})).outputFiles[0].text, entry.filename);
