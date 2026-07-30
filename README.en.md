<div align="center">
  <p>
    <img src="src-tauri/icons/128x128.png" width="88" height="88" alt="KDJ">
  </p>

  <h1>
    Kumo's<br>
    <em>Download &amp; Jockey</em>
  </h1>

  <p>
    <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="License">
    <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/github/v/release/kumoSleeping/KDJ?style=flat-square&label=release&color=orange" alt="Release"></a>
    <img src="https://img.shields.io/badge/Rust-dea584?style=flat-square&logo=rust&logoColor=black" alt="Rust">
    <img src="https://img.shields.io/badge/Tauri-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri">
    <img src="https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React">
  </p>

  <br>

  <img src="docs/readme-assets/01-library.png" alt="KDJ library" width="920">
</div>

---

[中文](README.md) · **English**

## Get the app

Choose your platform below to open the latest [Releases](https://github.com/kumoSleeping/KDJ/releases/latest). Available for macOS, Windows, Linux, and Android.

<p align="center">
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/macOS-black?style=for-the-badge&logo=apple&logoColor=white" alt="macOS"></a>
  &nbsp;
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows"></a>
  &nbsp;
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux"></a>
  &nbsp;
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/Android-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Android"></a>
</p>

Some sources support QR login so you can access content your account is already allowed to play or download.

> [!NOTE]
> Everyday library management and music analysis do not require FFmpeg. Video remuxing, extracting audio from video, and VJ export need [FFmpeg](https://ffmpeg.org/download.html) installed on the system.

KDJ packs cross-platform search, download, local library management, and music analysis into one desktop app. Instead of jumping between websites, downloaders, and tagging tools, preparing music can stay one continuous workflow.

## Features

- **Search across sources** — aggregate results from multiple providers and automatically merge duplicates.
- **Organize your library** — manage common audio and video files on your computer by folder, without changing how you already store music.
- **Understand every track** — automatic BPM, key, Camelot, loudness, and energy analysis to find a good next track faster.
- **Get audio and video** — keywords, share links, and playlists; download video, or keep audio only.
- **Preview and arrange in-app** — waveform preview, harmonic suggestions, auto-continue, and crossfade to move from picking tracks to building a set.

## Build for development

Requires Node.js 20+, Rust 1.85+, and the matching [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/kumoSleeping/KDJ.git
cd KDJ
npm install
npm run dev
```

Common commands:

```bash
npm run typecheck        # frontend typecheck
npm run tauri:web:build # build frontend
npm run build            # package the desktop app
```

KDJ uses React 19 for the UI, Rust for library, analysis, download, and playback, and Tauri 2 for the native desktop shell.

## Usage

KDJ provides media management and technical tools only. When using search, preview, and download features, follow local laws, platform terms, and copyright requirements.

## License

KDJ is released under the [MIT](https://opensource.org/license/mit) license.
