# The drawer and its schema

On a wide window everything that used to take the right column — lyrics, downloads and exports,
settings, the visualizer configuration, the Meta editor, search tips, duplicate analysis, a
network-video preview — is an **app of one drawer**.

The drawer is a **floating panel** opened by controls elsewhere in the window:

- **The entries** for downloads and settings live in the top window chrome at every width.
  Lyrics use the existing player controls. The aggregate search row has no drawer entry
  buttons or reserved space for them and uses the full available width.
- **The panel** slides in from the right over the list, below that row, and rests free of
  every edge, with a gap all round, rounded corners, a hairline edge and a soft shadow — the same
  floating surface as a task bubble or a menu (`--kd-float-edge`, `--kd-float-shadow`). It is the
  list's own colour: never give it a tone of its own (one narrow exception: the lyrics under
  歌曲色彩, see "A backdrop" below). It carries the app's title row (title or
  page tabs, then at the far end the tools and the roll-up button) and its body. It
  covers the list; it never takes a column from it, so the list does not reflow while the drawer
  moves. Its width is `--kd-drawer-w` (the dragged `--kd-right` up to 45 % of the list's column).

Code: `src/components/drawer/` (`drawerSchema.ts`, `Drawer.tsx`, `TitleTabs.tsx`,
`SlidePages.tsx`, `useDrawerOrder.ts`) and `src/components/workspace/drawerApps.tsx`
(`useDrawerApps`, `useDrawerEntries`). `DrawerHost` is mounted in the list's column
(`.kd-table-wrap`) by `Workspace.tsx`; the top row's layout is in `design.css`.

## Rules

- **One at a time.** A newly asked-for app comes down over the one that was there; that one rolls
  up beneath it and is closed. Nothing waits underneath: closing the drawer shows the list, and an
  app that is wanted again is asked for again from its own entry.
- **A song can replace the whole panel.** The lyrics keep the stable app id `lyrics`, but give
  `contentKey` the current song's id. On a change the host takes the old panel away with its
  old song before bringing in the new one, on the 360/460 ms song-change clock. A pending or
  missing lyric sets `suspended`: the shell stays put away, while its entry and remembered
  enabled state remain. Lyrics arriving later bring the panel back; no timeout opens an empty
  shell. A queued song that is skipped is discarded, never briefly drawn. Manual close still
  switches lyrics off. The phone's shared lyrics/downloads sheet also omits unavailable lyrics.
- **An app never draws its own shell.** No head, no close button, no frame, no background, no
  entrance or exit motion. It supplies a `DrawerSpec` and a body; `DrawerHost` draws the rest.
- **Opened from the chrome or from elsewhere.** Downloads and settings use the window chrome;
  lyrics use the player controls. Clicking an open app's toggle closes it (as do the roll-up
  button and Esc). Other apps open from their relevant controls, such as a row's menu or a
  button on the picture, and come down as the same panel. Do not add duplicate entries beside
  the search.
- **How far it comes down** is the spec's `extent`, measured from under the search row to the
  bottom of the list, less the gap (never lower than a bottom task bubble that is kept up,
  `--kd-info-lift`):
  - `fit` — the usual case: exactly as tall as what it holds needs, short or long, following the
    content as it changes (a switch of page included), up to the whole way down (settings, the
    visualizer configuration, the Meta editor, tips, duplicate analysis);
  - `at-least-half` — as `fit`, but never shorter than half the way. Only for an app that needs
    empty room even while it holds nothing: downloads, because things are dropped on its blank
    space (and the folder list, for the same reason);
  - `two-thirds` — always two thirds of the way, for a view with no height of its own (lyrics
    scroll about the line being sung);
  - `full` — always all the way down (a network-video preview: a docked picture with such a
    lyrics view beneath it).

  The height is never the listener's to set: there is no bottom edge to drag, and the extent
  above always decides it. Only the width is dragged.
  In a tall window a bubble that is kept across the bottom already ends the page a gap above
  itself, so a panel that comes all the way down there keeps no second gap of its own.
- **The lyrics choose their own.** A right click or a long press on the lyrics panel, or a
  right click on the lyrics key in the player bar or playing-song bubble, offers
  标准 (`two-thirds`), 更长 (`full`: down to just above the player bar, or the playing song's
  bubble while the bar is away) and, in a tall desktop window only, 全屏 (`takesWindow`, below).
  Pointer-opened height menus show the check mark without a keyboard focus ring; using the
  keyboard restores the focus indication. The choice is remembered (`src/lib/lyricsExtent.ts`); a stored 全屏 is shown and marked as
  更长 wherever it is not offered, without being rewritten.
