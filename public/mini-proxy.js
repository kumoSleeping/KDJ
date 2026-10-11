// The mini player's stand-in window (see mini-proxy.html). The main window hands over what it
// shows (the bubble's markup, the main page's style sheets and the attributes of its root);
// this lays it out and says when it has been drawn. Nothing in here is live: it is a picture.
(function () {
  var internals = window.__TAURI_INTERNALS__;
  if (!internals) return;
  var invoke = function (command, args) { return internals.invoke(command, args || {}); };
  var sheets = [];

  function frames(count) {
    // A window that is not on show yet may be given no frames: a timer ends the wait as well.
    return Promise.race([
      new Promise(function (resolve) {
        var left = count;
        var step = function () { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(step); };
        requestAnimationFrame(step);
      }),
      new Promise(function (resolve) { setTimeout(resolve, 160); }),
    ]);
  }

  function loaded(link) {
    return new Promise(function (resolve) {
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
      setTimeout(resolve, 600);
    });
  }

  async function show(order) {
    var picture = JSON.parse(order.picture);
    var root = document.documentElement;
    Array.prototype.slice.call(root.attributes).forEach(function (attribute) { root.removeAttribute(attribute.name); });
    Object.keys(picture.root || {}).forEach(function (name) { root.setAttribute(name, picture.root[name]); });
    // What it shows is the bubble as the mini player (MiniPlayer.css).
    root.setAttribute("data-kd-mini", "on");
    if (picture.styles) {
      sheets.forEach(function (node) { node.remove(); });
      sheets = [];
      var waits = [];
      (picture.links || []).forEach(function (href) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        waits.push(loaded(link));
        document.head.append(link);
        sheets.push(link);
      });
      picture.styles.forEach(function (css) {
        var style = document.createElement("style");
        style.textContent = css;
        document.head.append(style);
        sheets.push(style);
      });
      await Promise.all(waits);
    }
    document.body.className = picture.body || "";
    document.body.innerHTML = picture.html;
    await Promise.all(Array.prototype.map.call(document.images, function (image) {
      return image.decode ? image.decode().catch(function () {}) : null;
    }));
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, new Promise(function (resolve) { setTimeout(resolve, 300); })]);
    }
    await frames(3);
    await invoke("mini_proxy_drawn", { token: order.token });
  }

  // Asked for by the native side when there is something to show, and once on load for an
  // order that was placed while this page was still loading.
  window.__kdMiniProxyFetch = function () {
    invoke("mini_proxy_take").then(function (order) { return order ? show(order) : null; }).catch(function () {});
  };
  window.__kdMiniProxyFetch();
})();
