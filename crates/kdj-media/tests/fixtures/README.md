# kdj-media test samples

Small media files `tests/roundtrip.rs` reads, so that the tests need no outside tool. Every
picture is FFmpeg's `testsrc2` pattern and every sound a generated tone; none comes from a
recording. Made once on 2026-10-30 with FFmpeg 7.1.1 (Homebrew, macOS):

| File | Size | What it is | Command |
|---|---|---|---|
| `video.m4s` | 11.7 kB | fragmented MP4, H.264 128×96, 30 fps, 2 s, GOP 30 with B-frames (a DASH video track) | `ffmpeg -f lavfi -i testsrc2=size=128x96:rate=30 -t 2 -c:v libx264 -crf 40 -g 30 -bf 2 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof -f mp4 video.m4s` |
| `audio.m4s` | 18.0 kB | fragmented MP4, AAC-LC 44.1 kHz, 440 Hz, 2 s, 1 s fragments (a DASH audio track) | `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100 -t 2 -c:a aac -b:a 64k -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000 -f mp4 audio.m4s` |
| `video.h264` | 12.8 kB | Annex B H.264 160×90, 30 fps, 2 s, two closed GOPs of 30, full range (what the visualizer's WebCodecs encoder uploads) | `ffmpeg -f lavfi -i testsrc2=size=160x90:rate=30 -t 2 -c:v libx264 -crf 40 -g 30 -bf 0 -x264-params keyint=30:min-keyint=30:scenecut=0 -pix_fmt yuv420p -color_range pc -bsf:v h264_mp4toannexb -f h264 video.h264` |
| `opus.webm` | 5.6 kB | WebM, Opus 48 kHz, 440 Hz, 1 s (YouTube Music's audio) | `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1 -c:a libopus -b:a 32k opus.webm` |
| `click.m4a` | 2.0 kB | M4A, AAC-LC 44.1 kHz stereo, 1.5 s of silence with a 10 ms 2 kHz burst at 1.000 s | `ffmpeg -f lavfi -i "aevalsrc=if(between(t\,1\,1.01)\,0.9*sin(2*PI*2000*t)\,0):s=44100:c=stereo" -t 1.5 -c:a aac -b:a 96k click.m4a` |
| `flv-aac.flv` | 9.6 kB | FLV, H.264 96×64, 30 fps, 1 s, GOP 15 with B-frames, and AAC-LC 44.1 kHz, 440 Hz (哔哩哔哩's single-stream `durl`) | `ffmpeg -f lavfi -i testsrc2=size=96x64:rate=30 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 1 -c:v libx264 -crf 40 -g 15 -bf 2 -pix_fmt yuv420p -c:a aac -b:a 32k -f flv flv-aac.flv` |
| `flv-mp3.flv` | 9.4 kB | the same picture without B-frames, with MP3 44.1 kHz (an older `durl`) | `ffmpeg -f lavfi -i testsrc2=size=96x64:rate=30 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 1 -c:v libx264 -crf 40 -g 15 -bf 0 -pix_fmt yuv420p -c:a libmp3lame -b:a 32k -f flv flv-mp3.flv` |

KDJ itself does not use FFmpeg. Replace a sample only with one made the same way, and keep it
this small.
