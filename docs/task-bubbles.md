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
- **The size.** `size` is `small` (a one-line note, as wide as its text), `regular` (default: a
  cover and two lines) or `large` (a big cover and a title-size name: the playing song). A kind
  of task picks the one that fits what it says; nothing sets a bubble's width or cover by hand.
  In a tall desktop window (`tall` in `src/lib/useLayoutMode.ts`) a `large` bubble spans the
  window, with the same gap on its left and its right; `regular` and `small` keep their size
  and stack above it at the right.
- **The stay.** Each kind chooses its own `stay`: the playing song 5 s, a short note such as
  "没有找到歌词" 3 s. `stay` in ms; left out, the tone decides (`TASK_STAY_MS`: 5 s, an error 10 s).
  `stay: 0` keeps the bubble until it is dismissed — a pinned or opened bubble. The ring shows the
  time that is left and stops while the stack is hovered or focused. Every bubble can be rolled
  down by hand; `escape: true` also lets Esc do it (only for a bubble the user called up).
  `dismiss: { label, icon? }` rewrites the key that rolls it down when doing so does more than
  put the bubble away — never by testing an id in the host.
- **Tone is not selection.** `info`, `success`, `error` colour the leading mark only (on a cover
  stack, a small mark on its corner); an error is amber, never the theme red. An error shows its
  whole sentence (up to four lines) instead of scrolling it.
- **Covers.** `covers` are drawn as up to three overlapping covers and a "+N" for the rest;
  `count` says how many things they stand for when that is more than the covers given. A cover is
  an address, or `{ key, urls }` with every address that can show it, best first — the host loads
  it with `useCoverLoad` (`src/lib/coverLoad.ts`), so a refused thumbnail falls back to the
  original. Where a task's covers come from is decided in `taskCovers.ts` only.
- **Where it comes from.** `origin: { label, mark }` is a small mark at the head of the facts
  line: the platform a song is streamed or was downloaded from. A brand mark keeps its own
  colour; the host places it.
- **Fuller content** goes in `body`; the host draws the control that expands it inside the same
  bubble. `replacesSummary` hides the compact summary while a body that restates it is open.
  No bubble uses it today: the playing song's no longer expands.
- **Live controls** go in `controls`: one row along the bottom of the bubble, in the compact and
  the expanded form alike. The task supplies the controls, the host their row. A task may give
  or take them while its bubble is up; the host then unfolds the row open or folds it away (its
  grid track between `0fr` and `1fr`, the row fading with it, 460 ms on the arriving curve both
  ways — the clock the stack is lifted by), the bubble growing upwards from its resting place.
  The host measures where the bubble's height is going once, before the row moves, so the
  bubbles stacked above and `--kd-info-lift` move there in one step alongside it.
  The playing song puts its mini transport there only while the player bar is away
  (`NowPlayingTransport.tsx`): previous, play / pause, next, the time played and a progress
  line that is the song's mini waveform when it has one. They send the player's own commands
  (`requestPlayerCommand`) and read the position from the player session without re-rendering
  the bubble. Beside the bar the bubble is an ordinary message, because the bar is the
  transport: a pinned bubble opens its transport as the bar starts down and closes it as the
  bar starts back up.
