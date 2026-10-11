# Mini player

The whole window can be taken down to the playing song's bubble and brought back. It is the
same window and the same page: playback, the list, its scroll position and every open panel
stay as they are, and nothing is handed to another WebView.

Code: `src/lib/miniPlayer.ts` (the steps), `src/components/player/MiniPlayer.tsx` and
`MiniPlayer.css` (the keys, the state as drawn), `src-tauri/src/mini_player.rs` (the window's
frame and its motion). macOS and Windows run the same steps through the same window calls.

## What the listener gets

- **Down.** The key 收成迷你播放器 in the tool row of the playing song's bubble. The whole
  window is gone at once, and the mini player pops out of the nearest corner of its screen at
  the place it was last left at (a short way, fading in). With no place of its own yet, that
  is where the bubble stood.
- **As the mini player.** The window is the bubble: cover, title, the mini transport. Under the
  title is the lyric that is being sung while the song has lyrics, the artist otherwise. It is
  moved by dragging it anywhere that is not a key or the transport. It floats over other
  windows and is on every desktop unless 置顶 is switched off (remembered). Its height follows
  the bubble's.
- **Another song.** The mini player stays where it is. Once the next cover is prepared, the
  cover, the song's text and the seek line cross-fade in place (the `turn` gesture's times,
  none of its travel: a half-rem lift reads as the strip being bumped); its surface, window
  keys and transport keys stay put. It never sends the window off screen and back. In the
  whole window the bubble keeps its usual roll down and rise.
- **Its keys.** 置顶 and 展开窗口 stand in a column at the right edge, as tall as the cover and
  level with its top and bottom edges (MiniPlayer.css); the title has the whole width between
  the cover and them. In the whole window the same two keys are in the bubble's tool row.
- **Back.** The key 展开窗口. The mini player goes into that corner again, and the whole
  window fades in as it was. The place the mini player was left at is remembered for next
  time, across launches (`mini-player.json` in the data directory); a place on a display that
  is gone is not used.
- A window that is the mini player with no song left to show gives the window back by itself.
  The app always starts as the whole window.

## Rules

- **Two things are seen, and no more: the pop and a fade.** Down: the whole window is gone
  at once, then the mini player pops out of its corner. Back: it goes into the corner, then
  the whole window fades in. This is the listener's own design (2026-10-12), after four
  others: do not add a step, and do not bring back anything that travels between the bubble's
  corner of the whole window and the mini player's place. What was there before and was
  taken out: the bar sliding away first, the bubble flying inside the page and then the window
  flying in an arc ("跳来跳去"), a second window standing in for the bubble, pauses that only
  made the result look calmer, and the mini player leaving the screen and coming back on
  every change of song.
- **The window never changes size where it can be seen.** A WebView shows its last picture,
  from the top-left corner, until the page has drawn for the new size. So the native side
  takes the window out of sight, gives it its size, and shows it when the page says it has
  drawn (`collapse`/`expand`, `fit`, then `reveal`); should the page never ask, it is shown
  after a moment anyway. Out of sight is all but clear on macOS, which brings a window that is
  given a size back onto its screen; elsewhere it is beyond the screens.
- **The page behind is never laid out for another size, not even once.** One layout of a long
  list costs a few hundred ms, and every one of them is time with nothing on the screen: as
  first built, each way had 0.7 s and more of that (`mini-down` / `mini-back` in the app's
  log, 2026-10-12), which is what made the mini player "vanish and come from nowhere". So:
  the page is given the whole window's size in px (`--kd-mini-w`, `--kd-mini-h`, on the body)
  *before* the window is given the bubble's (`collapse` leaves the size alone; the page asks
  with `fit` when it is ready), and gives it up only when the window is whole again
  (`sized`); the bar keeps its row while it is away (`MiniPlayer.css`); the bubble keeps the
  width it had (`--kd-mini-bw`), so its height is known before the window has it and the
  window needs one size. When changing any of this, measure: `mini-down`/`mini-back` give
  the time out of sight (`unseen`), and a profile of the page shows which layout came back.
- **The one wait is for the drawing, and it is as long as the drawing.** Out of sight, the
  page waits until it has the window's size and two frames more (`drawnFor`): the one that
  lays it out and the one that shows it. No time is added to that for the look of it.
- **What the page does for the other size is done out of sight and at once.** The bar going
  or coming, the bubble becoming the transport or giving it back, the page behind: none of
  these runs its own motion for the mini player. `data-kd-mini="on"` is set and taken away
  while the window is out of sight, `MiniPlayer.css` holds states only, and the bar's slide is
  ended for it (`barAtRest`).
- **The pop is the window's.** `pop` in `mini_player.rs` moves the mini player's own window a
  short way (`POP_PX`) between its place and the nearest corner of its screen (`tucked`),
  fading. It never reaches beyond the screen: macOS does not let a window past the top, and
  one sent there stops at the edge. Nothing is animated about the window's size (shrinking
  and growing it was tried twice and rejected).
- **The window follows the bubble's height** as soon as the bubble changes (`ResizeObserver`
  in `MiniPlayerHost`): another song's title, a row that came or went.
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