- **What is measured.** A body's scrolling element carries the class `kd-scroll` (or
  `data-drawer-scroll`); `fit` and `at-least-half` measure what it lacks or has to spare. A
  scrolling element inside another is added to the one around it; of several side by side the
  neediest decides. The wrappers that lead down to it pass on the height they are given; every
  part beside it, and everything inside it, must have a height of its own. A picture or pane
  that takes `flex: 1` of what is left, or a page stretched with `min-height: 100%` inside the
  scrolling element, only fills what it is given and makes the measure meaningless — give it a
  size (a picture: a ratio and a cap) or keep the app out of the sized extents. A body that is
  still fetching what decides its height puts `data-drawer-pending` on an element until the
  first result or error is ready. Nothing is measured meanwhile; a `fit` panel waits beyond
  the edge (600 ms at most) rather than arriving at a short loading page's height. A leaving page's still copy
  does not keep the new page waiting.
- **When the body is built.** An `at-least-half` body is built with its panel and measured
  before the first paint. Any other body is built one frame after its panel, so a heavy app does
  not hold up that frame. A `fit` panel waits for its first measure and then comes in at the
  height it keeps, with its body already visible. The 120 ms fallback is only for a body
  without a measure; explicitly pending content is waited for up to 600 ms, then the panel
  comes in at its extent's default height and follows its measure. Height measurements stop throughout
  the entrance and resume once the panel rests; loading cannot resize it halfway into view.
- **Pages are the title.** An app with several pages lists them in `pages`; the drawer writes them
  as its title (`TitleTabs`: the page in view at title size in full-strength text colour, the others
  smaller and quiet beside it). The body wraps the part that changes in
  `<SlidePages page={…} order={…}>`, which slides the old picture out and the new one in from the
  side its title lies on. Pages need not stay mounted. The page in view is read where it is
  shown: the spec gives `usePage`, a hook the title row calls, and the body reads the same state
  itself. Never pass the page down from the component that lists the apps — a switch of page
  would then redraw the whole workspace before the drawer could answer. A page word answers the
  press, not its release, and the panel's height starts for the new page as the slide starts.
- **Many pages: the row is carried.** When the page words are more than the title row has room
  for, the row travels so that the page in view stands in the middle (`TitleTabs`,
  `--kd-tabs-carry`): choosing a word to the right brings those after it into reach, and a word
  beyond an edge fades out there instead of being painted over the tools. Nothing is added to
  the row for it — no arrows, no overflow menu. A row that fits is not moved.
- **The title row names the app, nothing more.** What the app is about right now (a song, a
  folder) is not written beside the title or the page words, and never on a line of its own
  under them: the body shows it where it is used. A song's name squeezed after four page
  words was cut short on most widths and was taken out (2026-10-11).
- **A backdrop — the one exception to the panel's colour.** A spec may give `backdrop`: a layer
  under the whole panel, title row included. The host draws it in the panel's backdrop slot
  (`src/components/common/SurfaceBackdrop.tsx`): the panel's first child, absolutely placed, one
  step below everything on the panel inside the panel's own stacking context (`isolation`, so
  the panel is not a containing block for anything it was not one for before) and inside its
  rounded clip. The panel's extent, edge, shadow, resize edges and motion are untouched, and
  the layer takes no pointer. A layer that changes what can be read calls `useBackdropInk()`;
  the panel then carries `data-backdrop-ink` and takes its text colours from the layer, scoped
  to that panel. This exists for one thing: the lyrics app while the listener has switched
  歌曲色彩 on (`SongColorBackdrop`, described in `docs/task-bubbles.md`), where the panel is the
  song's colours instead of the list's. No other app gives its panel a tone; do not use the
  slot for decoration. Where the lyrics are shown without a drawer (the sheet of a narrow
  window) the lyrics block has the same slot (`backdrop` on `PlayingLyricsPanel`).
- **No divider lines** inside a drawer (see AGENTS.md): groups are separated by spacing and type.
- **Motion.** The panel slides in from beyond the window's right edge in one decelerating move
  and stops; it leaves the same way, accelerating. A new app waits until the one before it has
  left completely. Only `transform` moves: what is on the panel rides
  with it, and its height follows its content only once it is at rest. Keep it that way — no
  bounce, no second layer fading over a moving panel.
- **Under a top bubble.** A task bubble that comes up at the top (`docs/task-bubbles.md`) lies
  over the panel's top for its stay; the panel is not moved, resized or measured again. An app
  does nothing for this.
- **Depth.** The panel and the floating media window share one order: whichever was opened or
  touched last is in front (`src/lib/surfaceOrder.ts`).
