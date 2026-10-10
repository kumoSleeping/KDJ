/**
 * What the floating visualizer has found for one song. "ready": it has a picture to draw (the
 * song's cover, or one saved with its project) and its window is up. "empty": the song has
 * neither, and no window comes up for it. "loading": not known yet; the window waits. Nothing
 * about a library song's cover is known without asking for it, so every song starts here.
 */
export interface PopupPicture {
  song: number;
  content: "loading" | "ready" | "empty";
}

/**
 * The record after the mounted picture reports `content` for `song`. A window that has come up
 * stays up for its song: a picture being replaced, or one that stops drawing, reports "loading"
 * or "empty" again without the window going anywhere.
 */
export function popupPictureAfter(before: PopupPicture | null, song: number, content: PopupPicture["content"]): PopupPicture {
  if (before?.song !== song) return { song, content };
  if (before.content === "ready" || before.content === content) return before;
  return { song, content };
}

/**
 * Whether the window's controls, open in the drawer, stay open for `song`. They leave only once
 * the song is known to bring no window; while that is still being found out they follow it, so
 * going from one song with a picture to the next never closes them.
 */
export function popupSettingsStay(picture: PopupPicture | null, song: number): boolean {
  return picture?.song !== song || picture.content !== "empty";
}
