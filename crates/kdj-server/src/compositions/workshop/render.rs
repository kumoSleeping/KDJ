//! A project's sound, mixed here without FFmpeg: each source's sound is decoded once (symphonia,
//! 48 kHz stereo, kept in the cache), then every clip heard is cut from it, played at its speed at
//! its own pitch (kdj_media::stretch, WSOLA as FFmpeg's atempo), shaped by its volume and fades,
//! and summed under a limiter, in eight-second chunks cached by what is heard in them.
use super::*;
use std::{
    hash::{Hash, Hasher},
    io::{Read as _, Seek as _, SeekFrom},
    time::Duration,
};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
pub const SAMPLE_RATE: u64 = 48_000;
pub const CHUNK_MS: f64 = 8_000.;
pub(super) fn key(value: &impl Serialize) -> Result<String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(value)?.hash(&mut h);
    Ok(format!("{:016x}", h.finish()))
}
/// What a long job reports while it runs: how far it is (0..1 of its own part), or what it does.
pub(super) enum Step {
    Progress(f64),
    #[allow(dead_code)]
    Detail(String),
}
pub(super) fn check(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("处理已取消")
    }
    Ok(())
}

pub(super) fn wave_header(frames: u64) -> Vec<u8> {
    let size = (frames * 4) as u32;
    let mut b = Vec::with_capacity(44);
    b.extend(b"RIFF");
    b.extend((size + 36).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(48000u32.to_le_bytes());
    b.extend(192000u32.to_le_bytes());
    b.extend(4u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(size.to_le_bytes());
    b
}
pub fn frames(ms: f64) -> u64 {
    (ms * SAMPLE_RATE as f64 / 1000.).round() as u64
}
/// Sound mixed before a chunk so the retiming and the limiter have settled at its start (the
/// stretcher's first window, the limiter's release); cut off before the chunk is written.
const PRE_ROLL_MS: f64 = 500.;
/// Source sound read around a clip's span: the stretcher looks this far either side.
const SOURCE_MARGIN_MS: f64 = 100.;
/// The click-free ramp at a clip's genuine start and end (two milliseconds).
const DECLICK_FRAMES: usize = 96;
/// The limiter: what it looks ahead (one millisecond) and how fast it lets go (per frame).
const LIMIT_AHEAD: usize = 48;
const LIMIT_RELEASE: f32 = 1. / (0.05 * SAMPLE_RATE as f32);
pub(super) struct Scratch(pub(super) PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn continuous_audio(a: &Clip, b: &Clip) -> bool {
    a.id != b.id
        && a.display_duration_ms.is_none()
        && b.display_duration_ms.is_none()
        && a.source_id == b.source_id
        && (a.start_ms + a.duration() - b.start_ms).abs() < 1e-6
        && (a.source_out_ms - b.source_in_ms).abs() < 1e-6
        && a.speed == b.speed
        && a.sound.muted == b.sound.muted
        && a.sound.gain == b.sound.gain
}

/// Compile editorial splits into uninterrupted audio runs. Decoder, resampler and
/// atempo state must survive a pure split, not restart and pad each child to length.
/// This projection never changes the saved clips or their independent video edits.
fn audio_runs(clips: &[Clip]) -> Vec<Clip> {
    let mut ordered: Vec<_> = clips.iter().collect();
    ordered.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let mut runs: Vec<Clip> = Vec::new();
    for clip in ordered {
        if let Some(previous) = runs.last_mut() {
            let a = &previous.fades;
            let b = &clip.fades;
            let no_fades = a.audio_in_ms == 0. && a.audio_out_ms == 0.
                && b.audio_in_ms == 0. && b.audio_out_ms == 0.;
            let same_envelope = no_fades || (
                a.audio_in_ms == b.audio_in_ms && a.audio_out_ms == b.audio_out_ms
                && a.linear == b.linear && a.span_ms == b.span_ms
                && (a.offset_ms + previous.duration() - b.offset_ms).abs() < 1e-6
            );
            if continuous_audio(previous, clip) && same_envelope {
                previous.source_out_ms = clip.source_out_ms;
                continue;
            }
        }
        runs.push(clip.clone());
    }
    runs
}

/// What of `p` is heard: its sound runs without the muted clips, and without the picture's
/// geometry, transitions and fades, which do not change PCM. Sound mixed from equal `heard`
/// projects is the same, so a picture-only edit finds its sound in the cache.
pub(super) fn heard(p: &CompositionProject) -> CompositionProject {
    let mut audible = p.audio_project();
    for l in &mut audible.layers {
        l.clips = audio_runs(&l.clips);
        l.grid = None; // Grid corrections do not change PCM.
        l.clips.retain(|c| !c.sound.muted);
        for c in &mut l.clips {
            c.picture = Picture::default();
            c.video_transition = None;
            c.fades.video_in_ms = 0.;
            c.fades.video_out_ms = 0.;
        }
    }
    audible
}


/// A source's sound, decoded once: 48 kHz stereo s16le in the cache, and where it sits against
/// the source's picture (`shift`, ms: the sound's leading empty edit less the picture's).
struct Decoded {
    file: PathBuf,
    frames: u64,
    shift_ms: f64,
}

/// Interleaved stereo frames `from .. from + count` of a decoded source; silence outside it.
fn read_frames(decoded: &Decoded, from: i64, count: usize) -> Result<Vec<f32>> {
    let mut out = vec![0f32; count * 2];
    let lo = from.max(0) as u64;
    let hi = ((from + count as i64).max(0) as u64).min(decoded.frames);
    if hi <= lo {
        return Ok(out);
    }
    let mut file = std::fs::File::open(&decoded.file)?;
    file.seek(SeekFrom::Start(lo * 4))?;
    let mut bytes = vec![0u8; ((hi - lo) * 4) as usize];
    file.read_exact(&mut bytes)?;
    let at = ((lo as i64 - from) * 2) as usize;
    for (n, sample) in bytes.chunks_exact(2).enumerate() {
        out[at + n] = i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.;
    }
    Ok(out)
}

/// One clip's sound over the mix's frames `[start, start + count)` (relative to `origin` ms of the
/// project), added into `mix`: retimed when it is not at its own speed, at its volume and fades,
/// with a short ramp where the sound itself starts or ends (not at a pure split, `declick_*`).
#[allow(clippy::too_many_arguments)]
fn add_clip(mix: &mut [f32], origin: f64, c: &Clip, decoded: &Decoded, from_ms: f64, until_ms: f64, declick_in: bool, declick_out: bool) -> Result<()> {
    let a = (from_ms - c.start_ms).max(0.);
    let b = (until_ms - c.start_ms).min(c.duration());
    if b <= a {
        return Ok(());
    }
    let first = frames(c.start_ms + a - origin) as usize;
    let count = (frames(c.start_ms + b - origin) as usize).min(mix.len() / 2).saturating_sub(first);
    if count == 0 {
        return Ok(());
    }
    // Where an output frame `o` (from `first`) is in the decoded sound, in frames.
    let ms_per_frame = 1000. / SAMPLE_RATE as f64;
    let source_frame = |o: f64| (c.source_at(a + o * ms_per_frame) - decoded.shift_ms) * SAMPLE_RATE as f64 / 1000.;
    let s0 = source_frame(0.).min(source_frame(count as f64));
    let s1 = source_frame(0.).max(source_frame(count as f64));
    let margin = frames(SOURCE_MARGIN_MS) as f64;
    let read_from = (s0 - margin).floor() as i64;
    let input = read_frames(decoded, read_from, (s1 - s0 + 2. * margin).ceil() as usize + 1)?;
    let constant = c.parts().iter().all(|p| (p.rate - 1.).abs() < 1e-9);
    let sound = if constant {
        // At its own speed the sound is copied as it is, sample for sample.
        let offset = (source_frame(0.).round() as i64 - read_from).max(0) as usize;
        let mut out = vec![0f32; count * 2];
        let take = (input.len() / 2).saturating_sub(offset).min(count);
        out[..take * 2].copy_from_slice(&input[offset * 2..(offset + take) * 2]);
        out
    } else {
        kdj_media::stretch::stretch(&input, 2, count, &|o| source_frame(o) - read_from as f64)
    };
    let length = c.duration();
    for n in 0..count {
        let local = a + n as f64 * ms_per_frame;
        let mut gain = (c.sound.gain * c.fades.alpha(local, true)) as f32;
        let from_start = frames(local) as usize;
        let to_end = frames(length - local) as usize;
        if declick_in && from_start < DECLICK_FRAMES {
            gain *= from_start as f32 / DECLICK_FRAMES as f32;
        }
        if declick_out && to_end < DECLICK_FRAMES {
            gain *= to_end as f32 / DECLICK_FRAMES as f32;
        }
        let o = (first + n) * 2;
        mix[o] += sound[n * 2] * gain;
        mix[o + 1] += sound[n * 2 + 1] * gain;
    }
    Ok(())
}

/// Keeps the mix under full scale: the gain drops at once to what the loudest frame of the next
/// millisecond needs and comes back over about fifty.
fn limit(mix: &mut [f32]) {
    let frames = mix.len() / 2;
    let peak = |n: usize| mix[n * 2].abs().max(mix[n * 2 + 1].abs());
    let peaks: Vec<f32> = (0..frames).map(peak).collect();
    let mut gain = 1f32;
    for n in 0..frames {
        let ahead = peaks[n..(n + LIMIT_AHEAD).min(frames)].iter().fold(0f32, |m, &p| m.max(p));
        let target = if ahead > 1. { 1. / ahead } else { 1. };
        gain = if target < gain { target } else { (gain + LIMIT_RELEASE).min(target) };
        mix[n * 2] = (mix[n * 2] * gain).clamp(-1., 1.);
        mix[n * 2 + 1] = (mix[n * 2 + 1] * gain).clamp(-1., 1.);
    }
}

fn to_s16(samples: &[f32]) -> Vec<u8> {
    samples.iter().flat_map(|s| ((s.clamp(-1., 1.) * 32767.).round() as i16).to_le_bytes()).collect()
}

impl Workshop {
    pub(super) async fn cache_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.cache_locks.lock().unwrap();
        if locks.len() > 2048 {
            locks.retain(|_, v| Arc::strong_count(v) > 1);
        }
        locks
            .entry(key.into())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
    pub(super) fn trim_cache(&self) {
        // A filmstrip may finish dozens of frames at once; don't rescan the
        // entire cache for every JPEG or block multiple runtime workers on it.
        let Ok(mut last) = self.cache_trim_at.try_lock() else {
            return;
        };
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
            return;
        }
        *last = Some(std::time::Instant::now());
        let Ok(entries) = std::fs::read_dir(&self.cache) else {
            return;
        };
        let mut files = entries
            .filter_map(|e| {
                let e = e.ok()?;
                let m = e.metadata().ok()?;
                if !m.is_file()
                    || !matches!(
                        e.path().extension().and_then(|s| s.to_str()),
                        Some("pcm" | "wav" | "mp4" | "jpg" | "png" | "json" | "afp" | "s16")
                    )
                {
                    return None;
                }
                Some((e.path(), m.len(), m.modified().ok()))
            })
            .collect::<Vec<_>>();
        let mut size: u64 = files.iter().map(|(_, size, _)| size).sum();
        files.sort_by_key(|(_, _, time)| *time);
        for (path, bytes, _) in files {
            if size <= 2 * 1024 * 1024 * 1024 {
                break;
            }
            let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let busy = self
                .cache_locks
                .lock()
                .unwrap()
                .get(name)
                .is_some_and(|lock| Arc::strong_count(lock) > 1);
            if !busy && std::fs::remove_file(&path).is_ok() {
                size -= bytes;
            }
        }
    }
    /// A source's sound decoded to 48 kHz stereo once, kept in the cache under its signature.
    async fn decoded(&self, s: &Source, cancel: &CancellationToken) -> Result<Decoded> {
        let path = PathBuf::from(&s.path);
        if !s.signature.is_empty() && signature(&path)? != s.signature {
            bail!("素材已变化：{}，请重新添加", s.title)
        }
        let probe = media::probe(&path).await?;
        let shift_ms = if probe.picture.is_some() { probe.audio_shift_secs * 1000. } else { 0. };
        let name = format!("src-{}", key(&("sound-v1", &s.path, &s.signature))?);
        let file = self.cache.join(format!("{name}.s16"));
        let lock = self.cache_lock(&name).await;
        let _lock = lock.lock().await;
        if !file.is_file() {
            check(cancel)?;
            let temp = self.cache.join(format!("{name}.part"));
            let (source, out, cancel) = (path.clone(), temp.clone(), cancel.clone());
            tokio::task::spawn_blocking(move || -> Result<()> {
                let mut writer = std::io::BufWriter::new(std::fs::File::create(&out)?);
                let channels = kdj_media::pcm::inspect(&source)?.channels as usize;
                kdj_media::pcm::decode_played(&source, Some(SAMPLE_RATE as u32), None, &|| cancel.is_cancelled(), &mut |samples| {
                    use std::io::Write as _;
                    let stereo: Vec<f32> = if channels == 1 { samples.iter().flat_map(|&s| [s, s]).collect() } else { samples.to_vec() };
                    writer.write_all(&to_s16(&stereo))?;
                    Ok(())
                })
                .with_context(|| format!("无法解码素材的声音：{}", source.display()))?;
                use std::io::Write as _;
                writer.flush()?;
                Ok(())
            })
            .await??;
            tokio::fs::rename(&temp, &file).await?;
            self.trim_cache();
        }
        let frames = std::fs::metadata(&file)?.len() / 4;
        Ok(Decoded { file, frames, shift_ms })
    }

    pub async fn audio_chunk(
        &self,
        p: &CompositionProject,
        n: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let lo = n as f64 * CHUNK_MS;
        let hi = (lo + CHUNK_MS).min(p.duration());
        if hi <= lo {
            return Ok(vec![]);
        }
        let mut audio = p.audio_project();
        for layer in &mut audio.layers {
            layer.clips = audio_runs(&layer.clips);
        }
        let from = (lo - PRE_ROLL_MS).max(0.);
        let until = (hi + SOURCE_MARGIN_MS).min(p.duration());
        let mut audible = heard(p);
        audible.layers.iter_mut().for_each(|l| {
            l.clips.retain(|c| c.start_ms < until && c.start_ms + c.duration() > from);
        });
        // Geometry, names and revisions do not invalidate already prepared sound.
        let key = key(&("audio-v5-native", &audible.sources, &audible.layers, lo, hi))?;
        let path = self.cache.join(format!("{key}.pcm"));
        let lock = self.cache_lock(&key).await;
        let _lock = lock.lock().await;
        check(cancel)?;
        if path.is_file() {
            for source in &audible.sources {
                if audible
                    .layers
                    .iter()
                    .flat_map(|l| &l.clips)
                    .any(|c| c.source_id == source.id)
                    && !source.signature.is_empty()
                    && signature(Path::new(&source.path))? != source.signature
                {
                    bail!("素材已变化：{}，请重新添加", source.title)
                }
            }
            return Ok(tokio::fs::read(&path).await?);
        }
        let _permit = tokio::select! {_=cancel.cancelled()=>bail!("预览已取消"),p=self.preview_slots.acquire()=>p?};
        let mut wanted = vec![];
        for layer in &audio.layers {
            for c in &layer.clips {
                let s = audio.source(&c.source_id).context("素材不存在")?;
                if c.sound.muted || !s.audio || c.start_ms >= until || c.start_ms + c.duration() <= from {
                    continue;
                }
                // A ramp only where the sound itself starts or ends, not where a split continues it.
                let declick_in = !layer.clips.iter().any(|prev| continuous_audio(prev, c));
                let declick_out = !layer.clips.iter().any(|next| continuous_audio(c, next));
                wanted.push((c.clone(), s.clone(), declick_in, declick_out));
            }
        }
        let mut decoded = HashMap::new();
        for (_, s, _, _) in &wanted {
            if !decoded.contains_key(&s.id) {
                decoded.insert(s.id.clone(), self.decoded(s, cancel).await?);
            }
        }
        check(cancel)?;
        let cancel = cancel.clone();
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let mut mix = vec![0f32; (frames(until) - frames(from)) as usize * 2];
            for (c, s, declick_in, declick_out) in &wanted {
                check(&cancel)?;
                add_clip(&mut mix, from, c, &decoded[&s.id], from, until, *declick_in, *declick_out)?;
            }
            limit(&mut mix);
            let begin = (frames(lo) - frames(from)) as usize * 2;
            let end = begin + (frames(hi) - frames(lo)) as usize * 2;
            Ok(to_s16(&mix[begin..end]))
        })
        .await??;
        let temp = self.cache.join(format!("{key}.part"));
        tokio::fs::write(&temp, &bytes).await?;
        tokio::fs::rename(&temp, &path).await?;
        self.trim_cache();
        Ok(bytes)
    }
    /// The sound of `p` between `lo` and `hi` (ms), mixed into `stage/mix.wav` from the
    /// cached chunks of `audio_chunk`, several at once (`preview_slots`), written in order.
    /// Progress goes from 0 to 1.
    pub(super) async fn mix_file(
        &self,
        p: &CompositionProject,
        stage: &Path,
        lo: f64,
        hi: f64,
        cancel: &CancellationToken,
        report: &(dyn Fn(Step) -> Result<()> + Sync),
    ) -> Result<PathBuf> {
        let audio = stage.join("mix.wav");
        let mut file = tokio::fs::File::create(&audio).await?;
        file.write_all(&wave_header(frames(hi) - frames(lo)))
            .await?;
        let first = (lo / CHUNK_MS).floor() as u64;
        let last = (hi / CHUNK_MS).ceil() as u64;
        let mut chunks = futures_util::stream::iter(first..last)
            .map(|n| async move { (n, self.audio_chunk(p, n, cancel).await) })
            .buffered(4);
        while let Some((n, bytes)) = chunks.next().await {
            check(cancel)?;
            let bytes = bytes?;
            let begin = (frames(lo.max(n as f64 * CHUNK_MS)) - frames(n as f64 * CHUNK_MS)) * 4;
            let end = (frames(hi.min((n + 1) as f64 * CHUNK_MS)) - frames(n as f64 * CHUNK_MS)) * 4;
            file.write_all(&bytes[begin as usize..end as usize]).await?;
            report(Step::Progress((n - first + 1) as f64 / (last - first) as f64))?;
        }
        file.flush().await?;
        drop(file);
        Ok(audio)
    }
}
#[test]
fn audio_runs_preserve_real_edits() {
    let left = Clip {
        id: "left".into(), source_id: "source".into(), start_ms: 0.,
        source_in_ms: 0., source_out_ms: 1000., speed: Speed::normal(2000.),
        picture: Picture::default(),
        sound: Sound { muted: false, gain: 1., manual: false },
        fades: Fades { audio_in_ms: 200., audio_out_ms: 200., ..Fades::new(2000., false) },
        video_transition: None, display_duration_ms: None, animation_offset_ms: 0.,
    };
    let mut right = left.clone();
    right.id = "right".into();
    right.start_ms = 1000.;
    right.source_in_ms = 1000.;
    right.source_out_ms = 2000.;
    right.fades.offset_ms = 1000.;
    let inputs = [left.clone(), right.clone()];
    let runs = audio_runs(&inputs);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].source_out_ms, 2000.);
    assert_eq!(inputs, [left.clone(), right.clone()], "projection must not edit the project");
    let edits: &[fn(&mut Clip)] = &[
        |c| c.source_id = "other".into(),
        |c| c.source_in_ms += 10.,
        |c| c.start_ms += 10.,
        |c| c.start_ms -= 10.,
        |c| c.sound.gain = 0.5,
        |c| c.sound.muted = true,
        |c| c.speed.start = 1.2,
        |c| c.fades.audio_in_ms += 10.,
        |c| c.fades.audio_out_ms += 10.,
        |c| c.fades.offset_ms = 0.,
        |c| c.fades.span_ms += 10.,
        |c| c.fades.linear = true,
        |c| c.display_duration_ms = Some(1000.),
    ];
    for (i, edit) in edits.iter().enumerate() {
        let mut changed = right.clone();
        edit(&mut changed);
        assert_eq!(audio_runs(&[left.clone(), changed]).len(), 2, "real edit {i} must stay separate");
    }
    let mut left = left;
    left.fades = Fades::new(1000., false);
    right.fades = Fades::new(1000., false);
    assert_eq!(audio_runs(&[left, right]).len(), 1, "inactive envelopes have no phase to reset");
}