- **The keys.** `actions` are compact icon keys in the bubble's tool row, before the key that
  rolls it down; a `large` bubble has that row in its top right corner. A key that is on
  (`pressed`) is written in full-strength ink, never in red. The playing song's are 歌词, 小窗
  (the floating video or visualizer, the same toggle as the bar's own key), 编辑 Meta and 固定.
- **The caption bar (Sakura98).** In the Sakura98 pack a bubble is a small 98 window: the tools
  row (the ring, the actions, the key that rolls it down) is laid across its top as the window's caption bar,
  in the drawer caption's tone and type, with the bubble's name at its left; the summary, the
  body and the controls sit beneath on the face. The name comes from `kind`: `TASK_KIND_NAMES`
  in `TaskBubbleHost.tsx` (`playing` 正在播放, `download` 下载, `export` 导出, `import` 导入);
  any other kind is 提示. It is carried as `data-caption` on the tools row and drawn by the
  pack's rules in `TaskBubbles.css` only — the built-in themes show no name, and a task never
  writes its own caption.
- **Motion.** 460 ms up, 360 ms down, the easings of `src/lib/songSwapMotion.ts`; transform and
  opacity only; under reduced motion a short fade. A bubble with `song` belongs to the playing
  song: when that changes while the bubble is up, it rolls down with the old song and rises with
  the new one, and it is registered as a surface of the song.
- **The drawer.** `--kd-info-lift` is published only for a bubble that is kept up, so the drawer
  over the list ends above it; a bubble that leaves by itself may cover the drawer's bottom for
  its stay.
- **The bar put away.** The player bar can slide down out of the window
  (`src/lib/playerBarAway.ts`). The stack then stands on the window's bottom edge; bubbles that
  are up when the slide starts ride the bar's top edge while it slides.
- **The bar or the playing song's bubble.** The listener always has a transport on screen: the
  bar, the bubble, or both (`src/lib/nowPlayingInfo.ts`).
  - While the bar is away the bubble is up and stays up (`barAway`), from the moment the bar
    starts down. Nothing lets it leave by itself, and it is never pushed out.
  - Sending it away — its key, which then reads 展开播放条, Esc, the now-playing card — brings
    the bar back: the bubble rolls down as the bar slides up. That is the only way back to the
    bar.
  - Both at once is the pin. With the bar up, a pinned bubble stays beside it. With the bar
    away the pin key shows and changes the same preference: it says whether the bubble is still
    there when the bar is back. Dismissing a pinned bubble clears the pin, as everywhere.
  - Without a song there is nothing for the bubble to show, so the bar is up whatever was
    chosen; the choice is not rewritten and applies again when a song is on the deck. At launch
    the deck remembered from the last run counts as a song while it is being fetched.
  - Each shape of the window has its own choice: a wide window keeps the bar unless it was put
    away, a tall one keeps it away unless it was brought back. Crossing from one shape to the
    other is the same handover as the key. A slide always runs to its end; if what is wanted
    changes on the way, the bar arrives and sets off again.
  - A phone keeps its bar: the collapse is not offered there.
  - An app that has the window (full-screen lyrics, `takesWindow` in `docs/drawer-schema.md`)
    sends the bar away the same way for as long as it has it, without reading or writing
    either shape's choice. The bubble is then the window's lower block. Its 展开播放条 key
    still does what it says, and so also gives the window back.
- **No divider lines** inside a bubble (see AGENTS.md), and nothing is written in an empty one.

## Adding a kind of task

One call, from wherever the activity is started or observed:

```tsx
showTask({
  id: "cache-clear",                  // stable: the same id updates the same bubble
  kind: "cache",                      // styling hook (data-kind); names the caption bar
  title: "已清理缓存",
  detail: "释放 1.2 GB",               // optional quiet line
  facts: ["波形", "歌词"],              // optional short facts, one quieter line
  covers: [libraryCover(trackId)],    // optional: up to three shown, the rest "+N"
  count: 12,                          // optional: what the covers stand for
  icon: <Trash2 size={16} />,         // optional mark when there is no cover
  progress: 0.4,                      // optional 0..1
  tone: "success",                    // info | success | error
  stay: 5_000,                        // optional; 0 keeps it up
  origin: { label: "B站", mark: <PlatformMark id="bilibili" size={12} branded /> },  // optional
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
| A song starts (not pause/resume) | `now-playing`: cover, title, artist, the source's mark, BPM · key · length · format; 歌词, 小窗, 编辑 Meta, 固定; the mini transport while the bar is away | `NowPlayingTask.tsx` |
| Downloads started / progress / ended / failed | `downloads`: one bubble per run | source `downloads` |
| Exports added / started / ended / failed (mixing and visualizer) | `exports` | source `exports` |
| A folder import ended or failed | `import` | source `imports` |
| The player's own message (playback, transition and deck errors, "下一首已替换为…") | `player-notice` | `PlayerBar.tsx` `setNotice` |
| Every other former toast (window, fullscreen, import-drop, visualizer memory errors) | `notice:<text>` | `showNotice` |
