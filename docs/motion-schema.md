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

## Lists

Rows of a list are not surfaces, but they move on the same clock and by the same rules (both
keyframe ends named, transform / opacity / clip only, marks set by a script and taken off when
the gesture ends, reduced motion = a short fade or nothing). Each list keeps its own keyframes
next to its styles:

| List | What moves | Code |
| --- | --- | --- |
| The sidebar tree and the compact rail | Shown: the rows arrive 12ms apart (the first twelve; all in by 292ms). A branch the user opens: its rows arrive the same way while what lies below slides down (240ms). A branch the user closes: its picture is covered from below as the rows under it close up (240ms). A playlist that was opened: 600ms later the rows travel to their new order (320ms), the opened one lifted. Only the user's own toggle moves a branch; a render, a selection, a count or a drag never does. | `components/library/sidebarMotion.ts`, `FolderTree.css` |
| The local track list | After navigation (the query version the table resets its scroll on): the first twelve rows fade in 8ms apart, all settled by 248ms. Never on a scroll, a re-render or a row update; the mark is dropped as soon as the list is scrolled. | `components/library/listArrival.ts`, `ListArrival.css` |
| The search results | A delivered list arrives row after row (28ms apart). | `components/download/ResultTable.css` |
| Rows being picked (both tables) | Picking starts: in every row's index cell the number steps back and the selection mark pops into its place (micro, spring); the head's label gives way to the all / some / none mark the same way. A mark fills from its centre and takes its tick when its row is picked. Picking ends: the marks go at once and the numbers come back (micro). No column is opened and nothing in a row moves. A row built while rows are being picked (scrolled in, another page) has its mark from the start. | `components/common/RowPick.tsx`, `RowPick.css` |
| A result row's download key | Fades in at the right-hand end of the first data column while the row is pointed at or has keyboard focus (micro-out); the cell's text is masked under it, not pushed aside. | `components/download/ResultDownloadKey.tsx`, `ResultTable.css` |

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

Not on it by design: the drawer, 曲目信息, the floating media window and the search bar keep
their own choreography on the same clock. Tooltips are the system's (`title`).
