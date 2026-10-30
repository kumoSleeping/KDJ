// Render the real workspace to catch initialization-order errors missed by typechecking.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire, Module } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
// Flatten portable panel hosts for this render-only check; media is never started.
const reactDom = require("react-dom");
const originalCreatePortal = reactDom.createPortal;
reactDom.createPortal = children => children;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.kdj = { platform: "darwin", baseUrl: "http://localhost", authToken: "test", mediaToken: "test" };

try {
  const result = await build({
    stdin: {
      contents: `
        const React = require("react");
        const { renderToString } = require("react-dom/server");
        const { Workspace } = require("./src/components/workspace/Workspace");
        module.exports = () => renderToString(React.createElement(Workspace));
      `,
      resolveDir: process.cwd(),
    },
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["react", "react-dom", "react-dom/*", "jsdom"],
    loader: { ".css": "empty" }, define: { "import.meta.env": "{}" },
    logOverride: { "empty-import-meta": "silent" },
    plugins: [{ name: "workspace-test-worker-url", setup(bundler) {
      bundler.onResolve({ filter: /\?worker&url$/ }, () => ({ path: "worker", namespace: "workspace-test" }));
      bundler.onLoad({ filter: /.*/, namespace: "workspace-test" }, () => ({ contents: 'export default "worker.js";' }));
    } }],
  });
  const entry = new Module(`${process.cwd()}/workspace-first-render-validation.cjs`);
  entry.filename = entry.id;
  entry.paths = require.resolve.paths("react");
  entry._compile(result.outputFiles[0].text, entry.filename);
  const html = entry.exports();
  assert.ok(html.includes('class="kd-main-slot"'));
  console.log("PASS: real workspace first render");
} finally {
  reactDom.createPortal = originalCreatePortal;
  dom.window.close();
}
