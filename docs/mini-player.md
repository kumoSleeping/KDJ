# Mini player

The whole window can be taken down to the playing song's bubble and brought back. It is the
same window and the same page: playback, the list, its scroll position and every open panel
stay as they are, and nothing is handed to another WebView.

Code: `src/lib/miniPlayer.ts` (the steps), `src/components/player/MiniPlayer.tsx` and
`MiniPlayer.css` (the keys, the phases as drawn), `src-tauri/src/mini_player.rs` (the window's
frame). macOS and Windows run the same steps through the same window calls.

## What the listener gets

- **Down.** The key 收成迷你播放器 in the tool row of the playing song's bubble. The page folds
  into the bubble while the player bar leaves and the bubble becomes the transport; the window
  comes down to where the bubble stood and then goes to the place it was last left at.
- **As the mini player.** The window is the bubble: cover, title, the mini transport. It is
  moved by dragging it anywhere that is not a key or the transport. It floats over other
  windows unless 置顶 is switched off (remembered). Its height follows the bubble's.
- **Back.** The key 展开窗口. The mini player returns to its corner of the whole window, the
  window grows to the frame it had (maximized again if it was), and the page unfolds out of the
  bubble. The place it was left at is remembered for next time, across launches
  (`mini-player.json` in the data directory); a place on a display that is gone is not used.
- A window that is the mini player with no song left to show gives the window back by itself.
  The app always starts as the whole window.

## Rules

- **The window changes size only while it shows one flat colour** (the phase `flat`). A WebView
  draws its last picture from the top-left corner until the page has laid out for the new
  size, so a bubble on show at the bottom right would jump on every step. A move changes no
  layout: the bubble is on show while the window travels.
- **The phases** are on the document element, `data-kd-mini`: `folding` → `flat` → `on`, and
  `flat` → `unfolding` on the way back. `MiniPlayer.css` draws each; nothing else reads them.
- **The mini player has the window** (`src/lib/windowTaken.ts`, as full-screen lyrics do) for
  as long as it lasts: that is what hides the page, makes it inert and sends the bar away, so
  the bar's own choice is neither read nor written. An app that had the window gives it back
  first.
- **The page stays mounted and is not laid out** while it is hidden (`content-visibility`): it
  is there, at its scroll positions, the moment the window is back.
- **The main window's remembered frame is the whole window's.** While the mini player lasts,
  moves and resizes are not captured for it (`mini_player::active`).
- **Keys of a bubble that keep their own state** are `tools` in the bubble's spec
  (`taskBubbleSchema.ts`): drawn in the tool row after `actions`, not rebuilt with the spec.
- Under reduced motion every step happens at once, in the same order.
