import type { Plugin } from "vite";

const SCRIPT_PATH = "/@kdj/react-dev-init.js";

/**
 * Turns off React's development-only "performance tracks" in the dev WebView.
 *
 * React 19.2's development build writes a `performance.measure` entry for every rendered
 * component, with a deep diff of its changed props as the entry's detail. A waveform (several
 * typed arrays of up to 100 000 values) or a track index arriving as a prop then makes a single
 * commit serialize millions of values on the main thread: sampled in WKWebView, 1.4-1.6 s of
 * `PerformanceUserTiming::measure` after every song change, during which no click, slider or
 * seek is handled. React only does this when `console.timeStamp` exists, so the page drops it
 * before React loads. Production builds contain none of this code.
 *
 * The script is served rather than inlined because the page's CSP only allows scripts from self.
 */
export function withoutReactPerformanceTracks(): Plugin {
  return {
    name: "kdj-react-dev-init",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== SCRIPT_PATH) return next();
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end("console.timeStamp = undefined;\n");
      });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { src: SCRIPT_PATH }, injectTo: "head-prepend" }];
    },
  };
}
