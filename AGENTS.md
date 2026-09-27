# KDJ Repository Rules

## Project Intent

- KDJ is a non-commercial project. Non-commercial license terms MUST NOT be treated as a current integration blocker; still record and comply with attribution, share-alike, redistribution, and model-specific terms, and reassess before any future commercial distribution.

## Active Architecture

- **The only active desktop architecture is Rust + Tauri.**
- Use `npm run dev` or `npm run tauri:dev` for development.
- Use `npm run build` or `npm run tauri:build` for production builds.
- Backend work belongs in `crates/` and `src-tauri/`.
- Frontend work belongs in `src/` and must be validated against the Tauri shell.
- Video scheduling is shared through `src/lib/videoPlaybackEngine.ts`, `videoFrames.ts`, and `videoSeekQueue.ts`. Local playback, online previews, YouTube, and the mixing editor (formerly VJ workshop) must use this common scheduling layer; official embedded players adapt their commands to the shared seek queue.
- Prioritize macOS and Windows while retaining Android support. Reuse system decoding; do not introduce a bundled decoder/player dependency merely to unify video controls. Keep native decoding, shared scheduling, and source-specific loading distinct when reporting capabilities.

## Disabled Legacy Runtime

- **The Python sidecar is retired as a runtime.** It is retained only as read-only historical/reference material.
- Do not run `PyInstaller`, `sidecar/.venv`, or `python -m` kdj as an application runtime.
- Do not use `sidecar/` as evidence for the current architecture.
- Do not add new Python compatibility code. Port any still-useful behavior to Rust instead.

## Persisted User Data

- `vj-projects.json`（以及其它版本间共用的 `settings.json`、队列文件、数据库）是用户的长期资产，必须按“任何一次写入都不得比读到的内容少”处理。
- Never rewrite a persisted document on open unless normalization or migration actually changed it; an unconditional save-on-open lets an older build restructure the whole file. This already destroyed every `crop_auto_fit` flag once (installed `/Applications/KDJ.app` 1.0.2-rc3 shares the same data directory as the dev build).
- When a build cannot round-trip a loaded document without dropping keys, it MUST open it read-only, report the dropped paths, and leave the file untouched — never silently strip fields.
- Keep automatic snapshots (`workshop-backups/auto/` at a ten-minute gap, `workshop-backups/daily/`) before writes; recover from them rather than from memory.
- Do not run two builds against one data directory at the same time; upgrading the installed app is the fix, not a compatibility shim.

## Release

- A release push MUST update `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, and `src-tauri/tauri.conf.json` to the same intended version before committing.
- Verify the intended version is newer than the latest `v*` tag; never push release changes under the previous version number.
- When the user says “开始发布模式一”, treat it as authorization to start the RC release and its periodic monitoring without asking for another confirmation.
- Inspect the local changes and remote `v*` tags first. Preserve and include the user's local changes in the release; commit code and test changes before invoking the release script, since it requires a clean worktree. Determine the next RC number automatically without asking: increment the highest remote RC suffix on the active `X.Y.Z` line (for example, `rc6` → `rc7`). If the newest remote tag is a higher RC, increment that RC; if it is a stable release, use the next patch prerelease (for example, `1.0.2` → `1.0.3-rc1`). Keep advancing until the chosen SemVer is newer than every remote tag. Never move or replace an existing tag.
- Use `scripts/release.sh <version>` as the release path. Run narrow local checks for the changed scope first. Only set `SKIP_VALIDATION=1` when those checks have already passed and the release CI will run the broader gates; otherwise use the script's normal validation. Let the script watch the release workflows and verify the published update manifest.
- Start or reuse one active heartbeat automation for the current task at a 10-minute interval. It must monitor the release and README size-sync workflows, inspect failure logs, fix genuine code or test regressions, run the narrow relevant checks, then publish a strictly newer RC if the existing tag cannot be reused. Retry the same job only for transient infrastructure or network failures. Do not queue duplicate builds while jobs are running.
- Keep monitoring until desktop macOS arm64/x86_64, Windows, Linux, and Android jobs succeed; expected installers and signatures are attached; `latest.json` has the intended version, complete signed platform entries, and working asset URLs; GitHub Latest points to the release; and the README size-sync workflow succeeds or is confirmed inapplicable. Then pause the heartbeat automation and report the release. If an external credential or user action blocks completion, report the exact blocker and leave monitoring active.

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
