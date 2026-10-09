# The drawer and its schema

On a wide window everything that used to take the right column — lyrics, downloads and exports,
settings, the visualizer configuration, the Meta editor, search tips, duplicate analysis, a
network-video preview — is an **app of one drawer**. The drawer hangs from the bottom edge of the
list's toolbar and is pulled down over the right of the list like a blind. It covers the list; it
never takes a column from it, so the list does not reflow while the drawer moves.

Code: `src/components/drawer/` (`drawerSchema.ts`, `Drawer.tsx`, `TitleTabs.tsx`,
`SlidePages.tsx`, `useDrawerOrder.ts`) and `src/components/workspace/drawerApps.tsx`.

## Rules

- **One at a time.** A newly asked-for app comes down over the one that was there; that one rolls
  up beneath it and is closed. Nothing waits underneath: closing the drawer shows the list, and an
  app that is wanted again is asked for again from its own entry.
- **An app never draws its own shell.** No head, no close button, no frame, no background, no
  entrance or exit motion. It supplies a `DrawerSpec` and a body; `DrawerHost` draws the rest.
- **How far it comes down** is the spec's `extent`:
  - `two-thirds` — always two thirds of the way (lyrics);
  - `content` — two thirds while everything fits, all the way down once it does not (downloads,
    the Meta editor, tips);
  - `full` — always all the way down (settings, the visualizer configuration).
  A body's scrolling element carries the class `kd-scroll` (or `data-drawer-scroll`); that is what
  `content` measures.
- **Pages are the title.** An app with several pages lists them in `pages`; the drawer writes them
  as its title (`TitleTabs`: the page in view at title size in the theme colour, the others
  smaller and quiet beside it). The body wraps the part that changes in
  `<SlidePages page={…} order={…}>`, which slides the old picture out and the new one in from the
  side its title lies on. Pages need not stay mounted.
- **No divider lines** inside a drawer (see AGENTS.md): groups are separated by spacing and type.
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
     extent: "content",
     pages: taskViews,                // optional: [{ id, label, title? }]
     page: taskView,
     onPage: id => setTaskView(id),
     tools: <button …/>,              // optional compact actions before the close button
     body: <DownloadTaskPages />,     // uses <SlidePages page={taskView} order={ids}>
     close: () => setDownloads(false),
   });
   ```

3. If it can be asked for again while open, call `useSidePanels.getState().raise(id)` from its
   entry so the drawer shows it.

## Reusing the pieces elsewhere

`TitleTabs` and `SlidePages` do not depend on the drawer. Any panel with a few sibling pages
should use this pair instead of inventing another tab strip: `TitleTabs` for the title row
(`tabs`, `value`, `onChange`, optional `caption`, actions as children) and `SlidePages` around
the content that changes. `useDrawer()` tells a component whether it is shown inside a drawer, so
that it can leave out a head it only needs elsewhere (see `VisualizerDock`).
