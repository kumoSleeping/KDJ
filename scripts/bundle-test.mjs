// Run one TypeScript test bundled in memory: the app's ESM-only native plugin, CSS imports and
// import.meta.env cannot be loaded by Node directly. `npm test` runs every test through here.
import { build } from "esbuild";
import { createRequire, Module } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/bundle-test.mjs tests/<name>.test.ts[x]");
const entry = new Module(`${process.cwd()}/${source.replace(/\.tsx?$/, ".cjs")}`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("react");
entry._compile((await build({
  entryPoints: [source], bundle: true,
  external: ["jsdom", "react", "react-dom", "react-dom/*"],
  platform: "node", format: "cjs", define: { "import.meta.env": "{}", "import.meta.url": JSON.stringify(pathToFileURL(source).href) },
  loader: { ".css": "empty" },
  logOverride: { "empty-import-meta": "silent" }, write: false,
  plugins: [{ name: "library-test-bridge", setup(build) {
    build.onResolve({ filter: /(^|\/)bridge$/ }, () => ({ path: "bridge", namespace: "library-test" }));
    build.onLoad({ filter: /.*/, namespace: "library-test" }, () => ({ contents: source === "tests/youtube-login-ui.test.ts"
      ? "export const getBridge = () => window.kdj;" : `
      export const getBridge = () => ({
        baseUrl: "http://localhost", authToken: "library-test", mediaToken: "library-test", platform: "darwin",
      });
    ` }));
  } }],
})).outputFiles[0].text, entry.filename);
