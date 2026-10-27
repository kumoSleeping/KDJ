/**
 * Holes in the page where mpv's pictures show through.
 *
 * mpv draws in native views under the WebView (mpv_player.rs), and the WebView paints no
 * background of its own. Everything of the app lives in #root; while a video plays, #root is
 * clipped with an even-odd path that leaves out each video's rectangle, and html/body stop
 * painting their background (design.css, :root[data-video-holes]). What draws over a video —
 * the floating window's controls — lives outside #root (a portal into document.body).
 */

export interface VideoHole {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

const holes = new Map<number, VideoHole>();
let nextId = 1;
let frame = 0;

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function subpath({ x, y, width, height, radius = 0 }: VideoHole): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) return `M${round(x)} ${round(y)}h${round(width)}v${round(height)}h${round(-width)}Z`;
  return `M${round(x + r)} ${round(y)}h${round(width - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}`
    + `v${round(height - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}h${round(-(width - 2 * r))}`
    + `a${r} ${r} 0 0 1 ${-r} ${-r}v${round(-(height - 2 * r))}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
}

function apply(): void {
  frame = 0;
  const root = document.getElementById("root");
  if (!root) return;
  if (holes.size === 0) {
    root.style.clipPath = "";
    delete document.documentElement.dataset.videoHoles;
    return;
  }
  const width = Math.max(window.innerWidth, document.documentElement.clientWidth);
  const height = Math.max(window.innerHeight, document.documentElement.clientHeight);
  let path = `M0 0H${width}V${height}H0Z`;
  for (const hole of holes.values()) path += subpath(hole);
  root.style.clipPath = `path(evenodd, "${path}")`;
  document.documentElement.dataset.videoHoles = "true";
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(apply);
}

window.addEventListener("resize", schedule);

/** A handle for one video's hole; `set(null)` closes it until the next `set`. */
export function createVideoHole(): { set(hole: VideoHole | null): void; dispose(): void } {
  const id = nextId++;
  return {
    set(hole) {
      const previous = holes.get(id);
      if (!hole) {
        if (!previous) return;
        holes.delete(id);
      } else {
        if (previous && previous.x === hole.x && previous.y === hole.y && previous.width === hole.width
          && previous.height === hole.height && previous.radius === hole.radius) return;
        holes.set(id, hole);
      }
      schedule();
    },
    dispose() {
      if (holes.delete(id)) schedule();
    },
  };
}
