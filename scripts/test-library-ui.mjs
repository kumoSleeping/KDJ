// Exercise the real React table/store without native playback or filesystem fixtures.
import { build } from "esbuild";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
// The library table by default; another JSDOM test of the library UI may be named instead.
const source = process.argv[2] ?? "tests/libraryTable.test.tsx";
const entry = new Module(`${process.cwd()}/${source.replace(/\.tsx?$/, ".cjs")}`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("react");
entry._compile((await build({
  entryPoints: [source], bundle: true,
  external: ["jsdom", "react", "react-dom", "react-dom/*"],
  platform: "node", format: "cjs", define: { "import.meta.env": "{}" },
  loader: { ".css": "empty" },
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
