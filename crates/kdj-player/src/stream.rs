use std::cell::UnsafeCell;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rtrb::{Consumer, Producer, PushError, RingBuffer};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

/// Default read-ahead owned by one streaming Deck. The queue stores stereo output frames, so its
/// memory is fixed regardless of track length (four seconds at 48 kHz is about 1.5 MiB).
pub const DEFAULT_STREAM_BUFFER_SECONDS: usize = 4;

#[derive(Debug)]
struct StreamCounters {
    produced: AtomicU64,
    consumed: AtomicU64,
    ended: AtomicBool,
}

/// Callback-side half of a bounded streaming source.
///
/// Only the platform audio callback may touch `consumer`. Decode workers own the matching
/// producer. The surrounding `Arc` is retained by `DynamicPlayer` until callback retirement.
pub struct StreamSource {
    consumer: UnsafeCell<Consumer<[f32; 2]>>,
    counters: Arc<StreamCounters>,
}

// SAFETY: `consumer` has exactly one accessor and that accessor is crate-private to the audio
// renderer. Control/decode threads only read atomic counters or own the SPSC producer.
unsafe impl Send for StreamSource {}
unsafe impl Sync for StreamSource {}

impl std::fmt::Debug for StreamSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StreamSource")
            .field("produced_frames", &self.produced_frames())
            .field("consumed_frames", &self.consumed_frames())
            .field("ended", &self.ended())
            .finish()
    }
}

impl StreamSource {
    /// Creates a bounded source and its single decode-writer half.
    pub fn bounded(capacity_frames: usize) -> (Arc<Self>, StreamWriter) {
        assert!(
            capacity_frames > 1,
            "stream capacity must contain multiple frames"
        );
        let (producer, consumer) = RingBuffer::new(capacity_frames);
        let counters = Arc::new(StreamCounters {
            produced: AtomicU64::new(0),
            consumed: AtomicU64::new(0),
            ended: AtomicBool::new(false),
        });
        (
            Arc::new(Self {
                consumer: UnsafeCell::new(consumer),
                counters: Arc::clone(&counters),
            }),
            StreamWriter { producer, counters },
        )
    }

    pub fn produced_frames(&self) -> u64 {
        self.counters.produced.load(Ordering::Acquire)
    }

    pub fn consumed_frames(&self) -> u64 {
        self.counters.consumed.load(Ordering::Acquire)
    }

    pub fn buffered_frames(&self) -> u64 {
        self.produced_frames()
            .saturating_sub(self.consumed_frames())
    }

    pub fn ended(&self) -> bool {
        self.counters.ended.load(Ordering::Acquire)
    }

    pub fn drained(&self) -> bool {
        self.ended() && self.buffered_frames() == 0
    }

    pub(crate) fn pop_callback(&self) -> Option<[f32; 2]> {
        // SAFETY: documented by the type-level invariant above. The renderer is the sole consumer.
        let consumer = unsafe { &mut *self.consumer.get() };
        let frame = consumer.pop().ok()?;
        self.counters.consumed.fetch_add(1, Ordering::Release);
        Some(frame)
    }
}

/// seek 目标与流末尾保持的最小距离：精确 seek 到“正好结尾”（或元数据时长
/// 比真实可解码长度略长）会读出流外，symphonia 以 end of stream 失败告终。
const SEEK_END_MARGIN_SECONDS: f64 = 0.25;
/// seek 失败后的回退步长：逐级提前重试，直到落进流内。
const SEEK_RETRY_STEP_SECONDS: f64 = 1.0;

/// Decode-thread half. It blocks only on its worker thread when read-ahead is full.
pub struct StreamWriter {
    producer: Producer<[f32; 2]>,
    counters: Arc<StreamCounters>,
}

impl StreamWriter {
    pub fn push<F>(&mut self, mut frame: [f32; 2], cancelled: F) -> Result<()>
    where
        F: Fn() -> bool,
    {
        loop {
            if cancelled() || self.producer.is_abandoned() {
                bail!("stream preparation cancelled");
            }
            match self.producer.push(frame) {
                Ok(()) => {
                    self.counters.produced.fetch_add(1, Ordering::Release);
                    return Ok(());
                }
                Err(PushError::Full(returned)) => {
                    frame = returned;
                    thread::sleep(Duration::from_millis(2));
                }
            }
        }
    }

