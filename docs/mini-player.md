# Mini player

The whole window can be taken down to the playing song's bubble and brought back. It is the
same window and the same page: playback, the list, its scroll position and every open panel
stay as they are, and nothing is handed to another WebView.

Code: `src/lib/miniPlayer.ts` (the steps), `src/components/player/MiniPlayer.tsx` and
`MiniPlayer.css` (the keys, the phases as drawn), `src-tauri/src/mini_player.rs` (the window's
frame). macOS and Windows run the same steps through the same window calls.

## What the listener gets

- **Down.** The key 收成迷你播放器 in the tool row of the playing song's bubble. The player bar
  leaves and the bubble becomes the transport; the bubble flies in an arc, like something
  thrown, to the place it was last left at; the whole window is gone at once and the bubble is
  a window of its own. With no place of its own yet it stays where it is.
- **As the mini player.** The window is the bubble: cover, title, the mini transport. Under the
  title is the lyric that is being sung while the song has lyrics, the artist otherwise. It is
  moved by dragging it anywhere that is not a key or the transport. It floats over other
  windows and is on every desktop unless 置顶 is switched off (remembered). Its height follows
  the bubble's.
- **Another song.** In the whole window the bubble rolls down behind the bar and rises with
  the new song. The mini player has the screen for a window: it leaves past the nearest edge
  of its screen and comes back with the new song (not past an edge another screen lies
  beyond; with none free it changes in place).
- **Back.** The key 展开窗口. The whole window is there at once, its bubble's corner empty and
  the bubble still at its place; the bubble flies back into the corner, and the bar returns.
  The place it was left at is remembered for next time, across launches (`mini-player.json` in
  the data directory); a place on a display that is gone is not used.
- A window that is the mini player with no song left to show gives the window back by itself.
  The app always starts as the whole window.

## Rules

- **Nothing is animated about the window's size, and there is never an empty window to
  watch.** The whole window goes and comes at once. An earlier version shrank and grew the
  window (first empty, then with the page drawn to fit) and was rejected both times: the one
  thing that moves is the bubble's flight.
- **The window never changes size where it can be seen.** A WebView shows its last picture,
  from the top-left corner, until the page has drawn for the new size (a window that grows
  shows the window's own colour where the picture ends). So the native side takes the window
  out of sight, gives it its size, and shows it at its frame when the page has drawn
  (`collapse`/`expand`, then `reveal`); should the page never ask, it is shown after a moment
  anyway. Out of sight is all but clear on macOS, which brings a window that is given a size
  back onto its screen (moving it beyond the screens there showed the resize: a flicker going
  down, and a tall blank window before the whole one coming back); elsewhere it is beyond the
  screens. Everything done to the window in between, the main window's smallest size
  included, comes after it is out of sight.
- **Who flies.** While the mini player's place lies wholly inside the whole window's frame,
  the page flies the bubble (`fly()` in `miniPlayer.ts`, a transform along `flightPath`): down
  before the whole window goes, back after it has come, which is the order the listener is
  meant to see. A place outside that frame cannot be drawn by a page that ends at the
  window's edge: then the mini player's own window flies (`settle`, `recall`), after the whole
  window has gone and before it is back. Both use the same time, curve and rise.
- **The phases** are on the document element, `data-kd-mini`: `readying` → (`flying`) → `on`,
  and `landing` on the way back. `MiniPlayer.css` draws each; nothing else reads them.
- **The mini player has the window** (`src/lib/windowTaken.ts`, as full-screen lyrics do) for
  as long as it lasts: that is what makes the page inert and sends the bar away, so the bar's
  own choice is neither read nor written. An app that had the window gives it back first. The
  page is not hidden for it the way it is under full-screen lyrics: it is on show whenever the
  window is the whole window.
- **The page keeps the whole window's layout** (`--kd-mini-w`, `--kd-mini-h`) while the window
  is the bubble, and is not drawn: it is never laid out for the bubble's size and is there, at
  its scroll positions, the moment the window is whole again.
- **The lyric line** is written into the bubble's description from outside (`useMiniPlayerLyric`
  in `MiniPlayer.tsx`), so `NowPlayingTask` knows nothing of the mini player; it is handed back
  to the artist when the mini player ends.
- **The main window's remembered frame is the whole window's.** While the mini player lasts,
  moves and resizes are not captured for it (`mini_player::active`).
- **Keys of a bubble that keep their own state** are `tools` in the bubble's spec
  (`taskBubbleSchema.ts`): drawn in the tool row after `actions`, not rebuilt with the spec.
- Under reduced motion every step happens at once, in the same order, and another song changes
  in place.
