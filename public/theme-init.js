// 首帧前把上次的主题写回 <html data-theme>，写入端在 appStore.applyTheme。
// 读不到（首次启动 / localStorage 被禁）就按 index.html 里的默认浅色走。
(function () {
  try {
    var theme = localStorage.getItem("kd-theme");
    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.theme = theme;
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
