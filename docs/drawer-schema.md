# The drawer and its schema

On a wide window everything that used to take the right column — lyrics, downloads and exports,
settings, the visualizer configuration, the Meta editor, search tips, duplicate analysis, a
network-video preview — is an **app of one drawer**.

The drawer is a **floating panel** with two parts:

- **The entries** are icons at the right end of the aggregate search's row and are always there
  and always usable (下载, 歌词, 设置 — `DrawerEntry`; icons only, no words). The open app's icon
  is written in full-strength text colour, the others muted.
- **The panel** slides in from the right over the list, below that row, and rests free of
  every edge, with a gap all round, rounded corners, a hairline edge and a soft shadow — the same
  floating surface as a task bubble or a menu (`--kd-float-edge`, `--kd-float-shadow`). It is the
  list's own colour: never give it a tone of its own. It carries the app's title row (title or
  page tabs, then at the far end the caption, tools and the roll-up button) and its body. It
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
- **An app never draws its own shell.** No head, no close button, no frame, no background, no
  entrance or exit motion. It supplies a `DrawerSpec` and a body; `DrawerHost` draws the rest.
- **Opened from an entry or from elsewhere.** An app that people open by hand has an entry beside
  the search (`useDrawerEntries`): clicking it opens the app, clicking the open app's entry closes
  it (as do the roll-up button and Esc). An app that is only opened from elsewhere — a row's
  menu, a button on the picture — has no entry and comes down as the same panel. Do not add a second button for an app that has
  an entry (the window chrome keeps 下载 and 设置 only where there is no drawer, on a phone).
- **How far it comes down** is the spec's `extent`, measured from under the search row to the
  bottom of the list, less the gap (never lower than a task bubble that is kept up,
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

  A height the user dragged (the bottom edge) replaces any of these until it is reset.
- **What is measured.** A body's scrolling element carries the class `kd-scroll` (or
  `data-drawer-scroll`); `fit` and `at-least-half` measure what it lacks or has to spare. A
  scrolling element inside another is added to the one around it; of several side by side the
  neediest decides. The wrappers that lead down to it pass on the height they are given; every
  part beside it, and everything inside it, must have a height of its own. A picture or pane
  that takes `flex: 1` of what is left, or a page stretched with `min-height: 100%` inside the
  scrolling element, only fills what it is given and makes the measure meaningless — give it a
  size (a picture: a ratio and a cap) or keep the app out of the sized extents. A body that is
  still fetching what decides its height puts `data-drawer-pending` on an element until it has
  it; nothing is measured meanwhile, and the panel is half the way down.
- **When the body is built.** An `at-least-half` body is built with its panel and measured
  before the first paint. Any other body is built one frame after its panel, so a heavy app does
  not hold up that frame. A `fit` panel waits beyond the edge for its first measure (a few
  frames, 120 ms at most) and then comes in at the height it keeps.
- **Pages are the title.** An app with several pages lists them in `pages`; the drawer writes them
  as its title (`TitleTabs`: the page in view at title size in full-strength text colour, the others
  smaller and quiet beside it). The body wraps the part that changes in
  `<SlidePages page={…} order={…}>`, which slides the old picture out and the new one in from the
  side its title lies on. Pages need not stay mounted. The page in view is read where it is
  shown: the spec gives `usePage`, a hook the title row calls, and the body reads the same state
  itself. Never pass the page down from the component that lists the apps — a switch of page
  would then redraw the whole workspace before the drawer could answer. A page word answers the
  press, not its release, and the panel's height starts for the new page as the slide starts.
- **The caption is on the title's line.** What the app belongs to right now (a song, a folder)
  is `caption`: small, in the muted colour, at the far end of the title row before the tools,
  on the title's baseline. It has only the room the title leaves and is cut short with an
  ellipsis first; the page words are never squeezed by it. It keeps to the far end so that it
  does not move when the page words change size. Never write it, or anything else, on a line of
  its own under the title. An app that can only be about one thing has none: the lyrics are
  always the playing song's, so their title row does not repeat the song.
- **No divider lines** inside a drawer (see AGENTS.md): groups are separated by spacing and type.
- **Motion.** The panel slides in from beyond the window's right edge in one decelerating move
  and stops; it leaves the same way, accelerating. A new app waits until the one before it has
  left completely. Only `transform` moves: what is on the panel rides
  with it, and its height follows its content only once it is at rest. Keep it that way — no
  bounce, no second layer fading over a moving panel.
- **Depth.** The panel and the floating media window share one order: whichever was opened or
  touched last is in front (`src/lib/surfaceOrder.ts`).
- **It takes no room.** The panel floats over the list and its toolbar; nothing beneath it is
  moved or resized for it. It is resized by its left edge (width, up to most of the list's
  column) and its bottom edge (height; a double click returns to the app's extent).
- **Refusing to close.** `close()` may return `false` (an unsaved draft). The drawer then stays,
  and an app that was opened over it gives way.
- **Held while something flies into it.** Motion aimed at an app (the download parcel,
  `src/lib/downloadToss.ts`) calls `holdDrawer(appId)` from `src/lib/drawerHold.ts` and releases it
  on landing. Until then the drawer keeps showing that app; another app that is asked for, or a
  close, is applied at the release, with its usual motion. A hold lets go by itself after 1.5 s,
  and an app that refuses to close is never covered by a held one.

## Adding an app

1. Keep its open/closed state where it already lives (a store or workspace state).
2. Describe it in `useDrawerApps()` (`drawerApps.tsx`), or in `Workspace.tsx` when it depends on
   workspace-local state:

   ```tsx
   if (open) apps.push({
     id: "downloads",                 // stable; also data-app on the sheet
     title: "下载与导出",              // names the drawer; shown when there are no pages
     caption: songLine(track),        // optional: what it belongs to right now
     extent: "at-least-half",         // most apps: "fit"
     pages: taskViews,                // optional: [{ id, label, title? }]
     usePage: useTaskView,            // a hook: () => useTaskPanelStore(state => state.view)
     onPage: id => setTaskView(id),
     tools: <button …/>,              // optional compact actions before the close button
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

`TitleTabs` and `SlidePages` do not depend on the drawer. Any panel with a few sibling pages
should use this pair instead of inventing another tab strip: `TitleTabs` for the title row
(`tabs`, `value`, `onChange`, optional `caption` at the far end of the title's line, actions as
children) and `SlidePages` around
the content that changes. `useDrawer()` tells a component whether it is shown inside a drawer, so
that it can leave out a head it only needs elsewhere (see `VisualizerDock`).
