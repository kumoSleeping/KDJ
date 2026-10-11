# Mini player

The whole window can be taken down to the playing song's bubble and brought back. It is the
same window and the same page: playback, the list, its scroll position and every open panel
stay as they are, and nothing is handed to another WebView.

Code: `src/lib/miniPlayer.ts` (the steps), `src/components/player/MiniPlayer.tsx` and
`MiniPlayer.css` (the keys, the phases as drawn), `src-tauri/src/mini_player.rs` (the window's
frame). macOS and Windows run the same steps through the same window calls.

## What the listener gets

- **Down.** The key 收成迷你播放器 in the tool row of the playing song's bubble. The player bar
  leaves and the bubble becomes the transport; the window comes down to where the bubble
  stands, the page growing smaller with it and the bubble coming up over the page as it goes;
  then it goes to the place it was last left at.
- **As the mini player.** The window is the bubble: cover, title, the mini transport. It is
  moved by dragging it anywhere that is not a key or the transport. It floats over other
  windows unless 置顶 is switched off (remembered). Its height follows the bubble's.
- **Back.** The key 展开窗口. The mini player returns to its corner of the whole window and the
  window grows to the frame it had (maximized again if it was): the page is under the bubble
  from the first frame and grows with the window while the bubble goes; the bar comes back when
  the window is whole. The place it was left at is remembered for next time, across launches
  (`mini-player.json` in the data directory); a place on a display that is gone is not used.
- A window that is the mini player with no song left to show gives the window back by itself.
  The app always starts as the whole window.

## Rules

- **There is never an empty window to watch.** From the press of the key to the bubble, and
  from the bubble back to the whole window, the listener sees the page or the bubble or both.
  A step that would show a blank window, or the window's colour and nothing else, is wrong
  however short it is.
- **While the window changes size, everything drawn is a function of the window's width and
  is anchored at the window's top-left corner.** A WebView shows its last picture from that
  corner until the page has drawn for the new size. The page drawn to fit the window, and the
  bubble drawn to fill it, are then at worst a frame late; anything held to the bottom right,
  or to a place on the screen, is thrown about by however late that frame is. `follow()` in
  `miniPlayer.ts` writes the two scales and the bubble's opacity on the elements themselves,
  once per frame (a custom property on the root would restyle the whole page each time).
- **The page keeps the whole window's layout** (`--kd-mini-w`, `--kd-mini-h`) from the moment
  the window starts to change until it is whole again: it is never laid out for a size on the
  way, and drawing it smaller is a transform.
- **The bubble is in two places during a change of size**: itself, laid out from the window's
  top-left corner and scaled to fill the window, and a still copy (`.kd-mini-ghost`) in the
  page where the bubble is in the whole window. Rules for the bubble as the mini player are
  written for the bubble in its stack (`.kd-task-host > .kd-task-slot > .kd-task`), so the
  copy keeps the look of the whole window's bubble.
- **The phases** are on the document element, `data-kd-mini`: `readying` → `shrinking` → `on`,
  and `growing` on the way back. `MiniPlayer.css` draws each; nothing else reads them.
- **The mini player has the window** (`src/lib/windowTaken.ts`, as full-screen lyrics do) for
  as long as it lasts: that is what makes the page inert and sends the bar away, so the bar's
  own choice is neither read nor written. An app that had the window gives it back first. The
  page is not hidden for it the way it is under full-screen lyrics until the bubble is the
  window.
- **The page stays mounted**, hidden while the window is the bubble: it is there, at its
  scroll positions, the moment the window starts to grow.
- **The main window's remembered frame is the whole window's.** While the mini player lasts,
  moves and resizes are not captured for it (`mini_player::active`).
- **Keys of a bubble that keep their own state** are `tools` in the bubble's spec
  (`taskBubbleSchema.ts`): drawn in the tool row after `actions`, not rebuilt with the spec.
- Under reduced motion every step happens at once, in the same order.