- **It takes no room.** The panel floats over the list and its toolbar; nothing beneath it is
  moved or resized for it. It is resized by its left edge only (width, up to most of the
  list's column); its height is its app's extent (2026-10-13: a dragged height pinned every
  app to one value and kept a `fit` panel from following its content, so it was taken out).
- **Refusing to close.** `close()` may return `false` (an unsaved draft). The drawer then stays,
  and an app that was opened over it gives way.
- **Held while something flies into it.** Motion aimed at an app (the download parcel,
  `src/lib/downloadToss.ts`) calls `holdDrawer(appId)` from `src/lib/drawerHold.ts` and releases it
  on landing. Until then the drawer keeps showing that app; another app that is asked for, or a
  close, is applied at the release, with its usual motion. A hold lets go by itself after 1.5 s,
  and an app that refuses to close is never covered by a held one.

## Taking the window

An app may ask for the whole window with `takesWindow: { label, leave }` in its spec (today:
full-screen lyrics in a tall desktop window). It is a mode of the same panel, not another
surface:

- **Two blocks.** The panel becomes the window's one block, from under the title bar down to
  the playing song's bubble, with the bubble's gap (12 px) to the window's edges and between
  the two. The bubble is the other block: it spans the bottom and carries the transport.
- **Everything else stands back** while `src/lib/windowTaken.ts` names the app:
  `.kd-app[data-taken-by]` fades the page under the title bar (`.kd-stage`) and then stops
  drawing it; `Workspace` makes it `inert`. It stays mounted, so the page is as it was left —
  scroll positions, selections — the moment the window is given back. The title bar and the
  window's own background stay. The player bar goes away as if it had been put away
  (`playerBarAwayWanted(…, taken)`), which keeps the bubble up with its transport; neither
  window shape's own choice for the bar is read or written for it.
- **The way back** is `leave`: the key at the end of the title row (it then carries `label`
  and another icon) and Esc call it instead of `close`, and the app returns to the `extent` in
  its spec. The bubble's 展开播放条 key also gives the window back, because the bar it calls
  needs its row. The app's own menu works as everywhere.
- **Motion.** The panel has the block's layout at once and grows into it: what is seen of it
  opens out from the drawer's rectangle by a `clip-path`, the title and the tools keep to their
  corners and the body's middle stays the middle of what is seen, by transforms — nothing is
  stretched, and both rectangles are measured once before anything moves (`morphPanel` in
  `Drawer.tsx`). 460 ms out, 360 ms back, the app's curves; the page fades on the same clock.
  Giving the window back plays it in reverse on the block's layout and the panel takes its
  drawer place when that has ended; the page is back and usable from the first frame. A body
  that is drawn larger in the window says by how much in `--kd-drawer-window-zoom` on its
  `.kd-drawer[data-app]`, and its content grows with the panel instead of jumping. Reduced
  motion: the layout changes at once.
- The panel is not resized by its edges while it has the window, and an app that is put away
  while it has the window leaves by the drawer's usual slide.

## Adding an app

1. Keep its open/closed state where it already lives (a store or workspace state).
2. Describe it in `useDrawerApps()` (`drawerApps.tsx`), or in `Workspace.tsx` when it depends on
   workspace-local state:

   ```tsx
   if (open) apps.push({
     id: "downloads",                 // stable; also data-app on the sheet
     title: "下载与导出",              // names the drawer; shown when there are no pages
     extent: "at-least-half",         // most apps: "fit"
     pages: taskViews,                // optional: [{ id, label, title? }]
     usePage: useTaskView,            // a hook: () => useTaskPanelStore(state => state.view)
     onPage: id => setTaskView(id),
     tools: <button …/>,              // optional compact actions before the close button
     closePage: id => …,              // optional: each page word gets its own ×, long words end in
                                      // an ellipsis (剪辑: one page per open project)
     titleDrop: { label, drop },      // optional: library rows dropped on the title row, drop(ids);
                                      // dropSearch(payload) takes search results too, labelFor(ids)
                                      // names the drop by what is dragged (剪辑: songs start another
                                      // project, a project opens as its page);
                                      // the row lifts a tone while it is over it, no other mark
     body: <DownloadTaskPages />,     // uses <SlidePages page={taskView} order={ids}>
     close: () => setDownloads(false),
   });
   ```

3. If it can be asked for again while open, call `useSidePanels.getState().raise(id)` from its
   entry so the drawer shows it.
4. If people open it by hand, give it an entry in `useDrawerEntries()`:

   ```tsx
   {
     id: "downloads",                 // the app's id; also data-drawer-entry on the control
     label: "下载",                    // a word or two beside the icon while rolled up
     title: "下载与导出",              // optional full name for the tooltip
     icon: <Download size={15} aria-hidden="true" />,
     count: running,                  // optional: a small number while the app is put away
     open: () => useSidePanels.getState().setDownloads(true),
   }
   ```

   Keep the list short: the entries are a few icons, not a toolbar.

## Reusing the pieces elsewhere

`TitleTabs` and `SlidePages` do not depend on the drawer. (`SlidePages` takes `axis="y"` for a
strip too low and too wide for a sideways pass: the player bar's two faces to the right of the
transport, `src/lib/playerBarFace.ts`, travel up and down.) Any panel with a few sibling pages
should use this pair instead of inventing another tab strip: `TitleTabs` for the title row
(`tabs`, `value`, `onChange`, actions as children) and `SlidePages` around
the content that changes. `useDrawer()` tells a component whether it is shown inside a drawer, so
that it can leave out a head it only needs elsewhere (see `VisualizerDock`).
