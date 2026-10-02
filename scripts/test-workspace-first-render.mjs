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
  const render = (previewOpen, searchEnabled) => {
    localStorage.setItem("kd-track-preview-open", String(previewOpen));
    localStorage.setItem("kd-top-panels-enabled", JSON.stringify({ control: true, waveform: true, search: searchEnabled }));
    const entry = new Module(`${process.cwd()}/workspace-first-render-validation.cjs`);
    entry.filename = entry.id;
    entry.paths = require.resolve.paths("react");
    entry._compile(result.outputFiles[0].text, entry.filename);
    return entry.exports();
  };
  const expanded = render(true, true);
  const collapsed = render(false, true);
  const disabled = render(false, false);
  assert.ok(expanded.includes('id="kd-track-preview"'));
  assert.ok(!collapsed.includes('id="kd-track-preview"'));
  assert.ok(collapsed.includes('data-panel-id="control"'));
  assert.ok(collapsed.includes('data-panel-id="waveform"'));
  assert.ok(!disabled.includes('class="kd-search-band-host"'));
  console.log("PASS: real workspace first render, collapsed preview and disabled search");
} finally {
  reactDom.createPortal = originalCreatePortal;
  dom.window.close();
}
