// 首帧前把上次的主题写回 <html data-theme>，写入端在 appStore.applyTheme。
// 读不到（首次启动 / localStorage 被禁）就按 index.html 里的默认浅色走。
(function () {
  try {
    var theme = localStorage.getItem("kd-theme");
    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.theme = theme;
    }
  } catch (_) {
    /* 保持 index.html 的默认值 */
  }
})();
