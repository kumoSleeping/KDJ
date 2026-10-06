export const SEEK_TRANSITION_MS = 200;

export function prefersReducedSeekMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Presentation only: never delays transport or retains ownership of a decoder. */
export class SeekTransitionOverlay {
  private overlay: HTMLElement | null = null;
  private animation: Animation | null = null;
  private expiry = 0;
  private release: (() => void) | null = null;

  clear(): void {
    window.clearTimeout(this.expiry);
    this.expiry = 0;
    this.animation?.cancel();
    this.animation = null;
    this.overlay?.remove();
    this.overlay = null;
    const release = this.release;
    this.release = null;
    release?.();
  }

  show(host: HTMLElement, picture: HTMLElement, direction = 0): void {
    this.clear();
    if (prefersReducedSeekMotion() || typeof picture.animate !== "function") return;
    picture.setAttribute("aria-hidden", "true");
    Object.assign(picture.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      pointerEvents: "none", overflow: "hidden", zIndex: "2",
    });
    host.append(picture);
    this.overlay = picture;
    // A failed seek must not leave a frozen overlay covering subsequent playback.
    this.expiry = window.setTimeout(() => this.clear(), 2000);
    this.reveal(direction);
  }

  reveal(direction = 0): void {
    const picture = this.overlay;
    if (!picture || this.animation) return;
    const animation = picture.animate([
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: `translateX(${-Math.sign(direction) * 18}px)` },
    ], { duration: SEEK_TRANSITION_MS, easing: "ease-out", fill: "forwards" });
    this.start(animation, picture);
  }

  private start(animation: Animation, element: HTMLElement): void {
    this.animation = animation;
    // Use this presentation frame, not a later pending Web Animations play task.
    const time = element.ownerDocument.timeline?.currentTime;
    if (typeof time === "number") animation.startTime = time;
    animation.onfinish = () => { if (this.animation === animation) this.clear(); };
  }

  /** Fade the existing muted outgoing slot while its decoder keeps moving.
   * The caller releases it before reuse, on completion, or on cancellation. */
  videoHandoff(video: HTMLVideoElement, release: () => void): void {
    this.clear();
    if (prefersReducedSeekMotion() || typeof video.animate !== "function") { release(); return; }
    this.release = release;
    this.expiry = window.setTimeout(() => this.clear(), 2000);
    this.start(video.animate([
      { opacity: 1, zIndex: 2 }, { opacity: 0, zIndex: 2 },
    ], { duration: SEEK_TRANSITION_MS, easing: "ease-out", fill: "forwards" }), video);
  }

  video(video: HTMLVideoElement): void {
    this.clear();
    const host = video.parentElement;
    if (!host || !video.videoWidth || !video.videoHeight || prefersReducedSeekMotion()) return;
    // One bounded copy per handoff, not a permanent canvas-backed video pipeline.
    const picture = document.createElement("canvas");
    const scale = Math.min(1, 1280 / video.videoWidth, 1280 / video.videoHeight);
    picture.width = Math.max(1, Math.round(video.videoWidth * scale));
    picture.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = picture.getContext("2d", { alpha: false });
    if (!context) return;
    try { context.drawImage(video, 0, 0, picture.width, picture.height); }
    catch { return; }
    picture.style.objectFit = getComputedStyle(video).objectFit;
    picture.style.objectPosition = getComputedStyle(video).objectPosition;
    picture.style.background = "#000";
    this.show(host, picture);
  }

  waveform(host: HTMLElement, rail: HTMLElement, direction: number): void {
    this.clear();
    if (prefersReducedSeekMotion() || typeof rail.animate !== "function") return;
    const picture = document.createElement("div");
    // Keep beat labels and baked pixels together, without re-rasterizing the waveform.
    const copy = rail.cloneNode(true) as HTMLElement;
    copy.style.transform = getComputedStyle(rail).transform;
    const sources = rail.querySelectorAll("canvas");
    copy.querySelectorAll("canvas").forEach((canvas, index) => {
      const source = sources[index];
      if (source?.width && source.height) canvas.getContext("2d")?.drawImage(source, 0, 0);
    });
    picture.style.background = getComputedStyle(host).backgroundColor;
    picture.append(copy);
    this.show(host, picture, direction);
  }
}
