// 首帧前把上次的主题写回 <html data-theme>，写入端在 appStore.applyTheme。
// 读不到（首次启动 / localStorage 被禁）就按 index.html 里的默认浅色走。
(function () {
  try {
    var theme = localStorage.getItem("kd-theme");
    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.theme = theme;
    }
    // 主题包的首帧快照，写入端在 src/lib/themePack.ts。样式表要等本地服务起来才拿得到，
    // 这里先把底色和属性摆好；themePack.bootThemePack 在 CSS 到位后撤掉内联底色。
    var pack = JSON.parse(localStorage.getItem("kd-theme-pack") || "null");
    if (pack && pack.id && pack.boot) {
      var html = document.documentElement;
      html.dataset.themePack = pack.id;
      var colors = pack.boot.window || {};
      // A single-mode pack must already use its supported mode on the first frame.
      if (!colors[theme]) {
        if (colors.light && !colors.dark) theme = "light";
        else if (colors.dark && !colors.light) theme = "dark";
        html.dataset.theme = theme;
      }
      (pack.boot.attrs || []).forEach(function (name) {
        if (/^data-theme-opt-[a-z0-9-]+$/.test(name)) html.setAttribute(name, "");
      });
      var color = colors[theme];
      if (/^#[0-9a-f]{6}$/i.test(color)) {
        html.dataset.themeWindow = color;
        // 歌词窗必须保持透明
        if (new URLSearchParams(window.location.search).get("window") !== "lyrics") {
          html.style.setProperty("--kd-bg", color);
        }
      }
    }
    // 主界面字号是本机显示偏好；悬浮歌词已有独立字号，不能叠加这里的缩放。
    if (new URLSearchParams(window.location.search).get("window") !== "lyrics") {
      var fontScale = Number(localStorage.getItem("kd-app-font-scale"));
      if (!Number.isInteger(fontScale) || fontScale < 75 || fontScale > 150) fontScale = 106;
      document.documentElement.style.fontSize = fontScale + "%";
    }
  } catch (_) {
    /* 保持 index.html 的默认值 */
  }
})();
