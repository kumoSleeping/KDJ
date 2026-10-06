import { splitHosts } from "./panelSplitDom";

/** Keep the visible card (or bottom edge) fixed while async bodies change height.
 * Restore in the resize delivery, before paint; a second smooth-scroll animation
 * would chase the body's own transition and repeatedly reverse direction. */
export function preservePanelScroll(zone: HTMLElement, viewport: HTMLElement): () => void {
  let hosts = splitHosts(zone, false);
  let anchor: { id: string; offset: number; contentTop: number } | null = null;
  let edge: "top" | "bottom" | null = null;
  let expectedTop = viewport.scrollTop;
  let extent = 0;
  let height = viewport.clientHeight;
  let frame = 0;
  const observed = new Set<HTMLElement>();
  const previousAnchor = viewport.style.getPropertyValue("overflow-anchor");
  viewport.style.setProperty("overflow-anchor", "none");
  const maxScroll = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const topOf = (host: HTMLElement) => host.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top - viewport.clientTop;
  const capture = () => {
    extent = maxScroll();
    height = viewport.clientHeight;
    expectedTop = viewport.scrollTop;
    edge = expectedTop <= 1 ? "top" : extent - expectedTop <= 2 ? "bottom" : null;
    const visible = hosts.map(item => ({ ...item, top: topOf(item.host), height: item.host.getBoundingClientRect().height }))
      .filter(item => item.height > 0 && item.top + item.height > 0).sort((a, b) => a.top - b.top)[0];
    anchor = visible ? { id: visible.id, offset: visible.top, contentTop: visible.top + expectedTop } : null;
  };
  const restore = () => {
    if (!viewport.clientHeight || !zone.getClientRects().length) return;
    extent = maxScroll();
    height = viewport.clientHeight;
    const host = hosts.find(item => item.id === anchor?.id)?.host;
    let target = expectedTop;
    if (edge === "bottom") target = extent;
    else if (edge === "top") target = 0;
    else if (host && anchor) target = viewport.scrollTop + topOf(host) - anchor.offset;
    target = Math.max(0, Math.min(extent, target));
    if (Math.abs(viewport.scrollTop - target) > .5) viewport.scrollTop = target;
    expectedTop = viewport.scrollTop;
    if (host && anchor) anchor.contentTop = topOf(host) + expectedTop;
  };
  const resize = new ResizeObserver(restore);
  resize.observe(viewport);
  resize.observe(zone);
  const sync = () => {
    frame = 0;
    hosts = splitHosts(zone, false);
    const next = new Set(hosts.map(item => item.host));
    for (const host of observed) if (!next.has(host)) { resize.unobserve(host); observed.delete(host); }
    for (const host of next) if (!observed.has(host)) { resize.observe(host); observed.add(host); }
    restore();
  };
  const mutations = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(sync); });
  mutations.observe(zone, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["hidden", "data-panel-dock-id"] });
  const scroll = () => {
    const host = hosts.find(item => item.id === anchor?.id)?.host;
    // A browser clamp caused by shrinking content is not a new user position.
    const moved = host && anchor && Math.abs(topOf(host) + viewport.scrollTop - anchor.contentTop) > 1;
    if (maxScroll() !== extent || viewport.clientHeight !== height || moved) { restore(); return; }
    if (Math.abs(viewport.scrollTop - expectedTop) > .5) capture();
  };
  capture();
  sync();
  viewport.addEventListener("scroll", scroll, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resize.disconnect();
    viewport.removeEventListener("scroll", scroll);
    if (previousAnchor) viewport.style.setProperty("overflow-anchor", previousAnchor);
    else viewport.style.removeProperty("overflow-anchor");
  };
}
