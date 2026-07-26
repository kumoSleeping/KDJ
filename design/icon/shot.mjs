// 用 Chrome 无头把 HTML 里的图标截成 PNG。
// 为什么不用 rsvg-convert：它不支持 CSS 滤镜和混合模式，
// 而质感恰恰全靠那些东西；Chrome 渲的就是最终效果本身。
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const [, , html, out, wArg, hArg, scaleArg] = process.argv;
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--force-color-profile=srgb", "--disable-lcd-text"],
});
const page = await browser.newPage({
  viewport: { width: +wArg, height: +hArg },
  deviceScaleFactor: +(scaleArg || 2),
});
await page.setContent(readFileSync(html, "utf8"), { waitUntil: "load" });
await page.screenshot({ path: out, omitBackground: false });
await browser.close();
console.log("→", out);
