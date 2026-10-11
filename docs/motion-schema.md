# The motion schema

Everything that comes and goes — a menu, a popover, a sheet, a small window, a notice — moves by
one description: the same clock, the same curves, the same handful of gestures. A surface does
not write its own keyframes or pick its own milliseconds; it names a gesture.

Code: `src/motion.css` (tokens, keyframes, the `data-kd-motion` rules, reduced motion) and
`src/lib/motion.ts` (the same durations for scripts, and the leaving picture).
The drawer has its own description on the same clock: `docs/drawer-schema.md`.

## Tokens

| Token | Value | For |
| --- | --- | --- |
| `--kd-motion-micro` | 160ms | a small surface arriving: menu, popover, tooltip, notice |
| `--kd-motion-micro-out` | 110ms | the same surface leaving; drag feedback |
| `--kd-motion-item` / `--kd-motion-stagger` | 112ms / 8ms | the items of a menu following its surface (all in by 208ms) |
| `--kd-motion-turn-gap` | 24ms | the items of a strip that turns over, one after the other (`turn`) |
| `--kd-motion-in` | 460ms | a large surface arriving: sheet, drawer, panel |
| `--kd-motion-out` | 360ms | a large surface leaving |
| `--kd-motion-reduced` | 80ms | every gesture under reduced motion |
| `--kd-ease-out` | `cubic-bezier(0.22, 0.9, 0.26, 1)` | arriving |
| `--kd-ease-in` | `cubic-bezier(0.55, 0, 0.8, 0.35)` | leaving |
| `--kd-ease-spring` | `cubic-bezier(0.25, 1.3, 0.45, 1)` | a small surface arriving: a little past its size, then settled |
| `--kd-float-edge` / `--kd-float-shadow` | per theme (`design.css`) | the edge of a small floating surface |

The large-surface pair and the two plain curves are the values of `src/lib/songSwapMotion.ts`
(`SONG_SWAP_*`). `src/lib/motion.ts` exports all durations as `MOTION_*_MS`; the token names are
stable, other surfaces are aligned to them.

## Gestures

| `data-kd-motion` | Arrives | Leaves | Use it for |
| --- | --- | --- | --- |
| `unfold` | grows out of its origin, from nothing to full size, with a soft overshoot (micro, spring) | folds back into the origin (micro-out) | whatever is opened *from a point*: a menu at the pointer, a popover under its button |
| `pop` | scales up about its own centre (micro, spring) | scales down a little and fades (micro-out) | whatever appears *in place*: a small window, a notice, a field that replaces a label |
| `slide` | slides in from the edge it is attached to (in, ease-out) | slides back out (out, ease-in) | a sheet or panel that belongs to an edge; `data-kd-edge="right|left|top|bottom"` |
| `fade` | opacity only (micro) | opacity only (micro-out) | what lies behind a surface: a scrim |

`turn` is the fifth gesture, for content that is **replaced in place** while what holds it stays:
a line of text, the items of a strip. It is not a `data-kd-motion` value, because the old and the
new content are different elements:

| Mark | Moves | Clock |
| --- | --- | --- |
| `data-kd-turn="out"` | lifts away and fades; it is a picture from here on (`inert`, `aria-hidden`) | micro-out, ease-in, `forwards` |
| `data-kd-turn="in"` | comes up from below and fades in | micro, ease-out, `backwards` |
| `data-kd-turn-after` (with `in`) | waits for the leaving one, where both are in the document at once | delayed by micro-out |
| `data-kd-turn-shift` + `--kd-turn-shift` | an item that stays glides from where it stood to its new place | micro, ease-out |

`--kd-turn-step` (0, 1, 2 …) is an item's place in its cascade, `--kd-motion-turn-gap` apart:
leaving counts from the last item, arriving from the first. Under reduced motion both are an
80ms fade without steps, and a shift is a jump.

- The origin of `unfold` is the element's `transform-origin`: set it inline, or with `--kd-origin`
  (default: top left). `ContextMenu` computes it: the pointer or the anchor's corner as seen from
  the menu after it was kept inside the window, so a menu lifted above its button grows upwards
  out of the button, and one pushed away from the right edge still grows out of the pointer.
- `data-kd-from="side"` turns `unfold` sideways: a menu opened from an item of another menu
  (`<ContextMenu unfoldFrom="side">`).
- Items follow: while a surface carries `data-kd-stagger="down|up"`, its direct children fade in
  one step apart, starting from the side the surface grows out of. The first ten are staggered,
  the rest start with the tenth, so a long menu opens as fast as a short one. `ContextMenu` sets
  the attribute for the opening only; an item added to an open menu simply appears.

