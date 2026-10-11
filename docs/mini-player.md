# Mini player

The whole window can be taken down to the playing song's bubble and brought back. It is the
same window and the same page: playback, the list, its scroll position and every open panel
stay as they are, and nothing is handed to another WebView.

Code: `src/lib/miniPlayer.ts` (the steps), `src/components/player/MiniPlayer.tsx` and
`MiniPlayer.css` (the keys, the state as drawn), `src-tauri/src/mini_player.rs` (the window's
frame and its motion). macOS and Windows run the same steps through the same window calls.

## What the listener gets

- **Down.** The key 收成迷你播放器 in the tool row of the playing song's bubble. The whole
  window fades away as it is; the mini player appears where the bubble stood and jumps, in an
  arc like something thrown, to the place it was last left at. With no place of its own yet it
  stays where it appeared.
- **As the mini player.** The window is the bubble: cover, title, the mini transport. Under the
  title is the lyric that is being sung while the song has lyrics, the artist otherwise. It is
  moved by dragging it anywhere that is not a key or the transport. It floats over other
  windows and is on every desktop unless 置顶 is switched off (remembered). Its height follows
  the bubble's.
- **Another song.** The mini player stays where it is and shows the new song when the bubble
  has it. (In the whole window the bubble rolls down behind the bar and rises again; the mini
  player has no bar to go behind.)
- **Back.** The key 展开窗口. The mini player jumps back to the bubble's corner of the whole
  window and is gone as it lands; the whole window is there as it was. The place the mini
  player was left at is remembered for next time, across launches (`mini-player.json` in the
  data directory); a place on a display that is gone is not used.
- A window that is the mini player with no song left to show gives the window back by itself.
  The app always starts as the whole window.

## Rules

- **Two things are seen, and no more: a fade and the jump.** Down: the whole window's fade
  out, then the jump (the mini player appears during its first quarter). Back: the jump (the
  mini player is gone during its last quarter), then the whole window's fade in. Do not add a
  step between them. What was there before and was taken out on 2026-10-12, because together
  it made one press last well over a second and the listener asked what all of it was: the bar
  sliding away first, a flight of the bubble inside the page before the window went, a second
  window standing in for the bubble, pauses that only made the result look calmer, and the
  mini player leaving the screen and coming back on every change of song.
- **The window never changes size where it can be seen.** A WebView shows its last picture,
  from the top-left corner, until the page has drawn for the new size. So the native side
  takes the window out of sight, gives it its size, and shows it when the page says it has
  drawn (`collapse`/`expand`, then `reveal`); should the page never ask, it is shown after a
  moment anyway. Out of sight is all but clear on macOS, which brings a window that is given
  a size back onto its screen; elsewhere it is beyond the screens.
- **The one wait is for the drawing, and it is as long as the drawing.** Between going out of
  sight and being shown, the page waits until it has the window's new size and two frames
  more (`drawnFor`): the one that lays it out and the one that shows it. Showing the window
  before the page has the size shows the picture of the other size (seen as a flicker). No
  time is added to that for the look of it.
- **What the page does for the other size is done out of sight and at once.** The bar going
  or coming, the bubble becoming the transport or giving it back, the page behind: none of
  these runs its own motion for the mini player. `data-kd-mini="on"` is set and taken away
  while the window is out of sight, `MiniPlayer.css` holds states only, and the bar's slide is
  ended for it (`barAtRest`). A motion that began out of sight would be halfway when the
  window is shown.
- **The jump is the window's.** `jump` in `mini_player.rs` moves the mini player's own window
  along the arc (`along`), slow at both ends. The arc is lowered until it stays under the top
  of the screen (`arc_within`): macOS does not let a window above it, and one sent there stops
  at the edge and slides along it. An earlier version shrank and grew the window (first empty,
  then with the page drawn to fit) and was rejected both times: nothing is animated about the
  window's size.
- **The window has the bubble's height before it is shown.** It is given the height the mini
  player had last time (`lastHeight`), and the bubble's real height if that turns out
  different (`fit`), both out of sight. On show, it follows the bubble as soon as the bubble
  changes (`ResizeObserver` in `MiniPlayerHost`).
- **The mini player has the window** (`src/lib/windowTaken.ts`, as full-screen lyrics do) for
  as long as it lasts: that is what makes the page inert and sends the bar away, so the bar's
  own choice is neither read nor written. An app that had the window gives it back first.
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
- Under reduced motion every step happens at once, in the same order.
