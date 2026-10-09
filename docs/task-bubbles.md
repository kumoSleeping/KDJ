# 任务信息: task bubbles and their schema

Anything the app reports while the user is doing something else — a song has started, a
download or an export has started, ended or failed, an action could not be carried out — is a
**task bubble**. A bubble rises from behind the top edge of the player bar to a resting place at
the bottom right that is detached from the bar (a gap to the bar and to the window edge, round on
every corner, a soft shadow and no drawn line), stays for a while and rolls back down. There is
no other toast, snackbar or corner pop-up in the app.

Code: `src/components/tasks/` (`taskBubbleSchema.ts`, `taskBubbleStore.ts`, `TaskBubbleHost.tsx`,
`TaskBubbles.css`, `taskBatch.ts`, `taskSources.ts`, `taskCovers.ts`). The song's own bubble is
`src/components/player/NowPlayingTask.tsx`.

## Rules

- **A task is described, never drawn.** Its owner calls `showTask(spec)`; `TaskBubbleHost` draws
  the surface, the cover stack, the countdown ring, the hold while the pointer or the focus is in
  the stack, the entrance and the exit. No kind of task brings its own frame, close button or
  motion.
- **One bubble per id.** Showing an id that is up changes that bubble in place and starts its stay
  over. `updateTask(id, patch)` changes it without restarting the stay and does nothing when it is
  not up. `dismissTask(id)` rolls it down.
- **The stack.** The newest bubble rests nearest the bar and lifts the older ones. More than
  `TASK_VISIBLE_LIMIT` (3) that leave by themselves, and the oldest of them leave now, an error
  last. A bubble that is kept up (`stay: 0`) is not counted and never pushed out.
- **The stay.** `stay` in ms; left out, the tone decides (`TASK_STAY_MS`: 5 s, an error 10 s).
  `stay: 0` keeps the bubble until it is dismissed — a pinned or opened bubble. The ring shows the
  time that is left and stops while the stack is hovered or focused. Every bubble can be rolled
  down by hand; `escape: true` also lets Esc do it (only for a bubble the user called up).
- **Tone is not selection.** `info`, `success`, `error` colour the leading mark only (on a cover
  stack, a small mark on its corner); an error is amber, never the theme red. An error shows its
  whole sentence (up to four lines) instead of scrolling it.
- **Covers.** `covers` are drawn as up to three overlapping covers and a "+N" for the rest;
  `count` says how many things they stand for when that is more than the covers given. A cover is
  an address, or `{ key, urls }` with every address that can show it, best first — the host loads
  it with `useCoverLoad` (`src/lib/coverLoad.ts`), so a refused thumbnail falls back to the
  original. Where a task's covers come from is decided in `taskCovers.ts` only.
- **Fuller content** goes in `body`; the host draws the control that expands it inside the same
  bubble. `replacesSummary` hides the compact summary while a body that restates it is open.
- **Motion.** 460 ms up, 360 ms down, the easings of `src/lib/songSwapMotion.ts`; transform and
  opacity only; under reduced motion a short fade. A bubble with `song` belongs to the playing
  song: when that changes while the bubble is up, it rolls down with the old song and rises with
  the new one, and it is registered as a surface of the song.
- **The drawer.** `--kd-info-lift` is published only for a bubble that is kept up, so the drawer
  over the list ends above it; a bubble that leaves by itself may cover the drawer's bottom for
  its stay.
- **No divider lines** inside a bubble (see AGENTS.md), and nothing is written in an empty one.

## Adding a kind of task

One call, from wherever the activity is started or observed:

```tsx
showTask({
  id: "cache-clear",                  // stable: the same id updates the same bubble
  kind: "cache",                      // styling hook (data-kind)
  title: "已清理缓存",
  detail: "释放 1.2 GB",               // optional quiet line
  facts: ["波形", "歌词"],              // optional short facts, one quieter line
  covers: [libraryCover(trackId)],    // optional: up to three shown, the rest "+N"
  count: 12,                          // optional: what the covers stand for
  icon: <Trash2 size={16} />,         // optional mark when there is no cover
  progress: 0.4,                      // optional 0..1
  tone: "success",                    // info | success | error
  stay: 5_000,                        // optional; 0 keeps it up
  actions: [{ id: "undo", label: "撤回", icon: <Undo2 size={14} />, onSelect: undo }],
  onOpen: () => openSettings(),       // the bubble itself was clicked
});
```

A plain sentence from code that has nothing else to say goes through `showNotice(text)`
(`src/stores/toastStore.ts`); a sentence that reports a failure is shown as an error.

An activity that already lives in a store and should report without a call from its entry points
is a **source** (`taskSources.ts`): it subscribes to the store and feeds a
`createBatchReporter({...})` (`taskBatch.ts`), which turns a run of like tasks into one bubble — starts within
`TASK_BATCH_SETTLE_MS` are announced together ("X 等 5 首"), the bubble follows their progress
while it is up, says so when one fails, and comes back with the outcome when none is left running.
A start is not announced while the list that shows it is already open; the outcome always is.
Name the source in the `sources` of the window's `<TaskBubbleHost>`.

## What reports today

| Task | Bubble | Where |
| --- | --- | --- |
| A song starts (not pause/resume) | `now-playing`: cover, title, artist, BPM · key · length · format; 歌词, 编辑 Meta, 固定; expands to the library's summary | `NowPlayingTask.tsx` |
| Downloads started / progress / ended / failed | `downloads`: one bubble per run | source `downloads` |
| Exports added / started / ended / failed (mixing and visualizer) | `exports` | source `exports` |
| A folder import ended or failed | `import` | source `imports` |
| The player's own message (playback, transition and deck errors, "下一首已替换为…") | `player-notice` | `PlayerBar.tsx` `setNotice` |
| Every other former toast (window, fullscreen, import-drop, visualizer memory errors) | `notice:<text>` | `showNotice` |
