# KDJ glib 0.18 security backport

This directory is the unmodified crates.io source for `glib 0.18.5`, except for the
two-line `VariantStrIter::impl_get` fix in `src/variant_iter.rs`.

The backport changes the output pointer passed to `g_variant_get_child` from an
immutable pointer reference to a mutable pointer reference, matching the upstream
implementation in `glib >= 0.20`. It addresses `RUSTSEC-2024-0429` while KDJ's
Tauri/GTK3 dependency chain still requires the 0.18 API family.

Upstream: https://github.com/gtk-rs/gtk-rs-core
Advisory: https://rustsec.org/advisories/RUSTSEC-2024-0429.html
License: MIT (see `LICENSE` and `COPYRIGHT` in this directory)