## Rules

- Keyframes name **both** `from` and `to`. WebKit keeps an animation with an implied keyframe on
  the main thread.
- Only `transform` and `opacity` move (`clip-path` where a reveal needs it). No width, height,
  top, left, margin or shadow animation.
- Arriving uses `animation-fill-mode: backwards` only. Nothing of the animation stays on a
  surface that has arrived, so it is not a stacking context or a containing block afterwards.
- Measure before the gesture, never during it, and measure the layout box (`offsetWidth`,
  `offsetHeight`): a surface that is unfolding is scaled, and `getBoundingClientRect()` reports
  the scaled box.
- No script drives a frame. The gestures are CSS animations; `motion.ts` only marks the element.
- **Leaving never delays the action.** The owner unmounts the surface and runs its action at
  once; what folds away is a picture (`inert`, `aria-hidden`, `pointer-events: none`, no ids)
  that cannot take the next click.
- Reduced motion (`prefers-reduced-motion: reduce`) is handled once, in `motion.css`: every
  gesture becomes an 80ms fade and items do not stagger. A surface adds nothing for it.
- A surface in the flow (a notice, an inline field) has no leaving gesture: the space it held
  closes at once. Only a fixed or absolute surface leaves as a picture.
  The sidebar's branches are the one exception, and they keep to the rule's reason: React still
  removes the branch at once, the picture is placed absolutely over the place it held, and the
  rows below close up by `transform` (see "Lists" below) — nothing in the flow waits.
- The look of a small floating surface is shared too: `border: 1px solid var(--kd-float-edge)`,
  `box-shadow: var(--kd-float-shadow)`, a radius of 6–7px, `background: var(--kd-panel-raised)`.
  Groups inside it are set apart by spacing and a quiet label (`.kd-menu-heading`), never by a
  rule. A theme pack restyles the edge under its own selector.

## Opting in

A menu or popover: render `<ContextMenu>` (`src/components/common/ContextMenu.tsx`). It already
unfolds from its pointer or anchor, staggers its items, folds away, keeps inside the window,
handles focus, Esc and outside clicks. A button that opens one passes `anchorTop`,
`anchorElement` and `toggleAnchor`, so the menu hangs under the button, goes above it when there
is no room, and a second click closes it.

Anything else that is rendered while it is open — one step:

```tsx
import { motion } from "../../lib/motion";

{open && <div className="my-popover" {...motion("unfold")} />}
{open && <aside className="my-sheet" {...motion("slide", { edge: "bottom" })} />}
```

`motion()` supplies the `data-kd-motion` attribute (the arrival) and a ref that plays the
leaving gesture when React unmounts the element. Variants:

- The element needs its own `ref`: write `data-kd-motion="…"` yourself and call
  `leaveAfterUnmount(element)` in the cleanup of the layout effect that owns it
  (`FloatingPanelWindow` does).
- The element stays mounted while it leaves: write `data-kd-motion="…"` and set
  `data-kd-leaving` yourself for `leaveDuration(gesture)` milliseconds.
- Arrival only (in-flow content, or content too live to leave as a picture — video, canvases):
  the attribute alone (`InlineNotice`, the inline rename field, `Sheet`).

## What is on it

| Surface | Gesture |
| --- | --- |
| Every `ContextMenu`: track and result row menus, column menus, sidebar menus, the panel index, the toolbox, playback mode, lyrics menus, search suggestions, `Select` dropdowns | `unfold` + items, fold |
| `FloatingPanelWindow` | `pop`, both ways |
| The QR sign-in dialog of an account (`AccountRow`) | backdrop `fade` both ways, dialog `pop` |
| `Sheet` (phones; the portrait folder picker from the bottom) | `slide` in from its edge, scrim `fade`; closes at once |
| `InlineNotice`; the sidebar's new-folder row and rename field | `pop` in |
| Sidebar drag feedback (drop tint, insertion mark, lifted root) | micro-out clock, in `FolderTree.css` |
| The player bar put away and brought back (`PlayerBarAway.tsx`) | `slide` from the bottom edge, both ways; it stays mounted and sets `data-kd-leaving` itself |
| The work rail over a list (`WorkRail.tsx`, `railTurn.ts`) | `turn`, item by item — see below |
| A line that changes in the search bar: the tip line (every 8 s, and when the empty field is focused or left), the search kind (`RollText`) | `turn`: the old line `out`, the new one `in` after it |

### The work rail

