# Android

Android uses the same Rust server, library, analysis and `PlaybackCoordinator` as the desktop
app, through Tauri. The installable release is arm64, Android 8 / API 26 or newer. YouTube's
separate WebView profile needs Android 9 / API 28 or newer; update Android System WebView too.

## Product boundary

Kept: music search/download, local library, BPM/key/loudness analysis, waveforms, lyrics,
song colours/themes, tempo/EQ, Android MediaSession, audio focus and overlay lyrics.
File access still requires media permission and a readable local filesystem directory. SAF
cloud/virtual documents are not a Rust filesystem; selecting one is not support for streaming
that document. Android deletion is not the desktop recycle bin. Account login opens the desktop's ways in
place under the account's row, except reading another browser's profile: the QR code (shown
and saved to the album, since a phone cannot scan its own screen), a Cookie-Editor export
pasted from a mobile browser, and pasted request headers. SoundCloud keeps its OAuth fallback.

Omitted: visualization production/preview/export, editing, `.kdjv` playback
and the desktop CLI API. Existing project files, export databases and settings
are not removed or rewritten to implement this boundary. Shared palette extraction remains.

`platformFeatures.ts` gates actions and export-store initialization. The mobile Vite graph
omits production panels and the export worker. The Rust mobile router does not register
CLI, workshop, visualizer or video-calibration routes. A stale UI or direct request cannot start those
jobs. Desktop routes and panels are unchanged.

Local video uses the system WebView for pictures and Rust for audio: supported formats are
still their intersection, not a bundled universal decoder. There is no compatibility transcode.
Bilibili can download complete single streams; separated-track mux, extraction and Offset are
not offered. YouTube's HLS remux/download remains pure Rust. KDJ has no FFmpeg on any platform.

## Native audio and background work

Kotlin mirrors the Rust snapshot; it is not a second audio player. Positive local IDs and
negative online IDs retain their identity in MediaSession and overlay lyrics, which now read
the same coordinator clock. Focus is requested after the media service enters foreground.
The service keeps a bounded playback wake-lock lease, releasing on pause/disposal/failure;
EOF retains a short foreground lease for the next-source resolver. Media3 retains ownership
of media-button intents. The Activity keeps its WebView resumed while the foreground media
lease is active, so the existing shared resolver and system next/previous handlers can run.

**Scheduling ownership is not changed into a second native playlist:** selection, automatic
next-song policy and online SABR supply still involve the shared frontend. Current-track
Rust decoding is independent of JavaScript; indefinite background source resolution is not.
OEM suspension, force-stop, network changes and background restart restrictions need device
acceptance. No wake lock bypasses force-stop or promises uninterrupted network service.

## YouTube isolation

`youtube_proof.rs` keeps the existing bundle, player URL, operation and output validation.
Android adapts only its realm/evaluation transport in `youtube_proof_android.rs`:

- `YoutubeProofService`, an unexported bound service in `:youtube_proof`, has a distinct WebView
  data directory. It does not load Tauri, has no JavaScript/native interface, and never shares
  the main UI's cookies or storage. Cookies, DOM storage, file/content access and popup windows
  are disabled. Profile cache is cleared on reset and leftover profile files on process start.
- The document is the real `https://www.youtube.com/robots.txt` origin. Navigation is fixed;
  requests are limited to the anonymous homepage, validated Google interpreter scripts and
  GenerateIT. The shared proof bundle installs its restrictive document CSP as before.
- Validated local JS is passed over Binder using a read-only file descriptor, not an oversized
  Binder string. Temporary script files are unlinked after opening. Results are bounded JSON
  from `evaluateJavascript`, not a remote-callable bridge. Request timeouts, renderer exit,
  binding failure and realm reset reject work instead of silently switching implementations.
- The main renderer's CSP/capabilities are not relaxed. The internal plugin transport is not
  granted to frontend IPC. Proof/player and SABR JS are no longer aliased to unsupported on
  Android; iOS retains the existing unsupported path.

These are implementation guarantees, not a claim that YouTube accepts every device/network.
Proof failures retain their existing error path. Background SABR is subject to the ownership
and suspension limits above.

## System video PiP

The shared floating video host still owns loading, seeking, swapping and clocks. Android PiP
presents that Activity surface, without copying it to another player. `MainActivity` configures
the aspect ratio and automatic entry (API 31+) or enters on leaving the Activity (API 26–30).
Its PiP callback presents only the video surface and keeps WebView decoding resumed. This is
separate from both in-app floating windows and overlay lyrics. Device support is checked before
the control is offered. `android-postinit.sh` restores the manifest capability after Tauri init.

## Updates

The update check is the shared GitHub Release check; on Android its URL is the signed APK of the
device's ABI. 下载并安装 downloads that APK inside the app (`UpdateInstaller.kt`, only from this
repository's Release, only a package with KDJ's application ID) into the app's cache and opens
the system installer: installation, signature checking and the upgrade remain the system's. The
first time, Android asks to allow KDJ to install apps (`REQUEST_INSTALL_PACKAGES`). When the
background check finds a newer version on Wi‑Fi/Ethernet, the APK is downloaded and the installer
page opened by itself, once per version; on a metered or unknown network nothing is downloaded
until the key is pressed. There is no silent install.

## Packaging and acceptance

A `v*` release run of `rust-build` calls `rust-android.yml`; the latter also remains manually
dispatchable for a branch test APK. Tag builds require the existing signing secrets and verify
both keystore identity and packaged APK signature. MainActivity is restored from tracked source
after `tauri android init`. Desktop Latest promotion waits for Android success and a nonempty
`app-arm64-release.apk`; Android does not get a fake entry in the desktop Tauri updater manifest.
README's existing generated size/link block and its synchronization workflow are retained.
Do not change signing identity or application ID: existing installs must be upgradeable.
Branch-test APKs use an ephemeral test key and cannot update a production install. Use a spare
device or emulator for them; do not uninstall a real library just to work around that mismatch.

Local narrow checks:

```sh
node --import tsx --test tests/androidLite.test.ts tests/youtubeSabrUpload.test.ts
node --conditions=import scripts/test-dom-ui.mjs androidUpdate
TAURI_ENV_PLATFORM=androideabi npm run tauri:web:build
```

The frontend build is not an APK build. Rust cross-compilation, Kotlin/R8, manifest merging,
16 KiB page alignment, installer contents and signatures belong to the Android CI build.
Before calling an APK device-accepted, check at least:

- upgrade an existing signed install without losing library/settings/download history;
- denied/regranted media and notification permissions; readable folder and failed SAF cloud path;
- local and online songs, negative-ID lockscreen metadata and word-timed floating lyrics;
- locked-screen continuous switching, notification/headset next/previous, Bluetooth unplug,
  transient/permanent audio focus loss, interruption recovery, paused service cleanup;
- YouTube Music proof, signature/n transform, audio/SABR, video seek and HLS download; proof
  timeout/renderer restart; network loss and a long locked-screen session;
- PiP entry/exit/rotation/close on API 26–30 and 31+, local video audio synchronization, preview
  playback, returning to the app without a second audio stream;
- Android 15+ focus/foreground restrictions and 16 KiB-page-size hardware/emulator.

This branch has not by itself established current-commit APK or physical-device acceptance.
Record the CI run, commit and devices when those checks are performed; historical APK success
is not evidence for this revision.
