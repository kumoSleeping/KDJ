import { Component, createRef, type ReactNode } from "react";
import { MOTION_IN_MS, MOTION_OUT_MS, MOTION_STAGGER_TOTAL_MS, prefersReducedMotion } from "../../lib/motion";
import { SONG_SWAP_IN_EASE, SONG_SWAP_OUT_EASE } from "../../lib/songSwapMotion";

interface Props { changeKey: string; className?: string; children: ReactNode; stagger?: boolean }
/** Keep the frame in place; an inert picture rolls away before the new contents unfold. */
export class TurnContents extends Component<Props> {
  private host = createRef<HTMLDivElement>();
  private live = createRef<HTMLDivElement>();
  private ghost: HTMLElement | null = null;
  getSnapshotBeforeUpdate(previous: Props) {
    const live = this.live.current;
    if (previous.changeKey === this.props.changeKey || !live?.offsetWidth || !live.animate || prefersReducedMotion()) return null;
    const copy = live.cloneNode(true) as HTMLElement;
    copy.inert = true;
    copy.setAttribute("aria-hidden", "true");
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
    const originals = live.querySelectorAll<HTMLElement>("*");
    const clones = copy.querySelectorAll<HTMLElement>("*");
    const offsets = [...originals].map(node => node.scrollTop);
    return { copy, clones, offsets };
  }
  componentDidUpdate(_previous: Props, _state: unknown, snapshot: ReturnType<TurnContents["getSnapshotBeforeUpdate"]>) {
    if (!snapshot || !this.host.current || !this.live.current) return;
    const { copy, clones, offsets } = snapshot;
    this.ghost?.remove();
    this.live.current.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
    Object.assign(copy.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    this.host.current.append(copy);
    clones.forEach((node, i) => { node.scrollTop = offsets[i]; });
    this.ghost = copy;
    const old = this.props.stagger ? [...copy.children] : [copy];
    const next = this.props.stagger ? [...this.live.current.children] : [this.live.current];
    const step = MOTION_STAGGER_TOTAL_MS / Math.max(old.length, next.length, 1);
    const outgoingStagger = Math.min(old.length - 1, 8) * step;
    old.forEach((node, i) => node.animate([
      { opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-1rem)" },
    ], { duration: MOTION_OUT_MS, delay: Math.min(old.length - i - 1, 8) * step, easing: SONG_SWAP_OUT_EASE, fill: "forwards" }));
    next.forEach((node, i) => node.animate([
      { opacity: 0, transform: "translateY(1rem)" }, { opacity: 1, transform: "translateY(0)" },
    ], { duration: MOTION_IN_MS, delay: MOTION_OUT_MS + outgoingStagger + Math.min(i, 8) * step, easing: SONG_SWAP_IN_EASE, fill: "backwards" }));
    const animations = copy.getAnimations({ subtree: true });
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => { copy.remove(); if (this.ghost === copy) this.ghost = null; });
  }
  componentWillUnmount() { this.ghost?.remove(); }
  render() {
    return <div ref={this.host} className={`kd-turn ${this.props.className ?? ""}`}>
      <div ref={this.live} className="kd-turn-live">{this.props.children}</div>
    </div>;
  }
}