The strip above a list (`.kd-activity`: the library's, the online results', a temporary
folder's) stays; its content turns over. The rail knows its items by key — glyphs, texts and
controls, then the tools at its right-hand end:

- An item whose key is gone leaves as a picture, the last one first; when the pictures are out,
  the items whose keys are new are laid out, the first one first. Three steps at most are
  staggered each way, so a full turn is over within 110 + 72 + 160 + 72 = 414 ms and a usual
  one (three items for three) in about 370 ms.
- An item whose key is the same before and after is not touched: it is the same element (a
  field keeps its text and focus) and, if the content before it changed width, it glides to
  its new place (`data-kd-turn-shift`). The text area takes all the width the two ends leave,
  so the tools at the right never move when the text changes.
- The same key with other text is not a turn: a progress count or a file name
  (「正在分析 3/4 首 · …」) changes where it stands. What is another thing gets another key —
  the name and the number of a folder are keyed by the folder, so going to another folder
  turns exactly those two over.
- A change during a turn joins it: what is no longer wanted starts to leave at once, what is
  wanted waits for the pictures. The rail waits for the animations themselves
  (`getAnimations()` … `finished`), not for a timer; where nothing is animated (a hidden pane,
  a test) a stage is over at once.
- Two rails that take each other's place — the local pane's and the online pane's when one
  pane is shown at a time, or two rails in the same pane — hand the strip over: the rail that
  stops being shown (`shown={false}`, or unmounted) leaves its items behind for that commit,
  and the rail that starts being shown lets them leave as pictures before it lays out its
  own. Two panes side by side keep their own strips.
- The controls of the new state are usable from the moment they are on the strip; a picture
  takes no click, no focus and is not read out by the strip's live region.

## Lists

Rows of a list are not surfaces, but they move on the same clock and by the same rules (both
keyframe ends named, transform / opacity / clip only, marks set by a script and taken off when
the gesture ends, reduced motion = a short fade or nothing). Each list keeps its own keyframes
next to its styles:

| List | What moves | Code |
| --- | --- | --- |
| The sidebar tree and the compact rail | Shown: the rows arrive 12ms apart (the first twelve; all in by 292ms). A branch the user opens: its rows arrive the same way while what lies below slides down (240ms). A branch the user closes: its picture is covered from below as the rows under it close up (240ms). A playlist that was opened: 600ms later the rows travel to their new order (320ms), the opened one lifted. Only the user's own toggle moves a branch; a render, a selection, a count or a drag never does. | `components/library/sidebarMotion.ts`, `FolderTree.css` |
| The local track list, presented | Every time the list is put before the user — at startup, as another folder or 全部曲目, after a sort or filter that replaced it, and each time its pane is shown again after the search results or an online playlist — the rows in view play the gesture of a presented list (below): the first fourteen rise 14px as they fade in, 28ms apart from the top one, each cover scales in 70ms after its row, the rest of the screen fades in a frame after the fourteenth; all there by 914ms. It plays where the list is, not only at its top. A track that loads while its row is arriving takes its contents in the same row, in step; a list replaced while it is still arriving (a filter typed letter by letter) lets the rows that stay carry on and starts only the ones new to the view. Never on a scroll at reading speed, a re-render, a selection or a row update; scrolling the list away ends it at once. The marks are on the rows alone, never on an ancestor. Sakura98 types the lines out on the same beats, without a glide. | `components/common/listArrival.ts`, `ListArrival.css` |
| Both lists, after a fast scroll | A scroll at reading speed finds its rows built beyond the viewport, and nothing moves. A fling that outruns the frames that build rows lands on places that show the panel colour (no stand-ins, no fake content); the rows built there chase it from the side it came from, on one clock: a row joins at the beat of its distance from that edge (8ms steps, 160ms each, cover 40ms behind; rising from below towards the end of the list, dropping from above towards the top), so rows built a frame apart still arrive one after another, and a row late for its beat is simply there. A chase is over 304ms after it began; the next late row starts another. Rows built once before come back as they are and do not replay it. | `components/common/listArrival.ts`, `ListArrival.css`, `components/common/rowList.ts` |
| The search results | Every list that is presented arrives by the same gesture: a delivered list (a search answer, a collection or an online playlist opened, the previous results brought back) and the pane coming back on screen. Fourteen rows rise one after another (28ms apart) from the first row in view, each cover scales in a beat after its row and the source badges after that; the rows behind them come together on the last beat. A delivery builds its blocks anew, so a list delivered during a cascade starts over on new rows. An opened collection grows in batches of 50 as its end is reached: a ring turns at the foot while a batch is fetched, then only the added rows in view arrive in the same cascade; the rows that were there and the scroll position do not move. Never on a re-render, a selection, an opened row or a scroll. A row's own mark for slotting in or unfolding comes off when that animation ends, so nothing replays when the pane is shown again. | `components/download/resultArrival.ts`, `resultBlocks.ts`, `ResultTable.css`, `components/common/listArrival.ts` |
| Rows being picked (both tables) | Picking starts: in every row's index cell the number steps back and the selection mark pops into its place (micro, spring); the head's label gives way to the all / some / none mark the same way. A mark fills from its centre and takes its tick when its row is picked. Picking ends: the marks go at once and the numbers come back (micro). No column is opened and nothing in a row moves. A row built while rows are being picked (scrolled in, another page) has its mark from the start. | `components/common/RowPick.tsx`, `RowPick.css` |
| A result row's download key | Fades in at the right-hand end of the first data column while the row is pointed at or has keyboard focus (micro-out); the cell's text is masked under it, not pushed aside. | `components/download/ResultDownloadKey.tsx`, `ResultTable.css` |
| The lyrics | When the sung line changes, the column's scroll position is set at once and the lines on screen glide to it from where they were (420ms, a curve that passes the centre line by about 2% and settles); the lines the column leaves behind follow 28ms apart (the first four). A line's emphasis — ink, opacity, size, and its two weights fading into each other — changes over the same time. A glide that is interrupted starts again from where each line has got to; a change further than the column is tall is a jump (the lines settle over 28px in 240ms). The listener's own scroll pauses following for 3s; a click on a line holds it until the seek has landed. When the song changes, the desktop drawer takes the whole old lyrics panel away (360ms) before bringing in the new one (460ms). Missing or pending lyrics keep the drawer suspended, without clearing the listener's enabled choice; only actual lyrics bring it back. The phone's shared sheet keeps the content-turn gesture for available lyrics, and omits missing lyrics. | `lib/lyricsGlide.ts`, `lib/lyricsTurn.ts`, `components/player/LyricsView.tsx`, `LyricsView.css` |

The gesture of a presented list is one description for both tables, in `motion.css` ("A list
that is presented"): the tokens `--kd-motion-list-lead` (60ms), `--kd-motion-list-step` (28ms),
`--kd-motion-list-row` (380ms), `--kd-motion-list-rest` (240ms), `--kd-motion-list-cover` (420ms),
`--kd-motion-list-cover-after` (70ms), the curves `--kd-ease-list` and `--kd-ease-list-cover`, and
the keyframes `kd-motion-list-rise`, `kd-motion-list-drop` and `kd-motion-list-cover`. A table says
for itself which rows are marked and when: the results by a script that marks the rows from the first one in view (`data-reveal` with the row's step, `components/download/resultArrival.ts`), the
local list by a script that marks the rows in view (`data-kd-arrive` on the scroll container,
`data-kd-arrive-row` and `--kd-arrive-i` on each row), because its rows are a window of a much
longer list.

A download has gestures of its own (`lib/downloadToss.ts`, timings in `lib/tossPath.ts`; the
download is handed to the queue when the parcel has nearly landed). One item started from a row
or a button: the block that was clicked turns into a parcel (180ms) and is thrown into the
downloads. Several at once — picked rows, a whole collection: the covers of the rows of the batch
that are on screen (six at most, a note glyph where a row has no loaded cover) travel to the
place that was clicked and stack there as a small fan, the parcel comes up out of the stack with
the count on it (320ms in all, in place of the lift), and then it is thrown the same way. Rows of
the batch that are not on screen are the count alone. A card dropped on the downloads hops into
the list as itself. A card let go on a place that does not take it shakes its head and fades
(`lib/dragRefusal.ts`, `DragGhost.css`). Under reduced motion nothing travels: the new task is
simply highlighted.

The lyrics' glide is the one place a script starts animations line by line (one compositor
animation per line on screen, from positions measured once per layout); nothing is read or
written while they run.

Not on it by design: the drawer, 曲目信息, the floating media window and the search bar keep
their own choreography on the same clock. Tooltips are the system's (`title`).

歌曲色彩 (the colour field behind the lyrics and the playing song's bubble,
`SongColorBackdrop.tsx`) is a backdrop, not a surface, and keeps to the rules above: its masses
drift and its glow swells by `transform` and `opacity` on layers painted once, both keyframe
ends named, no script per frame. Its three gestures: switched on, the colour spreads from its
key as one circle across both surfaces (`clip-path`, `backwards` fill, the front at 1.5 px/ms,
420–900 ms); switched off, it drains back into the key on `--kd-ease-in` (2.8 px/ms,
220–420 ms); another song's field fades in over the last one, evenly, over `--kd-motion-in`
once the last song's surfaces have left. Under reduced motion the field is still and all three are an 80 ms fade.