/// Generate a bounded audio interval with pre-roll for stretch and limiter state.

#[cfg(test)]
mod mix_tests {
    use super::*;

    fn clip(start_ms: f64, source_in_ms: f64, source_out_ms: f64) -> Clip {
        Clip {
            id: "c".into(), source_id: "s".into(), start_ms, source_in_ms, source_out_ms,
            speed: Speed::normal(source_out_ms),
            picture: Picture::default(),
            sound: Sound { muted: false, gain: 1., manual: false },
            fades: Fades::new(source_out_ms - source_in_ms, false),
            video_transition: None, display_duration_ms: None, animation_offset_ms: 0.,
        }
    }

    /// A decoded source of `seconds` holding a ramp: frame `n` is `n` (mod 32768) on the left.
    fn source(seconds: f64) -> (tempfile::TempDir, Decoded) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("s.s16");
        let count = frames(seconds * 1000.);
        let bytes: Vec<u8> = (0..count).flat_map(|n| {
            let v = (n % 32768) as i16;
            [v.to_le_bytes(), (-v).to_le_bytes()].concat()
        }).collect();
        std::fs::write(&file, bytes).unwrap();
        (dir, Decoded { file, frames: count, shift_ms: 0. })
    }

    #[test]
    fn a_clip_at_its_own_speed_is_its_source_sample_for_sample() {
        let (_dir, decoded) = source(2.);
        let c = clip(100., 500., 1500.);
        let mut mix = vec![0f32; frames(2000.) as usize * 2];
        add_clip(&mut mix, 0., &c, &decoded, 0., 2000., false, false).unwrap();
        let at = frames(100.) as usize;
        for n in [0usize, 1, 4800, 47_999] {
            let expected = ((frames(500.) as usize + n) % 32768) as f32 / 32768.;
            assert!((mix[(at + n) * 2] - expected).abs() < 1e-6, "frame {n}");
            assert!((mix[(at + n) * 2 + 1] + expected).abs() < 1e-6, "frame {n}, right");
        }
        assert_eq!(mix[(at - 1) * 2], 0., "nothing before the clip");
        assert_eq!(mix[(at + frames(1000.) as usize) * 2], 0., "nothing after it");
    }

    #[test]
    fn a_sound_that_starts_and_ends_is_ramped_two_milliseconds() {
        let (_dir, decoded) = source(1.);
        let c = clip(0., 0., 1000.);
        let mut mix = vec![0f32; frames(1000.) as usize * 2];
        add_clip(&mut mix, 0., &c, &decoded, 0., 1000., true, true).unwrap();
        assert_eq!(mix[0], 0.);
        let ramped = 48. / 32768. * 0.5;
        assert!((mix[48 * 2] - ramped).abs() < 1e-6, "{}", mix[48 * 2]);
    }

    #[test]
    fn the_limiter_keeps_the_sum_under_full_scale() {
        let mut mix: Vec<f32> = (0..9600).flat_map(|n| { let s = if n % 2 == 0 { 1.6 } else { -1.6 }; [s, s] }).collect();
        limit(&mut mix);
        assert!(mix.iter().all(|s| s.abs() <= 1.));
        let mut quiet = vec![0.25f32; 9600];
        limit(&mut quiet);
        assert!(quiet.iter().all(|&s| s == 0.25), "a mix under full scale is left alone");
    }
}
