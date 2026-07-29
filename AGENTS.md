# KDJ Repository Rules

## Active Architecture

- **The only active desktop architecture is Rust + Tauri.**
- Use `npm run dev` or `npm run tauri:dev` for development.
- Use `npm run build` or `npm run tauri:build` for production builds.
- Backend work belongs in `crates/` and `src-tauri/`.
- Frontend work belongs in `src/` and must be validated against the Tauri shell.

## Disabled Legacy Architecture

- **Electron is retired and disabled. Do not run, repair, extend, package, or validate it.**
- **The Python sidecar is retired as a runtime.** It is retained only as read-only historical/reference material.
- Do not run `vite` with the old Electron plugin, `electron-builder`, `PyInstaller`, `sidecar/.venv`, or `python -m` kdj as an application runtime.
- Do not use `electron/`, `sidecar/`, or `electron-builder.yml` as evidence for the current architecture.
- Do not add new Electron/Python compatibility code. Port any still-useful behavior to Rust instead.

## Release

- A release push MUST update `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, and `src-tauri/tauri.conf.json` to the same intended version before committing.
- Verify the intended version is newer than the latest `v*` tag; never push release changes under the previous version number.

## Validation

- Frontend: `npm run typecheck` and `npm run tauri:web:build`.
- Rust: use the narrowest relevant `cargo test`/`cargo check`, then workspace validation when appropriate.
- GUI: launch only through `npm run tauri:dev`.
- Pure frontend changes under `src/` or frontend CSS SHOULD use Vite HMR in the running Tauri dev session; do not fully restart the app for each frontend-only edit.
- Rust backend, `src-tauri/`, Tauri configuration, native capability, or startup changes MUST be validated by fully stopping and restarting `npm run tauri:dev` before reporting completion.
