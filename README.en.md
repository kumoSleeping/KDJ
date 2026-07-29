# KDJ

[English](README.en.md) | [中文](README.md)

A desktop workstation for DJs: search & download, local library, BPM / key analysis — one continuous flow.

![Library](docs/readme-assets/01-library.png)

## Features

- **Multi-platform download** — NetEase Cloud Music, QQ Music, SoundCloud, Bilibili (keywords, links, playlists)
- **Local library** — folder-based audio/video library with auto BPM, Camelot key, and loudness analysis
- **Harmonic mixing** — Camelot wheel + compatible-track suggestions
- **Video / VJ** — download Bilibili videos or audio-only tracks into the same library
- **DJ-style playback** — crossfade and related transitions while you build a set

![Track detail & Camelot wheel](docs/readme-assets/02-detail.png)

![Cross-platform search](docs/readme-assets/05-search.png)

![Download queue](docs/readme-assets/04-queue.png)

![Settings & accounts](docs/readme-assets/03-settings.png)

## Install

Grab a build from [Releases](https://github.com/kumoSleeping/KDJ/releases).

Current version: `0.2.9` (macOS / Windows / Linux).

## Develop

Requires Node 20+, Rust 1.85+, [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), and ffmpeg.

```bash
npm install
npm run dev      # desktop app
npm run build    # package
```

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 |
| Backend | Rust (analysis / library / downloads) |
| Frontend | React 19 |

## License

MIT
