Vendored rbox 0.1.5 (MIT OR Apache-2.0) from crates.io.

Only KDJ's `one-library` feature and its required dependencies are retained in the local manifest.

KDJ patch: the OneLibrary r2d2 pool is capped at one connection because KDJ serializes OneLibrary HTTP database work. Upstream opens eight SQLite/SQLCipher connections concurrently and each runs PRAGMA journal_mode=WAL, producing repeated `database is locked` errors.
