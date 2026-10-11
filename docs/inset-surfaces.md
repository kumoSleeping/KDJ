# Inset surfaces

The window is not one flat sheet cut into regions. Three things stand on it, after the macOS
Finder (the listener's reference, 2026-10-11). Code: `src/components/workspace/InsetSurfaces.css`,
`src/components/library/LibraryFootBar.tsx`.

- **The sidebar is a panel of its own.** It keeps a gap to the window on every side
  (`--kd-inset-gap`) and has round corners, an edge and a soft shadow. It runs from the top of
  the window (the window buttons on macOS are in its head) to the bottom of the page, so what
  it lists ends at the panel's own bottom edge and is never cut off by the window's. It is one
  box drawn behind the top bar's corner and the folder column by the element that holds both
  (`.kd-section-body::before`); those two are clear over it. Only the full sidebar in a wide
  window: the narrow rail stays as it was.
- **A list stands on a bar.** `LibraryFootBar` is the last thing in the library's pane: the
  way down from the library root to the folder that is open (each step goes back to that
  folder) and the number of songs, with the number picked when more than one is. The list's
  last row ends at it at every window height. It says what is and nothing else.
- **The top bar's keys are raised round keys**: a circle of the raised panel colour with a soft
  shadow, a little apart from each other, lower while pressed.

Rules:

- A surface that floats is the list's own colour set apart by an edge and a shadow, as the
  drawer, the menus and the task bubbles are. None of these has a tone of its own, and no
  line is drawn between them: the gap separates the sidebar from the list, and the foot bar
  differs from the list by tone (`--kd-panel-inset`).
- A theme pack draws its own surfaces and a phone has no room to give away: neither gets any
  of this. Every rule in `InsetSurfaces.css` says so in its selector.
- The online results' pane has no foot bar yet.
