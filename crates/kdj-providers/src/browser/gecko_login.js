// Executed only over the browser-approved Browser Toolbox connection. All substitutions are
// JSON literals from the fixed LoginSite enum, never renderer-supplied JavaScript or URLs.
(() => {
  const services = globalThis.Services ?? ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;
  if (!services.prefs.getBoolPref("devtools.debugger.prompt-connection", true) ||
      !services.prefs.getBoolPref("devtools.debugger.force-local", true)) {
    return JSON.stringify({ status: "permission_required" });
  }
  const origin = __SITE_ORIGIN__;
  const names = new Set(__COOKIE_NAMES__);
  const windows = [...services.wm.getEnumerator("navigator:browser")];
  const selectedId = __BROWSER_ID__;
  const allPages = windows.flatMap(win => [...(win.gBrowser?.browsers ?? [])]);
  if (selectedId !== null && !allPages.some(browser => browser.browserId === selectedId))
    return JSON.stringify({ status: "closed" });
  const pages = windows.flatMap(win => [...(win.gBrowser?.browsers ?? [])]).filter(browser => {
    try {
      return (selectedId === null || browser.browserId === selectedId) && browser.currentURI.prePath === origin &&
        browser.contentPrincipal.originNoSuffix === origin &&
        browser.contentPrincipal.originAttributes.privateBrowsingId === 0;
    } catch { return false; }
  });
  if (!pages.length) return JSON.stringify({ status: selectedId === null ? "no_page" : "waiting" });
  const contexts = new Set(pages.map(browser => browser.contentPrincipal.originSuffix));
  if (contexts.size !== 1) return JSON.stringify({ status: "ambiguous" });
  const browser = pages[0];
  const attributes = browser.contentPrincipal.originAttributes;
  const host = new URL(origin).hostname;
  const cookies = [];
  for (const cookie of services.cookies.getCookiesFromHost(host, attributes)) {
    const domain = cookie.host.replace(/^\./, "");
    // Only cookies usable at this HTTPS origin's root, in this tab's container and partition.
    if ((host !== domain && !host.endsWith("." + domain)) || cookie.path !== "/" ||
        !names.has(cookie.name) || (!cookie.isSession && cookie.expiry <= Date.now() / 1000)) continue;
    cookies.push({ name: cookie.name, value: cookie.value, domain: cookie.host,
      path: cookie.path, expires: cookie.isSession ? -1 : cookie.expiry });
  }
  return JSON.stringify({ status: "ok", browserId: browser.browserId, cookies });
})()
