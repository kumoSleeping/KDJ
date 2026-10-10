import { Component, createRef, type ReactNode } from "react";
import "./SlidePages.css";

export const SLIDE_PAGES_MS = 300;
const EASE = "cubic-bezier(0.22, 0.9, 0.26, 1)";

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
  to.forEach(node => node.removeAttribute("id"));
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
  className?: string;
  children: ReactNode;
}

/**
 * Switches pages by sliding sideways. The children are whatever the page in view renders; when
 * `page` changes, a still copy of the old picture slides out while the new one slides in from
 * the side its title lies on. Pages need not stay mounted, and nothing is asked of them.
 */
export class SlidePages extends Component<SlidePagesProps> {
  private host = createRef<HTMLDivElement>();
  private live = createRef<HTMLDivElement>();
  private ghost: HTMLElement | null = null;

  getSnapshotBeforeUpdate(previous: SlidePagesProps): HTMLElement | null {
    const page = this.live.current;
    if (previous.page === this.props.page || !page || !page.clientWidth) return null;
    if (typeof page.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
    return still(page);
  }

  componentDidUpdate(previous: SlidePagesProps, _state: unknown, copy: HTMLElement | null) {
    const host = this.host.current, page = this.live.current;
    if (!copy || !host || !page) return;
    // A switch during a switch cuts to the newest pair.
    this.ghost?.remove();
    page.getAnimations().forEach(animation => animation.cancel());
    const { order } = this.props;
    const forward = order.indexOf(this.props.page) >= order.indexOf(previous.page) ? 1 : -1;
    host.append(copy);
    (copy as HTMLElement & { restoreScroll?(): void }).restoreScroll?.();
    this.ghost = copy;
    const timing = { duration: SLIDE_PAGES_MS, easing: EASE };
    copy.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-100 * forward}%)` }], { ...timing, fill: "forwards" })
      .finished.then(() => { copy.remove(); if (this.ghost === copy) this.ghost = null; }, () => copy.remove());
    page.animate([{ transform: `translateX(${100 * forward}%)` }, { transform: "translateX(0)" }], timing);
  }

  componentWillUnmount() { this.ghost?.remove(); }

  render() {
    const { className, children } = this.props;
    return <div ref={this.host} className={className ? `kd-slide-pages ${className}` : "kd-slide-pages"}>
      <div ref={this.live} className="kd-slide-page">{children}</div>
    </div>;
  }
}
