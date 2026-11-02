import { Component, createRef, type ReactNode } from "react";
import "./SlidePages.css";

export const SLIDE_PAGES_MS = 300;
const EASE = "cubic-bezier(0.22, 0.9, 0.26, 1)";
/** How long a page that is still pending may hold up its own arrival: the drawer's limit for
 *  pending content (PENDING_HOLD_MS). Past it the page slides in as it is. */
const PENDING_WAIT_MS = 600;

/** Whether the page in view says it is still waiting for what it shows (`data-drawer-pending`). */
const pending = (page: HTMLElement) => page.querySelector("[data-drawer-pending]") !== null;

/** A still copy of the page that is on screen, scroll positions included. */
function still(page: HTMLElement): HTMLElement {
  const copy = page.cloneNode(true) as HTMLElement;
  const from = page.querySelectorAll<HTMLElement>("*"), to = copy.querySelectorAll<HTMLElement>("*");
  const scrolled: [HTMLElement, number][] = [];
  from.forEach((node, index) => { if (node.scrollTop > 0 && to[index]) scrolled.push([to[index], node.scrollTop]); });
  copy.classList.add("kd-slide-ghost");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  // Ids in a copy would answer for the live page's labels and controls.
  copy.removeAttribute("id");
  to.forEach(node => {
    node.removeAttribute("id");
    // A picture neither waits for data nor replays a list's unfinished arrival.
    node.removeAttribute("data-drawer-pending");
    node.removeAttribute("data-kd-arrive");
  });
  // Scroll offsets can only be set once the copy is in the document.
  (copy as HTMLElement & { restoreScroll?(): void }).restoreScroll = () => {
    for (const [node, top] of scrolled) node.scrollTop = top;
  };
  return copy;
}

interface SlidePagesProps {
  /** The page in view. */
  page: string;
  /** Every page in title order: a later page arrives from the right, an earlier one from the left. */
  order: readonly string[];
  /** `y`: the pages travel up and down instead — a later page arrives from below, an earlier one from above. */
  axis?: "x" | "y";
  className?: string;
  children: ReactNode;
}

/**
 * Switches pages by sliding sideways (or up and down, `axis="y"`). The children are whatever the
 * page in view renders; when `page` changes, a still copy of the old picture slides out while the
 * new one slides in from the side its title lies on. Pages need not stay mounted, and nothing is
 * asked of them. A page that arrives still pending (`data-drawer-pending`: built a frame later,
 * or fetching what it shows) is waited for under the old picture: the slide starts once it has
 * its content, so the drawer's height starts for what the page holds together with the slide,
 * instead of the page coming in at the old height and the panel then changing under it.
 */
export class SlidePages extends Component<SlidePagesProps> {
  private host = createRef<HTMLDivElement>();
  private live = createRef<HTMLDivElement>();
  private ghost: HTMLElement | null = null;
  private waiting: (() => void) | null = null;

  getSnapshotBeforeUpdate(previous: SlidePagesProps): HTMLElement | null {
    const page = this.live.current;
    if (previous.page === this.props.page || !page || !page.clientWidth) return null;
    if (typeof page.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
    // Still waiting for the page before: what is on screen is the picture it was to replace.
    if (this.waiting && this.ghost) return this.ghost;
    return still(page);
  }

  componentDidUpdate(previous: SlidePagesProps, _state: unknown, copy: HTMLElement | null) {
    const host = this.host.current, page = this.live.current;
    if (!copy || !host || !page) return;
    // A switch during a switch cuts to the newest pair.
    this.stopWaiting();
    if (this.ghost !== copy) this.ghost?.remove();
    page.getAnimations().forEach(animation => animation.cancel());
    const { order } = this.props;
    const forward = order.indexOf(this.props.page) >= order.indexOf(previous.page) ? 1 : -1;
    host.append(copy);
    (copy as HTMLElement & { restoreScroll?(): void }).restoreScroll?.();
    this.ghost = copy;
    if (!pending(page)) { this.slide(page, copy, forward); return; }
    // The old picture stays where it is, over the new page, until that page is ready.
    page.dataset.slideWaiting = "";
    const go = () => { this.stopWaiting(); this.slide(page, copy, forward); };
    const changed = new MutationObserver(() => { if (!pending(page)) go(); });
    changed.observe(page, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-drawer-pending"] });
    const timer = window.setTimeout(go, PENDING_WAIT_MS);
    this.waiting = () => { changed.disconnect(); window.clearTimeout(timer); delete page.dataset.slideWaiting; };
  }

  private stopWaiting() {
    this.waiting?.();
    this.waiting = null;
  }

  private slide(page: HTMLElement, copy: HTMLElement, forward: 1 | -1) {
    const timing = { duration: SLIDE_PAGES_MS, easing: EASE };
    const move = this.props.axis === "y" ? "translateY" : "translateX";
    copy.animate([{ transform: `${move}(0)` }, { transform: `${move}(${-100 * forward}%)` }], { ...timing, fill: "forwards" })
      .finished.then(() => { copy.remove(); if (this.ghost === copy) this.ghost = null; }, () => copy.remove());
    page.animate([{ transform: `${move}(${100 * forward}%)` }, { transform: `${move}(0)` }], timing);
  }

  componentWillUnmount() { this.stopWaiting(); this.ghost?.remove(); }

  render() {
    const { className, children } = this.props;
    return <div ref={this.host} className={className ? `kd-slide-pages ${className}` : "kd-slide-pages"}>
      <div ref={this.live} className="kd-slide-page">{children}</div>
    </div>;
  }
}
