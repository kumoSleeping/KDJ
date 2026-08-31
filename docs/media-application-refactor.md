# Media application refactor

## Ownership contract

Provider adapters own external protocol details. Application services own user-visible behavior.
React components may submit play/download intent and render snapshots; they must not branch on a
provider to decide when a queue row appears, when a Deck becomes audible, or where an error lives.

```text
UI intent
  -> media action facade
  -> application service / task coordinator
  -> capability-selected provider adapter
  -> external service
```

## First vertical slice

- `DownloadTask.phase` exposes one provider-neutral lifecycle: waiting, authorizing, resolving,
  downloading, post-processing, relocating, importing and completed.
- external source preparation uses `/downloads/preparations/pending` and
  `/downloads/{id}/prepared-source`; platform challenges are injected through the frontend
  preparation-handler registry instead of being called by panels or stores.
- `src/lib/mediaActions.ts` is the only normal song-download UI use case. It reveals the queue
  before network preparation and then delegates task ownership to `downloadStore`.
- ordinary PlayerBar loads resolve local and provider streams through
  `playbackSourceForTrack` into the same `UnifiedPlayerSource` contract.
- video resolve/download now use an injected `VideoProvider` capability registry; server routes
  and the download coordinator no longer match concrete YouTube/Bilibili provider fields.

## Remaining migration

1. Move the preparation-handler registry behind a generic Tauri challenge broker so browser work
   is task-scoped and failures are published on the task rather than only logged.
2. Split the broad `MusicProvider` trait into catalog, account, playback, download, lyrics and
   browser-challenge capability ports. Construct them in one composition root.
3. Replace boolean aside flags with one discriminated aside state and adapt local and
   online detail data into a shared detail shell.
4. Remove source-kind inference from numeric track ids. Use an explicit media reference at every
   play/download boundary.
