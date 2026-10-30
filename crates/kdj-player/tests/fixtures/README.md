# kdj-player test samples

Two tiny videos `src/decode.rs` reads, so that its tests need no outside tool. Made once on
2026-10-30 with FFmpeg 7.1.1 (Homebrew, macOS) from generated pictures and tones:

| File | Size | What it is | Command |
|---|---|---|---|
| `no-sound.mp4` | 3.6 kB | MP4, H.264 64×36, 25 fps, 3 s, no audio track | `ffmpeg -f lavfi -i color=black:size=64x36:rate=25 -t 3 -c:v libx264 -pix_fmt yuv420p no-sound.mp4` |
| `opus-sound.webm` | 9.6 kB | WebM, VP9 64×36 and Opus 48 kHz 440 Hz, 3 s (sound symphonia cannot decode) | `ffmpeg -f lavfi -i color=gray:size=64x36:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libvpx-vp9 -b:v 20k -c:a libopus -b:a 16k opus-sound.webm` |

KDJ itself does not use FFmpeg. Replace a sample only with one made the same way, and keep it
this small.
