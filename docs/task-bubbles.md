# 任务信息: task bubbles and their schema

Anything the app reports while the user is doing something else — a song has started, a
download or an export has started, ended or failed, an action could not be carried out — is a
**task bubble**. A bubble rises from behind the top edge of the player bar to a resting place at
the bottom right that is detached from the bar (a gap to the bar and to the window edge, round on
every corner, a soft shadow and no drawn line), stays for a while and rolls back down. One that
answers something pressed in the window's top row comes up at the top right instead, the same
bubble in mirror image. There is no other toast, snackbar or corner pop-up in the app.

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
- **The place.** `placement` is `bottom` (the default) or `top`. It is chosen by where the
  listener is looking when the task reports, not by what the task is: `top` is for the answer to
  something pressed or dropped in the top row (the drawer's entries, the list's work rail), which
  would not be seen at the other end of the window. Downloads, which the search row and the
  AI (`docs/ai-dock.md`) start, and the AI's own steps report at the top too. What any other
  activity reports by itself — an export, an import, the song, the player's messages — stays
  at the bottom.
  - A top bubble drops from behind the bottom edge of the search row to a place at the top right,
    under the drawer's entries, and leaves upwards behind the same edge. Its key points up.
    Everything else — surface, sizes, tones, ring, hold, Esc, keys, the caption bar of a theme
    pack — is the bottom bubble's: nothing is drawn again for the top. In the stylesheet one
    sign (`--kd-task-dir`) turns the stack and the gesture over.
  - That place is where the drawer's panels hang (`.kd-drawer-area`: under the search row, two
    rows down in a tall window, left of an editor column). The host measures its top and right
    edge when a bubble comes up there and when it changes size. A window without a drawer (a
    phone, an editor window) hangs the stack under its top bar (`--kd-chrome-top`, which
    includes a phone's status-bar inset).
  - The place is read when the bubble arrives. `updateTask` cannot move a bubble; showing an id
    that is up at the other place sends that bubble away where it is — its owner is not told of
    a dismissal — and brings a new one up where it is now wanted.
- **The stack.** Each place has its own, and they mirror each other. The newest bubble rests
  nearest the stack's edge (the bar; at the top, the search row) and moves the older ones away
  from it. More than `TASK_VISIBLE_LIMIT` (3) in one place that leave by themselves, and the
  oldest of them there leave now, an error last. A bubble that is kept up (`stay: 0`) is not
  counted and never pushed out. The stay waits while the pointer or the focus is in that stack.
- **The base.** `base: true` makes a bubble the floor of its stack: it rests nearest the edge
  whatever arrives after it, and nothing that comes or goes moves it. Later bubbles rest beyond
  it, the newest nearest to it. They come out from behind it and go back behind it — the base is
  drawn over them, and they start just inside its far edge — instead of crossing its face from
  the stack's edge; one the base cannot hide (a larger size, or taller than the base) travels to
  the edge like any other. The playing song is the base of the bottom stack, kept up or not:
  it is the bubble with keys on it, and in a tall window it is the transport, so a download
  notice must not slide in under it and shove it — nor, kept up, change the height the page and
  the drawer keep clear of (`--kd-info-lift`). The host orders by this flag; it never tests an id.
- **The size.** `size` is `small` (a one-line note, as wide as its text), `regular` (default: a
  cover and two lines) or `large` (a big cover and a title-size name: the playing song). A kind
  of task picks the one that fits what it says; nothing sets a bubble's width or cover by hand.
  In a tall desktop window (`tall` in `src/lib/useLayoutMode.ts`) a `large` bubble spans the
  window, with the same gap on its left and its right; `regular` and `small` keep their size
  and stack above it at the right, where they rise from behind it.
  The one exception is `resizable: true`, for a bubble that is read at length (the AI's plans and
  messages): the listener drags its inner (left) edge to set the width, the height still follows
  what it holds, the width is kept per `kind`, and a double click on the edge gives the usual
  width back. The owner still sets no width itself.
- **The stay.** Each kind chooses its own `stay`: the playing song 5 s, a short note such as
  "没有找到歌词" 3 s. `stay` in ms; left out, the listener's own length decides (设置 → 通用 → 提示停留, 30 s by default;
  `taskDefaultStay`), an error twice that, and downloads twice that too.
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
  original. For the playing song only, `taskCoverPreparation.ts` fetches and decodes the cover before
  the arrival: the work starts with the song change, while the previous song is leaving, and
  the peek waits for it 300 ms at most. Preparation shares a small decoded-image cache and
  tries fallback addresses within that budget. A failed or late cover means the no-cover face
  for that arrival, not an image popping into a bubble that is already up; a later opening
  tries again. While preparing, the bubble takes no stack space and spends none of its stay; an
  existing one keeps its picture and its live controls. Every other bubble comes up at once and
  shows its covers as they load. Where a task's covers come from is decided in `taskCovers.ts` only.
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
  line that is the song's mini waveform when it has one: bars in the colours the bar's rail
  paints the song in, each reaching up and down as far as the sound does there; the part not
  played yet gives most of its colour up to a neutral (`--kd-now-wave-rest`,
  `--kd-now-wave-tint` on `.kd-now-line`, for a surface behind the bubble to retune), and a
  stretch of an online song that is not analysed yet is the plain line. They send the player's
  own commands (`requestPlayerCommand`) and read the position from the player session without re-rendering
  the bubble. Beside the bar the bubble is an ordinary message, because the bar is the
  transport: the bubble opens its transport as the bar starts down and closes it as the bar
  starts back up.
