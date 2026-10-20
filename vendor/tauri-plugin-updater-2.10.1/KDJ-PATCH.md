# KDJ tauri-plugin-updater 2.10.1 zip upgrade

This directory is the unmodified crates.io source for `tauri-plugin-updater 2.10.1`
(`banner.png` and the crate's own `Cargo.lock` left out), except for one line in
`Cargo.toml`: the Windows-only `zip` dependency asks for `9` instead of `4`.

Every 2.x release of the plugin requires `zip ^4`. On Windows it extracts a downloaded
update with `ZipArchive::extract`, which zip fixed only in 9.0.0:

- RUSTSEC-2026-0367: SUID/SGID bits preserved during extraction
- RUSTSEC-2026-0368: `extract` creates symlinks whose targets leave the destination
- RUSTSEC-2026-0369: `extract` applies Unix permissions through symlinks

The plugin uses only `ZipArchive::new`, `ZipArchive::extract` and `zip::result::ZipError`,
which zip 9 keeps, so no source change is needed. Drop this directory and the
`[patch.crates-io]` entry once an upstream release requires a fixed zip.

Upstream: https://github.com/tauri-apps/plugins-workspace (plugins/updater)
License: Apache-2.0 OR MIT (see `LICENSE_APACHE-2.0`, `LICENSE_MIT`, `LICENSE.spdx`)