    pub fn finish(self) {
        self.counters.ended.store(true, Ordering::Release);
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StreamMetadata {
    pub duration: Option<f64>,
    pub source_sample_rate: u32,
    pub output_sample_rate: u32,
}

/// Seekable encoded-media input owned by a decode worker.
///
/// Files and HTTP Range adapters both implement this boundary. It deliberately exposes only the
/// capabilities Symphonia needs; network clients and retries remain outside the realtime player.
pub trait StreamingMediaSource: Read + Seek + Send + Sync {
    fn is_seekable(&self) -> bool;
    fn byte_len(&self) -> Option<u64>;
}

impl StreamingMediaSource for File {
    fn is_seekable(&self) -> bool {
        self.metadata().is_ok_and(|metadata| metadata.is_file())
    }

    fn byte_len(&self) -> Option<u64> {
        self.metadata().ok().map(|metadata| metadata.len())
    }
}

struct SymphoniaMediaSource(Box<dyn StreamingMediaSource>);

impl Read for SymphoniaMediaSource {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Seek for SymphoniaMediaSource {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.0.seek(position)
    }
}

impl symphonia::core::io::MediaSource for SymphoniaMediaSource {
    fn is_seekable(&self) -> bool {
        self.0.is_seekable()
    }

    fn byte_len(&self) -> Option<u64> {
        self.0.byte_len()
    }
}

/// Decodes from an arbitrary seekable media source into a bounded stereo ring and resamples off
/// the realtime thread. Callers own network/file IO, cancellation and the worker lifecycle.
pub fn decode_source_streaming<F>(
    source: Box<dyn StreamingMediaSource>,
    hint_extension: Option<&str>,
    source_label: &str,
    position: f64,
    output_sample_rate: u32,
    mut writer: StreamWriter,
    cancelled: F,
) -> Result<StreamMetadata>
where
    F: Fn() -> bool + Copy,
{
    if output_sample_rate == 0 {
        bail!("output sample rate must be non-zero");
    }
    let source = MediaSourceStream::new(Box::new(SymphoniaMediaSource(source)), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = hint_extension.filter(|extension| !extension.is_empty()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .with_context(|| format!("unsupported audio format: {source_label}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|candidate| candidate.codec_params.codec != CODEC_TYPE_NULL)
        .context("audio stream not found")?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let duration = params
        .n_frames
        .zip(params.sample_rate.filter(|rate| *rate > 0))
        .map(|(frames, rate)| frames as f64 / f64::from(rate));
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .context("audio decoder unavailable")?;

    // 点到进度条最右端时目标常等于甚至略超真实时长；先按本次探测到的时长
    // 收敛，再对仍失败的边界（VBR 时长虚高等）逐级提前 1s 重试，让“跳到末尾”
    // 退化为从接近末尾处起播，而不是整次跳转以 end of stream 报错。
    let mut position = position;
    if let Some(limit) =
        duration.filter(|value| value.is_finite() && *value > SEEK_END_MARGIN_SECONDS)
    {
        position = position.min(limit - SEEK_END_MARGIN_SECONDS);
    }
    if position > 0.0 {
        let mut attempt = position;
        loop {
            match format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(attempt),
                    track_id: Some(track_id),
                },
            ) {
                Ok(_) => break,
                Err(error) => {
                    let next = (attempt - SEEK_RETRY_STEP_SECONDS).max(0.0);
                    if next >= attempt {
                        return Err(error).with_context(|| format!("seek audio to {position:.3}s"));
                    }
                    attempt = next;
                }
            }
        }
        decoder.reset();
    }

    let mut source_sample_rate = params.sample_rate.filter(|rate| *rate > 0).unwrap_or(0);
    let mut conversion: Option<(SampleBuffer<f32>, u64, usize, u32)> = None;
    let mut previous: Option<[f32; 2]> = None;
    let mut source_index = 0u64;
    let mut next_output_position = 0.0f64;

    loop {
        if cancelled() {
            bail!("stream preparation cancelled");
        }
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(Error::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => return Err(error).context("read audio packet"),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(Error::DecodeError(_)) => continue,
            Err(Error::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => return Err(error).context("decode audio packet"),
        };
        let spec = *decoded.spec();
        if spec.rate == 0 {
            continue;
        }
        if source_sample_rate != 0 && source_sample_rate != spec.rate {
            bail!("sample rate changed within one track");
        }
        source_sample_rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let required_capacity = decoded.capacity() as u64;
        let recreate = conversion
            .as_ref()
            .is_none_or(|(_, capacity, old_channels, old_rate)| {
                *capacity < required_capacity || *old_channels != channels || *old_rate != spec.rate
            });
        if recreate {
            conversion = Some((
                SampleBuffer::new(required_capacity, spec),
                required_capacity,
                channels,
                spec.rate,
            ));
        }
        let buffer = &mut conversion.as_mut().expect("stream conversion buffer").0;
        buffer.copy_interleaved_ref(decoded);
        let step = f64::from(source_sample_rate) / f64::from(output_sample_rate);
        for input in buffer.samples().chunks_exact(channels) {
            let current = if channels == 1 {
                [finite(input[0]), finite(input[0])]
            } else {
                [finite(input[0]), finite(input[1])]
            };
            if let Some(before) = previous {
                while next_output_position <= source_index as f64 {
                    let fraction =
                        (next_output_position - (source_index - 1) as f64).clamp(0.0, 1.0) as f32;
                    writer.push(
                        [
                            before[0] + (current[0] - before[0]) * fraction,
                            before[1] + (current[1] - before[1]) * fraction,
                        ],
                        cancelled,
                    )?;
                    next_output_position += step;
                }
            }
            previous = Some(current);
            source_index = source_index.saturating_add(1);
        }
    }

    if source_sample_rate == 0 || writer.counters.produced.load(Ordering::Acquire) == 0 {
        bail!("decoded audio stream is empty");
    }
    writer.finish();
    Ok(StreamMetadata {
        duration,
        source_sample_rate,
        output_sample_rate,
    })
}

/// File adapter retained for local-library callers and compatibility tests.
pub fn decode_file_streaming<F>(
    path: &Path,
    position: f64,
    output_sample_rate: u32,
    writer: StreamWriter,
    cancelled: F,
) -> Result<StreamMetadata>
where
    F: Fn() -> bool + Copy,
{
    let file = File::open(path).with_context(|| format!("open audio: {}", path.display()))?;
    let extension = path.extension().and_then(|value| value.to_str());
    decode_source_streaming(
        Box::new(file),
        extension,
        &path.display().to_string(),
        position,
        output_sample_rate,
        writer,
        cancelled,
    )
}

fn finite(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}
