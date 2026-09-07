# KDJ vendoring note

This directory contains `rookie` 0.5.6 from <https://github.com/thewh1teagle/rookie>
(MIT). KDJ uses it only on desktop to read `youtube.com` cookies from a browser
profile selected by the user.

Local changes:

- `rusqlite` 0.31 + bundled SQLite → `rusqlite` 0.35 without `bundled`. KDJ
  already links the same libsqlite3-sys line through its OneLibrary SQLCipher
  build; SQLCipher remains compatible with plain browser SQLite databases.
  Keeping one native sqlite provider avoids a Cargo `links = "sqlite3"`
  conflict and duplicate sqlite symbols.
- `profile.rs` adds profile-aware discovery and selected-profile loading. The
  upstream convenience functions stop at the first matching cookie database;
  KDJ instead lists opaque profile ids so the user can explicitly choose the
  browser identity being connected without exposing filesystem paths to the
  WebView.
- Firefox reads the live SQLite WAL with a read-only connection and a bounded busy timeout,
  rather than `immutable=1` (which silently misses recent browser logins). Truncated Mozilla
  recovery files return an error instead of panicking. The live-WAL regression uses a synthetic
  profile and removes it after testing; it never reads the user's browser credentials.
- The retired Internet Explorer ESE reader is behind a non-default
  `internet-explorer` feature. KDJ supports current Windows browsers and does
  not ship the unrelated native `libesedb` build.
