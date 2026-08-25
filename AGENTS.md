# KDJ Repository Rules

## Project Intent

- KDJ is a non-commercial project. Non-commercial license terms MUST NOT be treated as a current integration blocker; still record and comply with attribution, share-alike, redistribution, and model-specific terms, and reassess before any future commercial distribution.

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
- Avoid `computer_use` unless GUI automation is strictly necessary; otherwise leave interactive testing to the player.
- GUI automation on Apple Silicon: launch with `CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER="$PWD/scripts/tauri-dev-gui-runner.sh" npm run tauri:dev`; the Cargo runner keeps the executable in that current dev session but registers it as `/tmp/KDJ Dev.app` (`com.kdj.dev`), which `computer_use` can target. Before operating it, verify the PID/path and parent session with `ps`/`lsappinfo` and `computer_use.list_apps`; never target `com.kdj.app`, `/Applications/KDJ.app`, or another KDJ process, and stop rather than guess if the identities differ.
- Pure frontend changes under `src/` or frontend CSS SHOULD use Vite HMR in the running Tauri dev session; do not fully restart the app for each frontend-only edit.
- Rust backend, `src-tauri/`, Tauri configuration, native capability, or startup changes MUST be validated by fully stopping and restarting `npm run tauri:dev` before reporting completion.

## UI Copy

- Empty lists and panels MUST stay empty. Do not add “未检测到…”, “尚未创建”, “新建第一个…”, default-value hints, or instructional filler.
- Expose available actions as concise controls (for example `+`); reserve UI copy for actual state, errors, and user data, and put configuration in formal panels or settings.