- **The keys.** `actions` are compact icon keys in the bubble's tool row, before the key that
  rolls it down; a `large` bubble has that row in its top right corner. A key that is on
  (`pressed`) is normally written in full-strength ink, never in red. The playing song's switches
  keep their ordinary muted ink and stroke in either state; their labels and `aria-pressed`
  still describe the state. Its lyrics key also opens the panel's height menu by right click or
  the keyboard menu key (`TaskAction.onContextMenu`), without toggling lyrics. Its keys are 歌词, 小窗
  (the floating video or visualizer, the same toggle as the bar's own key) and 歌曲色彩, one
  row; there is no pin (what holds the bubble is decided, `nowPlayingInfo.ts`) and the way down
  to the mini player is among the window's keys at the top right. Each button carries its
  action's id as `data-task-action`.
- **A backdrop.** `backdrop` is a layer of the task's own under everything the bubble holds. The
  host draws it in the bubble's backdrop slot (`src/components/common/SurfaceBackdrop.tsx`): the
  first child of the bubble, absolutely placed, one step below its content in the bubble's own
  stacking context and inside its rounded clip. The bubble's size, edge, shadow and motion are
  not the layer's to change, and the host does not know what the layer is. A layer that changes
  what can be read on the bubble calls `useBackdropInk()` with the ink that reads on it; the
  host then sets `data-backdrop-ink` and the `--kd-backdrop-*` values on the bubble, where
  `SurfaceBackdrop.css` maps them to `--kd-text`, `--kd-text-body`, `--kd-muted`, `--kd-faint`
  and `--kd-theme` for that bubble only. Nothing is ever written on the document for it. The
  one such layer is the playing song's 歌曲色彩 (below); a bubble is otherwise the list's colour.
- **歌曲色彩.** A look that is off until its key switches it on (remembered in
  `kd-song-color`): the key is on the playing song's bubble and beside the lyrics key on the
  player bar, never in the window's top bar, because the look belongs to those two surfaces
  and not to the window. The lyrics panel and playing-song bubble, and nothing else,
  carry the cover's hues: pale colour with dark ink in the light theme, a deep field with light
  ink in the dark theme.
  Only the backdrop layers animate: never capture or crossfade the whole page, its text or
  its floating messages. Each bubble keeps its opaque theme background underneath the colour
  layers, including while the colour is loading, changing songs or switching off.
  `src/lib/songColorPalette.ts` makes the field from
  the colours `extractStudioPalette` finds (four masses, a floor and a glow, each brought into a
  band of lightness that keeps the ink's contrast floor; a cover in greys stays grey; without a
  cover that can be read it is a calm slate). `SongColorBackdrop.tsx` draws it: the masses are small bitmaps painted once per song
  and stretched over the surface, each drifting by `transform` on a slow loop of its own; a
  glow and the field swell on the beat by one animation as long as a bar, set to the song's
  place when it starts, is sought or changes tempo and corrected only when the player's reports
  show a drift (`src/lib/songColorBeat.ts`); the song's loudness, read from its overview once a
  bar, sets how strong the pulse is and how fast the masses drift. No frame is driven by a
  script, no filter is drawn, and everything stops while the song is paused or the window
  hidden; under reduced motion the field is still. Switched on, the colour spreads from the
  key as one circle over both surfaces (`clip-path`, measured once); switched off, it drains
  back into the key, quicker; another song's colours fade in over the last on the song-change
  clock. Both backdrops share one cover extraction session. While it is off no cover is fetched
  for this look and nothing of it listens to the player. Under a theme pack the look is not offered: the pack draws the two
  surfaces its own way, so the key and the layer are left out and the choice is kept.
- **The caption bar (Sakura98).** In the Sakura98 pack a bubble is a small 98 window: the tools
  row (the ring, the actions, the key that rolls it down) is laid across its top as the window's caption bar,
  in the drawer caption's tone and type, with the bubble's name at its left; the summary, the
  body and the controls sit beneath on the face. The name comes from `kind`: `TASK_KIND_NAMES`
  in `TaskBubbleHost.tsx` (`playing` 正在播放, `download` 下载, `export` 导出, `import` 导入);
  any other kind is 提示. It is carried as `data-caption` on the tools row and drawn by the
  pack's rules in `TaskBubbles.css` only — the built-in themes show no name, and a task never
  writes its own caption.
- **Motion.** 460 ms in, 360 ms out, the easings of `src/lib/songSwapMotion.ts`; transform and
  opacity only; under reduced motion a short fade. A bottom bubble rises and rolls back down, a
  top one drops and leaves upwards: one pair of keyframes, whose far end (`--kd-task-drop`) lies
  below the one and above the other. A bubble with `song` belongs to the playing
  song: when that changes while the bubble is up, it rolls down with the old song and rises with
  the new one, and it is registered as a surface of the song.
- **The drawer.** `--kd-info-lift` is published only for a bottom bubble that is kept up, so the
  drawer over the list ends above it; a bubble that leaves by itself may cover the drawer's
  bottom for its stay. The top stack lies over the drawer's panel, which stays where it is:
  notices are the upper layer, settings and the other apps the lower one, and a top bubble is
  its own width (24rem at most), not the panel's.
- **The bar put away.** The player bar can slide down out of the window
  (`src/lib/playerBarAway.ts`). The stack then stands on the window's bottom edge; bubbles that
  are up when the slide starts ride the bar's top edge while it slides. A bubble that leaves
  as the bar starts back (the playing song's, sent away to bring the bar back) goes down
  behind the rising bar, never across its face: with nothing to ride, the bottom stack is
  drawn under the bar for that slide.
- **The bar or the playing song's bubble.** The listener always has a transport on screen: the
  bar, the bubble, or both (`src/lib/nowPlayingInfo.ts`).
  - While the bar is away the bubble is up and stays up (`barAway`), from the moment the bar
    starts down. Nothing lets it leave by itself, and it is never pushed out.
  - Sending it away — its key, which then reads 展开播放条, Esc, the now-playing card — brings
    the bar back: the bubble rolls down as the bar slides up. That is the only way back to the
    bar.
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
  placement: "top",                   // optional: the answer to something pressed in the top row
  origin: { label: "B站", mark: <PlatformMark id="bilibili" size={12} branded /> },  // optional
  actions: [{ id: "undo", label: "撤回", icon: <Undo2 size={14} />, onSelect: undo }],
  onOpen: () => openSettings(),       // the bubble itself was clicked
  backdrop: <MyLayer />,              // optional, rare: a layer under the bubble's content
});
```

A plain sentence from code that has nothing else to say goes through `showNotice(text)`
(`src/stores/toastStore.ts`); a sentence that reports a failure is shown as an error. Its third
argument is the placement (`useToastStore.getState().show(text, "top")`).

An activity that already lives in a store and should report without a call from its entry points
is a **source** (`taskSources.ts`): it subscribes to the store and feeds a
`createBatchReporter({...})` (`taskBatch.ts`), which turns a run of like tasks into one bubble — starts within
`TASK_BATCH_SETTLE_MS` are announced together ("X 等 5 首"), the bubble follows their progress
while it is up, says so when one fails, and comes back with the outcome when none is left running.
A start is not announced while the list that shows it is already open; the outcome always is.
Name the source in the `sources` of the window's `<TaskBubbleHost>`.

## What reports today

| Task | Bubble | Place | Where |
| --- | --- | --- | --- |
| A song starts (not pause/resume) | `now-playing`: cover, title, artist (two lines, no figures); 歌词, 小窗, 歌曲色彩; the mini transport while the bar is away; the song's colours as its backdrop while 歌曲色彩 is on | bottom, the base | `NowPlayingTask.tsx` |
| Downloads started / progress / ended / failed | `downloads`: one bubble per run | top | source `downloads` |
| Exports added / started / ended / failed (mixing and visualizer) | `exports` | bottom | source `exports` |
| A folder import ended or failed | `import` | bottom | source `imports` |
| The player's own message (playback, transition and deck errors, "下一首已替换为…") | `player-notice` | bottom | `PlayerBar.tsx` `setNotice` |
| The playing song has no lyrics to open ("没有找到歌词") | `lyrics-entry`, small, 3 s | top when asked from the drawer's 歌词 entry; bottom from the bar's key or the song's bubble | `lyricsEntry.ts` `requestPlayingLyrics(onOpened, near)` |
| A search result dropped on the 下载 entry could not be queued ("加入队列失败…") | `notice:<text>` | top | `downloadDropEntry.ts` |
| Cancelling an import from the list's work rail failed ("取消导入失败…") | `notice:<text>` | top | `LibraryWorkRail.tsx` |
| A YouTube video, its preview or its download stopped for a login ("YouTube 登录已失效", "YouTube 需要先登录") | `login-needed:youtube`, its 登录 key opens that source's ways to log in | bottom | `loginNeeded.tsx` `reportLoginNeeded` |
| The AI's steps, a message it sends (`tell_user`), what went wrong (`docs/ai-dock.md`) | `ai:<call>`, `ai-tell:<call>`, `ai:problem` | top | `components/ai/aiEvents.tsx` |
| The listener's request to the AI and its supplements, until done | `ai-task:<id>`, kept up | bottom | `aiEvents.tsx` |
| A question from the AI (`ask_user`): songs and choices, the listener's words, pause | `ai-ask:<call>`, the AI's countdown | bottom | `aiEvents.tsx` |
| Every other former toast (window, fullscreen, import-drop, visualizer memory errors) | `notice:<text>` | bottom | `showNotice` |
