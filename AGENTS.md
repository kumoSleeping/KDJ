# KDJ Repository Rules

## Project Intent

- KDJ is a non-commercial project. Non-commercial license terms MUST NOT be treated as a current integration blocker; still record and comply with attribution, share-alike, redistribution, and model-specific terms, and reassess before any future commercial distribution.

## Active Architecture

- **The only active desktop architecture is Rust + Tauri.**
- Use `npm run dev` or `npm run tauri:dev` for development.
- Use `npm run build` or `npm run tauri:build` for production builds.
- Backend work belongs in `crates/` and `src-tauri/`.
- Frontend work belongs in `src/` and must be validated against the Tauri shell.

## Disabled Legacy Runtime

- **The Python sidecar is retired as a runtime.** It is retained only as read-only historical/reference material.
- Do not run `PyInstaller`, `sidecar/.venv`, or `python -m` kdj as an application runtime.
- Do not use `sidecar/` as evidence for the current architecture.
- Do not add new Python compatibility code. Port any still-useful behavior to Rust instead.

## Release

- A release push MUST update `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, and `src-tauri/tauri.conf.json` to the same intended version before committing.
- Verify the intended version is newer than the latest `v*` tag; never push release changes under the previous version number.

## Validation

- Validate only the narrowest scope affected by the current change. Do not repeatedly run full builds or duplicate broad test passes after every edit.
- Keep the workspace free of temporary test fixtures, logs, screenshots, temporary projects, generated samples, and cross-compilation artifacts. Clean up everything created for validation as soon as that validation ends.
- Expensive, full-workspace, and cross-platform checks may be deferred to the GitHub Actions triggered by a push when local confirmation is not needed to make the change safely.
- Frontend: use `npm run typecheck` for relevant TypeScript changes; run `npm run tauri:web:build` only when the affected build path needs local confirmation.
- Rust: use the narrowest relevant `cargo test`/`cargo check`; rely on CI for broader workspace and cross-platform coverage when appropriate.
- Avoid `computer_use` unless GUI automation is strictly necessary; otherwise leave interactive testing to the player.
- GUI automation on Apple Silicon: launch with `CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER="$PWD/scripts/tauri-dev-gui-runner.sh" npm run tauri:dev`; the Cargo runner keeps the executable in that current dev session but registers it as `/tmp/KDJ Dev.app` (`com.kdj.dev`), which `computer_use` can target. Before operating it, verify the PID/path and parent session with `ps`/`lsappinfo` and `computer_use.list_apps`; never target `com.kdj.app`, `/Applications/KDJ.app`, or another KDJ process, and stop rather than guess if the identities differ.
- When handing a running app to the user for testing, use the normal persistent data directory. Remove temporary `KDJ_DATA_DIR` / `KDJ_DOWNLOAD_DIR` overrides unless the user explicitly requested an empty profile. Isolated acceptance sessions must be identified as temporary and stopped before the user handoff; verify the expected library is loaded.
- Pure frontend changes under `src/` or frontend CSS SHOULD use Vite HMR when a Tauri dev session is already running; do not fully restart the app for each frontend-only edit.
- When Rust backend, `src-tauri/`, Tauri configuration, native capability, or startup behavior requires local runtime validation, fully stop and restart `npm run tauri:dev`. Comment-only changes and checks safely covered by the push-triggered GitHub Actions do not require a local restart.

## UI Copy

- Empty lists and panels MUST stay empty. Do not add “未检测到…”, “尚未创建”, “新建第一个…”, default-value hints, or instructional filler.
- Expose available actions as concise controls (for example `+`); reserve UI copy for actual state, errors, and user data, and put configuration in formal panels or settings.

## UI Visual Consistency

- Selected controls use theme-red text/icons without added selection backgrounds, borders, shadows, or decorative bars. Keep keyboard focus indicators distinct from selection.
- Use compact icon/text actions; do not introduce solid red action blocks or rectangular red slider thumbs.
- Do not impose a global zero-radius rule or inherit another project's visual style. Use restrained radii appropriate to each component.
- Local video and workshop previews must share `FloatingVideoControls`, `FloatingVideoScrub`, and the `kd-pip-float` styles. Controls overlay the picture; do not create separate white header/footer strips.
