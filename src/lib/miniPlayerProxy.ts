/**
 * The mini player's stand-in. While the main window changes between the whole window and the
 * mini player it is out of sight for a moment (src/lib/miniPlayer.ts), and the bubble with it.
 * So a second, small window stands in for the bubble: it is shown exactly over the bubble
 * before the main window goes, and taken away a little after the main window is back with the
 * bubble under it. The bubble is then never seen to leave the screen.
 *
 * The stand-in shows a picture, not the bubble: this hands it the bubble's markup as it is
 * now, the page's style sheets (once) and the attributes of the page's root, and its own page
 * (public/mini-proxy.js) lays that out as the bubble looks as the mini player. If it cannot be
 * shown in time the steps go on without it, as they did before there was one.
 */

/** What of a canvas's computed style its picture needs to lie where the canvas lay. */
const PLACED = ["position", "top", "right", "bottom", "left", "width", "height", "opacity", "transform", "transform-origin", "mix-blend-mode", "border-radius", "display"] as const;

/** The stand-in has the page's style sheets. */
let styled = false;

function picture(slot: HTMLElement): string {
  const copy = slot.cloneNode(true) as HTMLElement;
  // A copied canvas is empty: what the original shows goes across as an image.
  const drawn = slot.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, index) => {
    const original = drawn[index];
    const image = document.createElement("img");
    try { image.src = original.toDataURL(); } catch { return; }
    image.className = canvas.className;
    image.alt = "";
    const placed = getComputedStyle(original);
    for (const name of PLACED) image.style.setProperty(name, placed.getPropertyValue(name));
    canvas.replaceWith(image);
  });
  // A field's value is a property, not markup.
  const fields = slot.querySelectorAll("input");
  copy.querySelectorAll("input").forEach((field, index) => { field.setAttribute("value", fields[index].value); });
  // The bubble inside what its rules are written against: the stack's host, in the app's root.
  const host = slot.parentElement?.cloneNode(false) as HTMLElement | undefined;
  const app = document.querySelector(".kd-app")?.cloneNode(false) as HTMLElement | undefined;
  let outer: HTMLElement = copy;
  for (const shell of [host, app]) {
    if (!shell) continue;
    shell.append(outer);
    outer = shell;
  }
  const root: Record<string, string> = {};
  for (const attribute of Array.from(document.documentElement.attributes)) root[attribute.name] = attribute.value;
  return JSON.stringify({
    root,
    body: document.body.className,
    html: outer.outerHTML,
    ...(styled ? {} : {
      links: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), link => link.href),
      styles: Array.from(document.querySelectorAll("style"), style => style.textContent ?? ""),
    }),
  });
}

/**
 * Shows the stand-in over `rect` of the window (CSS px of the viewport), or over the whole
 * window when the window is the bubble already. False: it is not there, and nothing covers
 * the bubble's place.
 */
export async function raiseStandIn(slot: HTMLElement, rect: { x: number; y: number; width: number; height: number } | null): Promise<boolean> {
  const bridge = window.kdj?.miniPlayer;
  if (!bridge?.proxyShow) return false;
  try {
    const shown = await bridge.proxyShow(rect, picture(slot));
    if (shown) styled = true;
    return shown;
  } catch {
    return false;
  }
}

/** Takes the stand-in away: what it stood in for is under it. */
export function dropStandIn(): void {
  void window.kdj?.miniPlayer?.proxyHide?.().catch(() => {});
}
