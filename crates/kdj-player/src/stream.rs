use std::cell::UnsafeCell;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use kdj_stems::{
    begin_live_stem_audio_lease, read_cache_header, seek_cache_frame, stem_tile_cache_key,
    stem_tile_geometry, try_acquire_instant_admission, InstantAdmissionGuard, InstantStemChunk,
    InstantStemPool, InstantTrack, StemChunk, StemInferencePool, StemKind, StemWindowCursor,
    BYTES_PER_FRAME, INSTANT_HANDOFF_FRAMES, INSTANT_HOP_BUDGET_MS, INSTANT_HOP_FRAMES,
    SAMPLE_RATE as STEM_SAMPLE_RATE,
};
#[cfg(test)]
use kdj_stems::{
    SEGMENT_CONTEXT_SAMPLES, SEGMENT_CORE_SAMPLES, SEGMENT_HANDOFF_SAMPLES, SEGMENT_SAMPLES,
};
use rtrb::{Consumer, Producer, PushError, RingBuffer};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

use crate::time_stretch::{PitchPreservingStretcher, TempoControl, TimeStretchFrame};

/// Default read-ahead owned by one streaming Deck. The queue stores stereo output frames, so its
/// memory is fixed regardless of track length (four seconds at 48 kHz is about 1.5 MiB).
pub const DEFAULT_STREAM_BUFFER_SECONDS: usize = 4;
/// How many successor tiles stay in flight besides the tile currently being pushed into the ring.
const LIVE_STEM_LOOKAHEAD_TILES: usize = 2;
/// A seek invalidates both the raw and post-tempo generations. Refill the destination with dry
/// source PCM before making HS-TasNet part of the producer clock; one 11.6 ms hop is not enough to
/// absorb its measured tail latency or a scheduler pre-emption.
const LIVE_STEM_SEEK_PREFILL_MS: u64 = 250;

/// One in-memory future classical Redress tile handed to playback when it becomes audible.
struct LiveStemLookAhead {
    start: f64,
    result: Arc<Mutex<Option<Result<Arc<StemChunk>>>>>,
}

struct LayeredInstant {
    pool: Arc<InstantStemPool>,
    track: Arc<InstantTrack>,
}

impl LiveStemLookAhead {
    fn is_for(&self, start: f64) -> bool {
        (self.start - start).abs() < 1.0 / f64::from(STEM_SAMPLE_RATE)
    }

    fn try_take(&self) -> Option<Result<Arc<StemChunk>>> {
        self.result.lock().unwrap().take()
    }
}

#[derive(Debug)]
struct StreamCounters {
    produced: AtomicU64,
    consumed: AtomicU64,
    ended: AtomicBool,
    generation: AtomicU64,
}

#[derive(Clone, Copy)]
struct StreamPacket<F: Copy> {
    frame: F,
    generation: u64,
    media_advance: f32,
    tempo_revision: u64,
    media_time: f64,
}

/// Number of stems one STEM ring frame carries, in `StemKind::index` order.
pub const STEM_LANES: usize = 4;
/// Linear STEM lane gain. `1.0` is the original mix; `2.0` is about +6 dB of STEM EQ boost.
pub const STEM_GAIN_MAX: f32 = 2.0;

/// One source-time loop window shared with the PCM worker.
///
/// The control thread only publishes immutable in/out coordinates and a generation. It never
/// polls the playhead and never asks the media decoder to seek at loop-out. The pitch-preserving
/// worker captures this region once and then reads that decoded PCM as a circular source.
#[derive(Debug)]
pub struct LoopWindow {
    generation: AtomicU64,
    enabled: AtomicU8,
    start_us: AtomicU64,
    length_us: AtomicU64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopWindowSnapshot {
    pub start: f64,
    pub length: f64,
}

impl LoopWindowSnapshot {
    pub fn end(self) -> f64 {
        self.start + self.length
    }

    pub fn contains(self, time: f64) -> bool {
        time + 1e-4 >= self.start && time + 1e-4 < self.end()
    }
}

fn seconds_to_us(seconds: f64) -> u64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        0
    } else {
        (seconds * 1_000_000.0).round().max(0.0) as u64
    }
}

fn us_to_seconds(us: u64) -> f64 {
    us as f64 / 1_000_000.0
}

pub fn format_loop_clock(seconds: f64) -> String {
    if !seconds.is_finite() {
        return "--:--.--".to_string();
    }
    let centis = (seconds.max(0.0) * 100.0).round() as i64;
    let cs = centis.rem_euclid(100);
    let total_s = centis / 100;
    let s = total_s.rem_euclid(60);
    let m = total_s / 60;
    format!("{m:02}:{s:02}.{cs:02}")
}

impl LoopWindow {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            enabled: AtomicU8::new(0),
            start_us: AtomicU64::new(0),
            length_us: AtomicU64::new(0),
        }
    }

    pub fn generation(&self) -> u64 {
        self.versioned_snapshot().0
    }

    pub fn start(&self) -> f64 {
        us_to_seconds(self.start_us.load(Ordering::Acquire))
    }

    pub fn length(&self) -> f64 {
        us_to_seconds(self.length_us.load(Ordering::Acquire))
    }

    pub fn set(&self, start: f64, length: f64) {
        let start = start.max(0.0);
        let length = length.max(0.05);
        // Odd revisions are writes in progress; readers retry until they observe one even,
        // unchanged revision around the complete window.
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.start_us.store(seconds_to_us(start), Ordering::Release);
        self.length_us
            .store(seconds_to_us(length), Ordering::Release);
        self.enabled.store(1, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn clear(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.enabled.store(0, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn snapshot(&self) -> Option<LoopWindowSnapshot> {
        self.versioned_snapshot().1
    }

    pub fn versioned_snapshot(&self) -> (u64, Option<LoopWindowSnapshot>) {
        loop {
            let before = self.generation.load(Ordering::Acquire);
            if before & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            let enabled = self.enabled.load(Ordering::Acquire) != 0;
            let start = us_to_seconds(self.start_us.load(Ordering::Acquire));
            let length = us_to_seconds(self.length_us.load(Ordering::Acquire));
            let after = self.generation.load(Ordering::Acquire);
            if before != after {
                continue;
            }
            let snapshot =
                (enabled && length > 0.0).then_some(LoopWindowSnapshot { start, length });
            return (after, snapshot);
        }
    }
}

impl Default for LoopWindow {
    fn default() -> Self {
        Self::new()
    }
}
/// One live STEM frame. Prepared classical Redress and seek-bridge streams emit `blend=1`; an overloaded
/// seek folds its source equally into four temporary lanes so non-unity Rubber Band retains it.
/// `original` is normally the reconstructed four-lane mix used by the renderer's interpolation
/// contract.
#[derive(Clone, Copy, Debug)]
pub struct StemFrame {
    pub lanes: [f32; STEM_LANES * 2],
    pub original: [f32; 2],
    pub blend: f32,
    /// Block-level calibration that makes all four reconstructed lanes match the source mix.
    /// It is interpolated at chunk overlaps and applied before user lane gains in the callback.
    pub reconstruction_gain: f32,
}

impl Default for StemFrame {
    fn default() -> Self {
        Self {
            lanes: [0.0; STEM_LANES * 2],
            original: [0.0; 2],
            blend: 0.0,
            reconstruction_gain: 1.0,
        }
    }
}

impl StemFrame {
    /// Temporary unseparated seek audio folded equally into the four lane channels. Encoding the
    /// bridge as lanes (rather than `blend=0` metadata) keeps it audible through non-unity
    /// eight-channel Rubber Band, which intentionally transports audio channels only.
    fn dry_bridge(frame: [f32; 2]) -> Self {
        let quarter = [frame[0] * 0.25, frame[1] * 0.25];
        Self::separated([
            quarter[0], quarter[1], quarter[0], quarter[1], quarter[0], quarter[1], quarter[0],
            quarter[1],
        ])
    }

    pub fn separated(lanes: [f32; STEM_LANES * 2]) -> Self {
        Self::separated_with_gain(lanes, 1.0)
    }

    pub fn separated_with_gain(lanes: [f32; STEM_LANES * 2], reconstruction_gain: f32) -> Self {
        let reconstruction_gain = if reconstruction_gain.is_finite() {
            reconstruction_gain.clamp(0.5, 2.0)
        } else {
            1.0
        };
        // Bake calibration into the PCM before hop lerp / Rubber Band. Applying the scalar
        // afterwards made an 86 Hz gain staircase that read as buzz at 0% TEMPO.
        let mut scaled = lanes;
        if (reconstruction_gain - 1.0).abs() > f32::EPSILON {
            for sample in &mut scaled {
                *sample *= reconstruction_gain;
            }
        }
        let original = [
            scaled[0] + scaled[2] + scaled[4] + scaled[6],
            scaled[1] + scaled[3] + scaled[5] + scaled[7],
        ];
        Self {
            lanes: scaled,
            original,
            blend: 1.0,
            reconstruction_gain: 1.0,
        }
    }
}

impl TimeStretchFrame for StemFrame {
    const CHANNELS: usize = STEM_LANES * 2;

    fn push_planar(self, channels: &mut [Vec<f32>]) {
        // Calibrate each lane before the shared eight-channel R3 session. Rubber Band only sees
        // audio channels, while the callback can still mute/boost lanes independently afterward.
        // Applying this scalar before a linear time stretch is equivalent to applying it to the
        // reconstructed mix, and avoids treating control metadata as fake audio channels.
        let gain = if self.reconstruction_gain.is_finite() {
            self.reconstruction_gain.clamp(0.5, 2.0)
        } else {
            1.0
        };
        for channel in 0..Self::CHANNELS {
            channels[channel].push(finite(self.lanes[channel] * gain));
        }
    }

    fn from_planar(channels: &[Vec<f32>], frame: usize) -> Self {
        let mut lanes = [0.0; STEM_LANES * 2];
        for channel in 0..Self::CHANNELS {
            lanes[channel] = channels[channel][frame];
        }
        // Calibration is already present in every lane, so the callback must not apply it twice.
        Self::separated(lanes)
    }
}

/// Single-consumer half of a bounded streaming source.
///
/// The platform callback normally owns `consumer`. A pitch-preserving pipeline instead gives the
/// raw ring to one stretch worker and installs its separate post-stretch ring in the callback.
/// There is always exactly one consumer; decode workers own the matching producer.
pub struct StreamSource<F: Copy = [f32; 2]> {
    consumer: UnsafeCell<Consumer<StreamPacket<F>>>,
    counters: Arc<StreamCounters>,
}

// SAFETY: `consumer` has exactly one accessor for the source lifetime (the renderer or one
// stretch worker). Control/decode threads only read atomic counters or own the SPSC producer.
unsafe impl<F: Copy> Send for StreamSource<F> {}
unsafe impl<F: Copy> Sync for StreamSource<F> {}

impl<F: Copy> std::fmt::Debug for StreamSource<F> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StreamSource")
            .field("produced_frames", &self.produced_frames())
            .field("consumed_frames", &self.consumed_frames())
            .field("ended", &self.ended())
            .finish()
    }
}

impl<F: Copy> StreamSource<F> {
    /// Creates a bounded source and its single decode-writer half.
    pub fn bounded(capacity_frames: usize) -> (Arc<Self>, StreamWriter<F>) {
        assert!(
            capacity_frames > 1,
            "stream capacity must contain multiple frames"
        );
        let (producer, consumer) = RingBuffer::new(capacity_frames);
        let counters = Arc::new(StreamCounters {
            produced: AtomicU64::new(0),
            consumed: AtomicU64::new(0),
            ended: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        });
        (
            Arc::new(Self {
                consumer: UnsafeCell::new(consumer),
                counters: Arc::clone(&counters),
            }),
            StreamWriter {
                producer,
                counters,
                generation: 0,
            },
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

    /// Drop already-rendered output before the stream is installed. Safe only while this
    /// source is still pending: the audio callback is the sole consumer after promote.
    pub fn discard_frames(&self, frames: u64) -> u64 {
        self.discard_frames_with_media_advance(frames).0
    }

    /// The native Deck clock advances by packet media time, not by output-frame count. Shadow
    /// seek catch-up needs both values so a non-1x Rubber Band stream lands on the same clock the
    /// callback would have published after consuming these packets.
    pub fn discard_frames_with_media_advance(&self, frames: u64) -> (u64, f64) {
        let mut dropped = 0;
        let mut media_advance = 0.0;
        while dropped < frames {
            let Some((_, advance, _, _)) = self.pop_consumer_timed() else {
                break;
            };
            dropped += 1;
            media_advance += f64::from(advance);
        }
        (dropped, media_advance)
    }

    fn pop_consumer_packet(&self) -> Option<StreamPacket<F>> {
        // SAFETY: documented by the type-level invariant above.
        let consumer = unsafe { &mut *self.consumer.get() };
        loop {
            let packet = consumer.pop().ok()?;
            self.counters.consumed.fetch_add(1, Ordering::Release);
            if packet.generation == self.counters.generation.load(Ordering::Acquire) {
                return Some(packet);
            }
        }
    }

    fn pop_consumer_timed(&self) -> Option<(F, f32, u64, f64)> {
        self.pop_consumer_packet().map(|packet| {
            (
                packet.frame,
                packet.media_advance,
                packet.tempo_revision,
                packet.media_time,
            )
        })
    }

    pub(crate) fn pop_consumer(&self) -> Option<F> {
        self.pop_consumer_timed().map(|(frame, _, _, _)| frame)
    }

    /// Compatibility spelling for module tests. Production callback reads timed packets.
    #[cfg(test)]
    pub(crate) fn pop_callback(&self) -> Option<F> {
        self.pop_consumer()
    }

    pub(crate) fn pop_callback_timed(&self) -> Option<(F, f32, u64, f64)> {
        self.pop_consumer_timed()
    }
}

/// seek 目标与流末尾保持的最小距离：精确 seek 到“正好结尾”（或元数据时长
/// 比真实可解码长度略长）会读出流外，symphonia 以 end of stream 失败告终。
const SEEK_END_MARGIN_SECONDS: f64 = 0.25;
/// seek 失败后的回退步长：逐级提前重试，直到落进流内。
const SEEK_RETRY_STEP_SECONDS: f64 = 1.0;

/// Decode-thread half. It blocks only on its worker thread when read-ahead is full.
pub struct StreamWriter<F: Copy = [f32; 2]> {
    producer: Producer<StreamPacket<F>>,
    counters: Arc<StreamCounters>,
    generation: u64,
}

impl<F: Copy> StreamWriter<F> {
    pub fn buffered_frames(&self) -> u64 {
        self.counters
            .produced
            .load(Ordering::Acquire)
            .saturating_sub(self.counters.consumed.load(Ordering::Acquire))
    }

    pub fn push<G>(&mut self, frame: F, cancelled: G) -> Result<()>
    where
        G: Fn() -> bool,
    {
        self.push_with_media_advance(frame, 1.0, cancelled)
    }

    pub fn push_at<G>(&mut self, frame: F, media_time: f64, cancelled: G) -> Result<()>
    where
        G: Fn() -> bool,
    {
        let _ = self.push_with_media_timing_interruptible(
            frame,
            1.0,
            0,
            media_time,
            cancelled,
            || false,
        )?;
        Ok(())
    }

    fn push_interruptible<G, I>(&mut self, frame: F, cancelled: G, interrupted: I) -> Result<bool>
    where
        G: Fn() -> bool,
        I: Fn() -> bool,
    {
        self.push_with_media_advance_interruptible(frame, 1.0, cancelled, interrupted)
    }

    pub(crate) fn push_with_media_advance<G>(
        &mut self,
        frame: F,
        media_advance: f32,
        cancelled: G,
    ) -> Result<()>
    where
        G: Fn() -> bool,
    {
        let _ = self.push_with_media_timing_interruptible(
            frame,
            media_advance,
            0,
            f64::NAN,
            cancelled,
            || false,
        )?;
        Ok(())
    }

    pub(crate) fn push_with_media_timing<G>(
        &mut self,
        frame: F,
        media_advance: f32,
        tempo_revision: u64,
        media_time: f64,
        cancelled: G,
    ) -> Result<()>
    where
        G: Fn() -> bool,
    {
        let _ = self.push_with_media_timing_interruptible(
            frame,
            media_advance,
            tempo_revision,
            media_time,
            cancelled,
            || false,
        )?;
        Ok(())
    }

    fn push_with_media_advance_interruptible<G, I>(
        &mut self,
        frame: F,
        media_advance: f32,
        cancelled: G,
        interrupted: I,
    ) -> Result<bool>
    where
        G: Fn() -> bool,
        I: Fn() -> bool,
    {
        self.push_with_media_timing_interruptible(
            frame,
            media_advance,
            0,
            f64::NAN,
            cancelled,
            interrupted,
        )
    }

    fn push_with_media_timing_interruptible<G, I>(
        &mut self,
        mut frame: F,
        media_advance: f32,
        tempo_revision: u64,
        media_time: f64,
        cancelled: G,
        interrupted: I,
    ) -> Result<bool>
    where
        G: Fn() -> bool,
        I: Fn() -> bool,
    {
        let media_advance = if media_advance.is_finite() && media_advance > 0.0 {
            media_advance
        } else {
            1.0
        };
        loop {
            if cancelled() || self.producer.is_abandoned() {
                bail!("stream preparation cancelled");
            }
            if interrupted() {
                return Ok(false);
            }
            match self.producer.push(StreamPacket {
                frame,
                generation: self.generation,
                media_advance,
                tempo_revision,
                media_time,
            }) {
                Ok(()) => {
                    self.counters.produced.fetch_add(1, Ordering::Release);
                    return Ok(true);
                }
                Err(PushError::Full(returned)) => {
                    frame = returned.frame;
                    thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }

    /// Make every already-buffered packet stale at a loop/seek discontinuity. The callback remains
    /// the sole ring consumer and discards stale packets before returning the first new frame.
    fn begin_discontinuity(&mut self) {
        self.generation = self
            .counters
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
    }

    pub fn finish(self) {
        self.counters.ended.store(true, Ordering::Release);
    }
}

impl<F: Copy> Drop for StreamWriter<F> {
    fn drop(&mut self) {
        // Decoder errors and cancellation must wake a downstream stretch worker. Without this,
        // an empty raw ring could look merely "not yet decoded" forever after its producer exits.
        self.counters.ended.store(true, Ordering::Release);
    }
}

/// Latest-value STEM seek observed by the hop producer and the Rubber Band worker.
///
/// A transport seek overwrites one atomic position rather than spawning a replacement decoder.
/// Both workers keep their own `seen` generation so each can drain stale PCM independently.
#[derive(Clone, Debug)]
pub struct StreamSeekControl {
    inner: Arc<StreamSeekState>,
}

#[derive(Debug)]
struct StreamSeekState {
    generation: AtomicU64,
    pipeline_generation: AtomicU64,
    position_bits: AtomicU64,
    clock_bits: AtomicU64,
}

impl Default for StreamSeekControl {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamSeekControl {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(StreamSeekState {
                generation: AtomicU64::new(0),
                pipeline_generation: AtomicU64::new(0),
                position_bits: AtomicU64::new(0f64.to_bits()),
                clock_bits: AtomicU64::new((-1.0f64).to_bits()),
            }),
        }
    }

    pub fn request(&self, position: f64) {
        let position = if position.is_finite() {
            position.max(0.0)
        } else {
            0.0
        };
        self.inner
            .position_bits
            .store(position.to_bits(), Ordering::Release);
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::Acquire)
    }

    pub fn position(&self) -> f64 {
        f64::from_bits(self.inner.position_bits.load(Ordering::Acquire))
    }

    /// Authoritative Deck clock for a live STEM producer. Unlike [`Self::request`], this does not
    /// reset Rubber Band; the hop loop jumps only when a whole tile has fallen behind the needle.
    pub fn publish_clock(&self, position: f64) {
        let position = if position.is_finite() {
            position.max(0.0)
        } else {
            -1.0
        };
        self.inner
            .clock_bits
            .store(position.to_bits(), Ordering::Release);
    }

    pub fn clock(&self) -> Option<f64> {
        let position = f64::from_bits(self.inner.clock_bits.load(Ordering::Acquire));
        (position.is_finite() && position >= 0.0).then_some(position)
    }

    /// Returns the latest landing position when `seen` is behind this control.
    pub fn observe(&self, seen: &mut u64) -> Option<f64> {
        let generation = self.generation();
        if generation == *seen {
            None
        } else {
            *seen = generation;
            Some(self.position())
        }
    }

    fn acknowledge_pipeline(&self, generation: u64) {
        self.inner
            .pipeline_generation
            .store(generation, Ordering::Release);
    }

    fn pipeline_acknowledged(&self, generation: u64) -> bool {
        self.inner.pipeline_generation.load(Ordering::Acquire) == generation
    }
}

/// Pointwise frame interpolation shared by the stereo and STEM resampling cursors.
pub trait FrameLerp: Copy {
    fn silence() -> Self;
    fn lerp(self, other: Self, fraction: f32) -> Self;
}

impl FrameLerp for [f32; 2] {
    fn silence() -> Self {
        [0.0; 2]
    }

    fn lerp(self, other: Self, fraction: f32) -> Self {
        [
            self[0] + (other[0] - self[0]) * fraction,
            self[1] + (other[1] - self[1]) * fraction,
        ]
    }
}

impl FrameLerp for StemFrame {
    fn silence() -> Self {
        Self::default()
    }

    fn lerp(self, other: Self, fraction: f32) -> Self {
        let mut lanes = [0.0; STEM_LANES * 2];
        for index in 0..STEM_LANES * 2 {
            lanes[index] = self.lanes[index] + (other.lanes[index] - self.lanes[index]) * fraction;
        }
        Self {
            lanes,
            original: [
                self.original[0] + (other.original[0] - self.original[0]) * fraction,
                self.original[1] + (other.original[1] - self.original[1]) * fraction,
            ],
            blend: self.blend + (other.blend - self.blend) * fraction,
            reconstruction_gain: self.reconstruction_gain
                + (other.reconstruction_gain - self.reconstruction_gain) * fraction,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StreamMetadata {
    pub duration: Option<f64>,
    pub source_sample_rate: u32,
    pub output_sample_rate: u32,
}

/// Maximum auto-loop length accepted by the native transport. Keeping this bounded makes the
/// decoded loop reservoir predictable even for eight-channel STEM frames.
pub const MAX_TRANSPORT_LOOP_SECONDS: f64 = 32.0;
pub const MAX_TRANSPORT_LOOP_PCM_BYTES: usize = 96 * 1024 * 1024;
const LOOP_CAPTURE_HISTORY_SECONDS: f64 = 2.0;

#[derive(Clone, Copy)]
struct TimedPcm<T: Copy> {
    frame: T,
    media_time: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PcmLoopMode {
    Capture,
    Replay,
}

struct PcmLoop<T: Copy> {
    window: LoopWindowSnapshot,
    target_frames: usize,
    frames: Vec<T>,
    mode: PcmLoopMode,
    cursor: usize,
    exit_after_cycle: bool,
}

/// Mixxx-style read-ahead loop for KDJ's bounded streaming pipeline.
///
/// Linear decode remains several seconds ahead and is never seeked by LOOP. This reader retains a
/// short history so an in-point sampled from the audible callback is still available to the worker,
/// captures exactly one half-open in/out PCM region, then serves that region circularly. The
/// untouched raw ring remains parked at loop-out and resumes after the current cycle on LOOP off.
struct PcmLoopReader<T: Copy> {
    sample_rate: f64,
    history_limit: usize,
    history: std::collections::VecDeque<TimedPcm<T>>,
    linear_pending: std::collections::VecDeque<TimedPcm<T>>,
    seen_generation: Option<u64>,
    active: Option<PcmLoop<T>>,
}

impl<T: Copy> PcmLoopReader<T> {
    fn new(output_sample_rate: u32) -> Self {
        let sample_rate = f64::from(output_sample_rate.max(1));
        Self {
            sample_rate,
            history_limit: (sample_rate * LOOP_CAPTURE_HISTORY_SECONDS).ceil() as usize,
            history: std::collections::VecDeque::new(),
            linear_pending: std::collections::VecDeque::new(),
            seen_generation: None,
            active: None,
        }
    }

    fn reset(&mut self) {
        self.history.clear();
        self.linear_pending.clear();
        self.seen_generation = None;
        self.active = None;
    }

    fn sync(&mut self, generation: Option<u64>, window: Option<LoopWindowSnapshot>) {
        if self.seen_generation == generation {
            return;
        }
        self.seen_generation = generation;
        let Some(window) = window else {
            if let Some(active) = self.active.as_mut() {
                if active.mode == PcmLoopMode::Replay {
                    // A DJ loop exits at the next out-point. Jumping straight to decoder look-ahead
                    // from the middle of a cycle would skip the remainder of the phrase.
                    active.exit_after_cycle = true;
                } else {
                    // The first out-point was never crossed, so disabling is a true no-op.
                    self.active = None;
                }
            }
            return;
        };

        let target_frames = (window.length * self.sample_rate).round().max(1.0) as usize;
        let prior = self.active.take();
        if let Some(mut active) = prior
            .filter(|active| (active.window.start - window.start).abs() <= 0.5 / self.sample_rate)
        {
            active.window = window;
            active.target_frames = target_frames;
            active.exit_after_cycle = false;
            if active.frames.capacity() < target_frames {
                active
                    .frames
                    .reserve_exact(target_frames.saturating_sub(active.frames.len()));
            }
            if active.frames.len() > target_frames {
                active.frames.truncate(target_frames);
            }
            if active.frames.len() >= target_frames {
                active.mode = PcmLoopMode::Replay;
                active.cursor %= active.frames.len().max(1);
            }
            self.active = Some(active);
            return;
        }

        let mut active = PcmLoop {
            window,
            target_frames,
            frames: Vec::with_capacity(target_frames),
            mode: PcmLoopMode::Capture,
            cursor: 0,
            exit_after_cycle: false,
        };
        for packet in &self.history {
            Self::capture_packet(self.sample_rate, &mut active, *packet);
            if active.frames.len() >= active.target_frames {
                break;
            }
        }
        if active.frames.len() >= active.target_frames {
            active.mode = PcmLoopMode::Replay;
        }
        self.active = Some(active);
    }

    fn capture_packet(sample_rate: f64, active: &mut PcmLoop<T>, packet: TimedPcm<T>) {
        if !packet.media_time.is_finite() || active.frames.len() >= active.target_frames {
            return;
        }
        let tolerance = 0.51 / sample_rate;
        let expected = active.window.start + active.frames.len() as f64 / sample_rate;
        if packet.media_time + tolerance < expected {
            return;
        }
        if packet.media_time > expected + tolerance {
            // Decoder timestamps should be contiguous here. For a sub-frame timestamp hole, hold
            // the previous sample rather than shortening the loop and accumulating phase error.
            let fill = active.frames.last().copied().unwrap_or(packet.frame);
            while active.frames.len() < active.target_frames {
                let next = active.window.start + active.frames.len() as f64 / sample_rate;
                if next + tolerance >= packet.media_time {
                    break;
                }
                active.frames.push(fill);
            }
        }
        if active.frames.len() < active.target_frames {
            active.frames.push(packet.frame);
        }
    }

    fn remember_linear(&mut self, packet: TimedPcm<T>) {
        if !packet.media_time.is_finite() {
            return;
        }
        if self
            .history
            .back()
            .is_some_and(|last| packet.media_time + 1.0 / self.sample_rate < last.media_time)
        {
            self.history.clear();
        }
        self.history.push_back(packet);
        while self.history.len() > self.history_limit {
            self.history.pop_front();
        }
    }

    fn pop_linear(&mut self, raw: &StreamSource<T>) -> Option<TimedPcm<T>> {
        self.linear_pending.pop_front().or_else(|| {
            raw.pop_consumer_packet().map(|packet| TimedPcm {
                frame: packet.frame,
                media_time: packet.media_time,
            })
        })
    }

    fn next(&mut self, raw: &StreamSource<T>) -> Option<TimedPcm<T>> {
        loop {
            if let Some(active) = self.active.as_mut() {
                if active.mode == PcmLoopMode::Capture
                    && active.frames.len() >= active.target_frames
                {
                    active.mode = PcmLoopMode::Replay;
                    active.cursor = 0;
                }
                if active.mode == PcmLoopMode::Replay {
                    if active.cursor >= active.frames.len() {
                        if active.exit_after_cycle {
                            self.active = None;
                            continue;
                        }
                        if active.frames.len() < active.target_frames {
                            // The user enlarged the active loop. Finish the old cycle, then consume
                            // untouched linear PCM from the old out-point to the new out-point.
                            active.mode = PcmLoopMode::Capture;
                        } else {
                            active.cursor = 0;
                        }
                    }
                    if active.mode == PcmLoopMode::Replay {
                        let cursor = active.cursor;
                        active.cursor += 1;
                        return Some(TimedPcm {
                            frame: active.frames[cursor],
                            media_time: active.window.start + cursor as f64 / self.sample_rate,
                        });
                    }
                }
            }

            let packet = self.pop_linear(raw)?;
            self.remember_linear(packet);
            let Some(active) = self.active.as_mut() else {
                return Some(packet);
            };
            if active.mode != PcmLoopMode::Capture {
                continue;
            }
            if packet.media_time.is_finite()
                && packet.media_time + 0.5 / self.sample_rate >= active.window.end()
            {
                if active.frames.is_empty() {
                    // The history should always contain an audible in-point. Never fabricate a
                    // loop from unrelated audio if that invariant is violated.
                    self.active = None;
                    return Some(packet);
                }
                let fill = *active.frames.last().expect("checked non-empty loop cache");
                active.frames.resize(active.target_frames, fill);
                active.mode = PcmLoopMode::Replay;
                active.cursor = 0;
                self.linear_pending.push_front(packet);
                continue;
            }
            Self::capture_packet(self.sample_rate, active, packet);
            return Some(packet);
        }
    }

    fn is_replaying(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.mode == PcmLoopMode::Replay)
    }
}

/// Connect a long decoded read-ahead ring to a short post-stretch ring consumed by the audio
/// callback.
///
/// Keeping the two rings separate is intentional. The decoder retains its four-second cushion
/// for disk/network jitter, while the audible ring stays short enough that a new TEMPO target is
/// heard within a fraction of a second instead of sitting behind seconds of already-rendered PCM.
/// The decoder and Rubber Band worker are independent because either side may block on its own
/// bounded ring; running both operations on one thread would deadlock once the raw cushion filled.
pub fn run_pitch_preserving_pipeline<T, D>(
    tempo: TempoControl,
    output_sample_rate: u32,
    raw_capacity_frames: usize,
    mut output_writer: StreamWriter<T>,
    decode: D,
    cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    loop_window: Option<Arc<LoopWindow>>,
    seek: Option<StreamSeekControl>,
) -> Result<StreamMetadata>
where
    T: TimeStretchFrame,
    D: FnOnce(StreamWriter<T>, Arc<dyn Fn() -> bool + Send + Sync>) -> Result<StreamMetadata>
        + Send
        + 'static,
{
    let (raw, raw_writer) = StreamSource::bounded(raw_capacity_frames);
    let (decoder_done, decoder_result) = mpsc::sync_channel(1);
    let decoder_cancelled = Arc::clone(&cancelled);
    thread::Builder::new()
        .name("kdj-tempo-decode".to_string())
        .spawn(move || {
            kdj_core::thread_qos::prefer_live_audio();
            let result = decode(raw_writer, decoder_cancelled);
            let _ = decoder_done.send(result);
        })
        .context("start tempo decode worker")?;

    kdj_core::thread_qos::prefer_live_audio();

    let mut stretcher = PitchPreservingStretcher::new(tempo.clone(), output_sample_rate)?;
    let mut loop_reader = PcmLoopReader::new(output_sample_rate);
    let mut seen_seek = seek
        .as_ref()
        .map(StreamSeekControl::generation)
        .unwrap_or(0);
    loop {
        if cancelled() {
            bail!("stream preparation cancelled");
        }
        if let Some(control) = &seek {
            if control.observe(&mut seen_seek).is_some() {
                loop_reader.reset();
                while raw.pop_consumer().is_some() {}
                output_writer.begin_discontinuity();
                stretcher.reset()?;
                control.acknowledge_pipeline(seen_seek);
                continue;
            }
        }
        let (loop_generation, loop_snapshot) = loop_window
            .as_ref()
            .map(|window| {
                let (generation, snapshot) = window.versioned_snapshot();
                (Some(generation), snapshot)
            })
            .unwrap_or((None, None));
        loop_reader.sync(loop_generation, loop_snapshot);
        if let Some(packet) = loop_reader.next(&raw) {
            stretcher.push_timed(
                packet.frame,
                packet.media_time,
                |output, media_advance, tempo_revision, out_time| {
                    output_writer.push_with_media_timing(
                        output,
                        media_advance,
                        tempo_revision,
                        out_time,
                        &*cancelled,
                    )
                },
            )?;
            continue;
        }
        if raw.ended() && !loop_reader.is_replaying() {
            break;
        }
        // The producer may be decoding a compressed packet or waiting on HTTP. This is a worker
        // only; yielding here keeps it from stealing the UI/audio callback's time slice.
        thread::sleep(Duration::from_millis(1));
    }
    stretcher.finish_timed(|output, media_advance, tempo_revision, out_time| {
        output_writer.push_with_media_timing(
            output,
            media_advance,
            tempo_revision,
            out_time,
            &*cancelled,
        )
    })?;
    output_writer.finish();
    decoder_result
        .recv()
        .map_err(|_| anyhow::anyhow!("tempo decode worker ended without a result"))?
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
    writer: StreamWriter,
    cancelled: F,
) -> Result<StreamMetadata>
where
    F: Fn() -> bool + Copy,
{
    decode_source_streaming_seekable(
        source,
        hint_extension,
        source_label,
        position,
        output_sample_rate,
        writer,
        cancelled,
        None,
    )
}

#[derive(Clone, Copy, Debug)]
struct DecodeSeekLanding {
    target: f64,
    actual: f64,
}

fn timestamp_seconds(time_base: Option<TimeBase>, timestamp: u64, fallback: f64) -> f64 {
    let Some(time_base) = time_base else {
        return fallback;
    };
    let time = time_base.calc_time(timestamp);
    time.seconds as f64 + time.frac
}

fn landing_output_position(landing: DecodeSeekLanding, source_sample_rate: u32) -> f64 {
    if source_sample_rate == 0 {
        0.0
    } else {
        ((landing.target - landing.actual).max(0.0) * f64::from(source_sample_rate)).ceil()
    }
}

fn logical_media_time(
    emit_start: f64,
    next_output_position: f64,
    clock_base_position: f64,
    source_sample_rate: u32,
) -> f64 {
    if source_sample_rate == 0 {
        emit_start
    } else {
        emit_start + (next_output_position - clock_base_position) / f64::from(source_sample_rate)
    }
}

fn apply_decode_landing(
    landing: DecodeSeekLanding,
    source_sample_rate: u32,
    origin: &mut f64,
    emit_start: &mut f64,
    source_index: &mut u64,
    next_output_position: &mut f64,
    clock_base_position: &mut f64,
    previous: &mut Option<[f32; 2]>,
) {
    *origin = landing.actual;
    *emit_start = landing.target;
    *source_index = 0;
    *next_output_position = landing_output_position(landing, source_sample_rate);
    *clock_base_position = *next_output_position;
    *previous = None;
}

fn seek_format_time(
    format: &mut dyn symphonia::core::formats::FormatReader,
    track_id: u32,
    mut position: f64,
    time_base: Option<TimeBase>,
) -> Result<DecodeSeekLanding> {
    position = position.max(0.0);
    let mut attempt = position;
    loop {
        match format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::from(attempt),
                track_id: Some(track_id),
            },
        ) {
            Ok(seeked) => {
                return Ok(DecodeSeekLanding {
                    target: attempt,
                    actual: timestamp_seconds(time_base, seeked.actual_ts, attempt).max(0.0),
                });
            }
            Err(error) => {
                let next = (attempt - SEEK_RETRY_STEP_SECONDS).max(0.0);
                if next >= attempt {
                    return Err(error).with_context(|| format!("seek audio to {position:.3}s"));
                }
                attempt = next;
            }
        }
    }
}

/// Decode at the hardware sample rate only. Tempo and BPM Sync are deliberately absent from this
/// API: every non-unit playback rate is applied later by [`run_pitch_preserving_pipeline`].
pub fn decode_source_streaming_seekable<F>(
    source: Box<dyn StreamingMediaSource>,
    hint_extension: Option<&str>,
    source_label: &str,
    position: f64,
    output_sample_rate: u32,
    mut writer: StreamWriter,
    cancelled: F,
    seek: Option<StreamSeekControl>,
) -> Result<StreamMetadata>
where
    F: Fn() -> bool + Copy,
{
    let metadata = decode_source_core(
        source,
        hint_extension,
        source_label,
        position,
        output_sample_rate,
        None,
        |frame, media_time| writer.push_at(frame, media_time, cancelled),
        cancelled,
        seek,
    )?;
    writer.finish();
    Ok(metadata)
}

#[allow(clippy::too_many_arguments)]
fn decode_source_core<S, F>(
    source: Box<dyn StreamingMediaSource>,
    hint_extension: Option<&str>,
    source_label: &str,
    position: f64,
    output_sample_rate: u32,
    output_limit: Option<u64>,
    mut sink: S,
    cancelled: F,
    seek: Option<StreamSeekControl>,
) -> Result<StreamMetadata>
where
    S: FnMut([f32; 2], f64) -> Result<()>,
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
    let mut source_sample_rate = params.sample_rate.filter(|rate| *rate > 0).unwrap_or(0);
    let initial_landing = if position > 0.0 {
        let landing = seek_format_time(&mut *format, track_id, position, params.time_base)?;
        decoder.reset();
        landing
    } else {
        DecodeSeekLanding {
            target: 0.0,
            actual: 0.0,
        }
    };
    let mut origin = initial_landing.actual;
    let mut emit_start = initial_landing.target;
    let mut seen_seek = seek
        .as_ref()
        .map(StreamSeekControl::generation)
        .unwrap_or(0);

    let mut conversion: Option<(SampleBuffer<f32>, u64, usize, u32)> = None;
    let mut previous: Option<[f32; 2]> = None;
    let mut source_index = 0u64;
    let mut next_output_position = landing_output_position(initial_landing, source_sample_rate);
    let mut clock_base_position = next_output_position;
    let mut produced = 0u64;

    'packets: loop {
        if cancelled() {
            bail!("stream preparation cancelled");
        }
        if let Some(control) = &seek {
            if let Some(at) = control.observe(&mut seen_seek) {
                let landing = seek_format_time(&mut *format, track_id, at, params.time_base)?;
                decoder.reset();
                apply_decode_landing(
                    landing,
                    source_sample_rate,
                    &mut origin,
                    &mut emit_start,
                    &mut source_index,
                    &mut next_output_position,
                    &mut clock_base_position,
                    &mut previous,
                );
                continue;
            }
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
        if source_sample_rate == 0 {
            next_output_position = ((emit_start - origin).max(0.0) * f64::from(spec.rate)).ceil();
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
                    let media_time = logical_media_time(
                        emit_start,
                        next_output_position,
                        clock_base_position,
                        source_sample_rate,
                    );
                    sink(
                        [
                            before[0] + (current[0] - before[0]) * fraction,
                            before[1] + (current[1] - before[1]) * fraction,
                        ],
                        media_time,
                    )?;
                    produced = produced.saturating_add(1);
                    if output_limit.is_some_and(|limit| produced >= limit) {
                        break 'packets;
                    }
                    next_output_position += step;
                }
            }
            previous = Some(current);
            source_index = source_index.saturating_add(1);
        }
    }

    if source_sample_rate == 0 || produced == 0 {
        bail!("decoded audio stream is empty");
    }
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
    decode_file_streaming_seekable(path, position, output_sample_rate, writer, cancelled, None)
}

pub fn decode_file_streaming_seekable<F>(
    path: &Path,
    position: f64,
    output_sample_rate: u32,
    writer: StreamWriter,
    cancelled: F,
    seek: Option<StreamSeekControl>,
) -> Result<StreamMetadata>
where
    F: Fn() -> bool + Copy,
{
    let file = File::open(path).with_context(|| format!("open audio: {}", path.display()))?;
    let extension = path.extension().and_then(|value| value.to_str());
    decode_source_streaming_seekable(
        Box::new(file),
        extension,
        &path.display().to_string(),
        position,
        output_sample_rate,
        writer,
        cancelled,
        seek,
    )
}

/// Runs the classical Redress background-cache path ahead of one live Deck.
///
/// Cache misses are handled by the coordinator: original audio remains audible until this worker
/// has a context-safe separated cushion, then the prepared stream replaces it at a block boundary.
#[allow(clippy::too_many_arguments)]
pub fn decode_live_stem_streaming<F>(
    path: &Path,
    track_id: i64,
    deck: usize,
    position: f64,
    duration: f64,
    output_sample_rate: u32,
    pool: Arc<StemInferencePool>,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    mut writer: StreamWriter<StemFrame>,
    cancelled: F,
    seek: Option<StreamSeekControl>,
) -> Result<StreamMetadata>
where
    F: Fn() -> bool + Copy,
{
    if output_sample_rate == 0 {
        bail!("output sample rate must be non-zero");
    }
    let _audio_lease = begin_live_stem_audio_lease();
    let stride = live_stem_output_stride_frames();
    let stride_seconds = stride as f64 / f64::from(STEM_SAMPLE_RATE);
    let hop_epoch = Arc::new(AtomicU64::new(0));
    let mut hop_expected = 0u64;
    let mut seen_seek = seek
        .as_ref()
        .map(StreamSeekControl::generation)
        .unwrap_or(0);
    let mut cursor = StemWindowCursor::new();
    let instant_pool = pool.instant_pool();
    let instant_preparation =
        instant_pool
            .as_ref()
            .and_then(|instant| match instant.prepare_track(path) {
                Ok(ticket) => Some(ticket),
                Err(error) => {
                    tracing::warn!(error = %error, "instant STEM PCM preload unavailable");
                    None
                }
            });
    let requested_start = position.max(0.0);
    let requested_frame = (requested_start * f64::from(STEM_SAMPLE_RATE)).round() as u64;
    let cached_core_frame = requested_frame / stride as u64 * stride as u64;
    let cached_core_start = cached_core_frame as f64 / f64::from(STEM_SAMPLE_RATE);
    let cached_offset = requested_frame.saturating_sub(cached_core_frame) as usize;
    let cached = (cached_offset < stride)
        .then(|| stem_tile_cache_key(path, cached_core_start))
        .and_then(|key| pool.cached_for_key(&key));
    let (mut chunk_start, first_offset, mut current) = if let Some(chunk) = cached {
        tracing::debug!(
            requested_start,
            cached_core_start,
            cached_offset,
            "live STEM reused a completed audio tile"
        );
        (cached_core_start, cached_offset, chunk)
    } else {
        let (left, right) = cursor.window_for_core(path, requested_start)?;
        let ticket = pool.submit_for(
            stem_tile_cache_key(path, requested_start),
            left,
            right,
            Arc::clone(&hop_epoch),
            hop_expected,
        )?;
        let chunk = await_stem_ticket(
            &ticket,
            Arc::clone(&hop_epoch),
            hop_expected,
            cancelled,
            || false,
        )?;
        (requested_start, 0, chunk)
    };
    // First enablement is still bridged by ORG in the coordinator. Do not promote that refined
    // stream until its whole-track random PCM and physical-Deck HS session are warm; after
    // promotion every ordinary seek can take the low-latency path without paying decode/session
    // startup in the transport gesture.
    let layered_instant = match (instant_pool, instant_preparation) {
        (Some(instant), Some(preparation)) => {
            match preparation
                .wait(cancelled)
                .and_then(|track| instant.wait_ready(deck, cancelled).map(|_| track))
            {
                Ok(track) => Some(LayeredInstant {
                    pool: instant,
                    track,
                }),
                Err(error) => {
                    tracing::warn!(error = %error, "instant STEM warm-up unavailable; using refinement bridge");
                    None
                }
            }
        }
        _ => None,
    };
    let mut resampler = LiveStemResampler::new(output_sample_rate, chunk_start);
    let mut remaining_source_frames = if duration.is_finite() && duration > 0.0 {
        ((duration - requested_start).max(0.0) * f64::from(STEM_SAMPLE_RATE)).ceil() as u64
    } else {
        u64::MAX
    };
    let first_frames = remaining_source_frames.min((stride - first_offset) as u64) as usize;
    let mut hold_chunk_start;
    let mut look_aheads = Vec::new();
    keep_live_stem_look_ahead(
        path,
        track_id,
        chunk_start,
        stride_seconds,
        duration,
        Arc::clone(&pool),
        Arc::clone(&hop_epoch),
        hop_expected,
        cancelled,
        &mut look_aheads,
    )?;
    let (pushed, outcome) = push_stem_range(
        &current,
        first_offset,
        first_frames,
        chunk_start,
        &mut resampler,
        &mut writer,
        cancelled,
        || stem_seek_pending(seek.as_ref(), seen_seek),
    )?;
    if matches!(outcome, StemPushOutcome::Interrupted) {
        hold_chunk_start = true;
    } else {
        hold_chunk_start = false;
        remaining_source_frames = remaining_source_frames.saturating_sub(pushed as u64);
    }

    while remaining_source_frames > 0 {
        if cancelled() || epoch.load(Ordering::Acquire) != expected_epoch {
            bail!("STEM live stream preparation cancelled");
        }
        if let Some(control) = &seek {
            if let Some(at) = control.observe(&mut seen_seek) {
                hop_expected = hop_expected.wrapping_add(1);
                hop_epoch.store(hop_expected, Ordering::Release);
                look_aheads.clear();
                writer.begin_discontinuity();
                wait_for_pipeline_seek_ack(seek.as_ref(), seen_seek, cancelled, || {
                    stem_seek_pending(seek.as_ref(), seen_seek)
                })?;
                cursor = StemWindowCursor::new();
                chunk_start = at.max(0.0);
                resampler.reset(chunk_start);
                remaining_source_frames = if duration.is_finite() && duration > 0.0 {
                    ((duration - chunk_start).max(0.0) * f64::from(STEM_SAMPLE_RATE)).ceil() as u64
                } else {
                    u64::MAX
                };
                let frames = remaining_source_frames.min(stride as u64) as usize;
                let key = stem_tile_cache_key(path, chunk_start);
                let cached_refinement = pool.cached_for_key(&key);
                let bridge = if let Some(chunk) = cached_refinement {
                    SeekBridgeResult {
                        refined: chunk,
                        pushed: 0,
                        outcome: StemPushOutcome::Complete,
                    }
                } else {
                    let (left, right) = match cursor.window_for_core(path, chunk_start) {
                        Ok(chunk) => chunk,
                        Err(error) => return Err(error),
                    };
                    let admission = layered_instant
                        .as_ref()
                        .and_then(|_| try_acquire_instant_admission(deck));
                    let ticket =
                        pool.submit_for(key, left, right, Arc::clone(&hop_epoch), hop_expected)?;
                    if let Some(layered) = layered_instant.as_ref() {
                        match push_seek_bridge_until_refined(
                            layered,
                            admission,
                            &ticket,
                            chunk_start,
                            frames,
                            &mut resampler,
                            &mut writer,
                            Arc::clone(&hop_epoch),
                            hop_expected,
                            cancelled,
                            || stem_seek_pending(seek.as_ref(), seen_seek),
                            deck,
                        ) {
                            Ok(result) => result,
                            Err(_error)
                                if !cancelled() && stem_seek_pending(seek.as_ref(), seen_seek) =>
                            {
                                hold_chunk_start = true;
                                continue;
                            }
                            Err(error) => return Err(error),
                        }
                    } else {
                        let refined = match await_stem_ticket(
                            &ticket,
                            Arc::clone(&hop_epoch),
                            hop_expected,
                            cancelled,
                            || stem_seek_pending(seek.as_ref(), seen_seek),
                        ) {
                            Ok(chunk) => chunk,
                            Err(_error)
                                if !cancelled() && stem_seek_pending(seek.as_ref(), seen_seek) =>
                            {
                                hold_chunk_start = true;
                                continue;
                            }
                            Err(error) => return Err(error),
                        };
                        SeekBridgeResult {
                            refined,
                            pushed: 0,
                            outcome: StemPushOutcome::Complete,
                        }
                    }
                };
                current = bridge.refined;
                if matches!(bridge.outcome, StemPushOutcome::Interrupted) {
                    hold_chunk_start = true;
                    continue;
                }
                keep_live_stem_look_ahead(
                    path,
                    track_id,
                    chunk_start,
                    stride_seconds,
                    duration,
                    Arc::clone(&pool),
                    Arc::clone(&hop_epoch),
                    hop_expected,
                    cancelled,
                    &mut look_aheads,
                )?;
                let (refined_pushed, outcome) = if bridge.pushed < frames {
                    push_stem_range(
                        &current,
                        bridge.pushed,
                        frames - bridge.pushed,
                        chunk_start,
                        &mut resampler,
                        &mut writer,
                        cancelled,
                        || stem_seek_pending(seek.as_ref(), seen_seek),
                    )?
                } else {
                    (0, StemPushOutcome::Complete)
                };
                if matches!(outcome, StemPushOutcome::Interrupted) {
                    hold_chunk_start = true;
                    continue;
                }
                remaining_source_frames =
                    remaining_source_frames.saturating_sub((bridge.pushed + refined_pushed) as u64);
                hold_chunk_start = false;
                continue;
            }
        }
        if !hold_chunk_start {
            chunk_start += stride as f64 / f64::from(STEM_SAMPLE_RATE);
        }
        hold_chunk_start = false;
        if let Some(at) = live_stem_skip_behind_start(
            chunk_start,
            seek.as_ref()
                .and_then(StreamSeekControl::clock)
                .unwrap_or(chunk_start),
            stride_seconds,
            duration,
        ) {
            hop_expected = hop_expected.wrapping_add(1);
            hop_epoch.store(hop_expected, Ordering::Release);
            look_aheads.clear();
            writer.begin_discontinuity();
            cursor = StemWindowCursor::new();
            chunk_start = at;
            resampler.reset(chunk_start);
            remaining_source_frames = if duration.is_finite() && duration > 0.0 {
                ((duration - chunk_start).max(0.0) * f64::from(STEM_SAMPLE_RATE)).ceil() as u64
            } else {
                u64::MAX
            };
        }
        let next_frames = remaining_source_frames.min(stride as u64) as usize;
        let next = if let Some(tile) = take_look_ahead_for(&mut look_aheads, chunk_start) {
            match await_prefetched_stem_chunk(
                tile,
                Arc::clone(&hop_epoch),
                hop_expected,
                cancelled,
                || stem_seek_pending(seek.as_ref(), seen_seek),
            ) {
                Ok(chunk) => chunk,
                Err(_error) if !cancelled() && stem_seek_pending(seek.as_ref(), seen_seek) => {
                    hold_chunk_start = true;
                    continue;
                }
                Err(error) => return Err(error),
            }
        } else {
            let (left, right) = match cursor.window_for_core(path, chunk_start) {
                Ok(chunk) => chunk,
                Err(error) if duration <= 0.0 => {
                    tracing::debug!(error = %error, "live STEM reached source end");
                    break;
                }
                Err(error) => return Err(error),
            };
            let ticket = pool.submit_for(
                stem_tile_cache_key(path, chunk_start),
                left,
                right,
                Arc::clone(&hop_epoch),
                hop_expected,
            )?;
            match await_stem_ticket(
                &ticket,
                Arc::clone(&hop_epoch),
                hop_expected,
                cancelled,
                || stem_seek_pending(seek.as_ref(), seen_seek),
            ) {
                Ok(chunk) => chunk,
                Err(_error) if !cancelled() && stem_seek_pending(seek.as_ref(), seen_seek) => {
                    hold_chunk_start = true;
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        keep_live_stem_look_ahead(
            path,
            track_id,
            chunk_start,
            stride_seconds,
            duration,
            Arc::clone(&pool),
            Arc::clone(&hop_epoch),
            hop_expected,
            cancelled,
            &mut look_aheads,
        )?;
        let (pushed, outcome) = push_stem_overlap_range(
            &current,
            &next,
            0,
            next_frames,
            chunk_start,
            &mut resampler,
            &mut writer,
            cancelled,
            || stem_seek_pending(seek.as_ref(), seen_seek),
        )?;
        if matches!(outcome, StemPushOutcome::Interrupted) {
            hold_chunk_start = true;
            continue;
        }
        current = next;
        remaining_source_frames = remaining_source_frames.saturating_sub(pushed as u64);
        if remaining_source_frames == 0 {
            break;
        }
        if pushed < stride {
            break;
        }
    }
    writer.finish();
    Ok(StreamMetadata {
        duration: (duration.is_finite() && duration > 0.0).then_some(duration),
        source_sample_rate: STEM_SAMPLE_RATE,
        output_sample_rate,
    })
}

/// Keep the next [`LIVE_STEM_LOOKAHEAD_TILES`] successor windows on the look-ahead lane.
/// Two workers can then infer future slices while this thread still pushes the current tile.
fn live_stem_look_ahead_starts(from: f64, stride: f64, duration: f64) -> Vec<f64> {
    (1..=LIVE_STEM_LOOKAHEAD_TILES)
        .map(|index| from + stride * index as f64)
        .filter(|start| {
            start.is_finite()
                && *start >= 0.0
                && !(duration.is_finite() && duration > 0.0 && *start >= duration)
        })
        .collect()
}

fn live_stem_core_start(position: f64, stride_seconds: f64) -> f64 {
    if !position.is_finite()
        || position <= 0.0
        || !stride_seconds.is_finite()
        || stride_seconds <= 0.0
    {
        return position.max(0.0);
    }
    (position / stride_seconds).floor() * stride_seconds
}

/// A tile whose retained core is already behind the audible needle must not occupy the
/// separator. Inference slower than realtime must not keep walking an already-played intro while
/// the authoritative Deck clock has moved tens of seconds ahead.
fn live_stem_skip_behind_start(
    chunk_start: f64,
    clock: f64,
    stride_seconds: f64,
    duration: f64,
) -> Option<f64> {
    if !clock.is_finite() || clock < 0.0 || stride_seconds <= 0.0 {
        return None;
    }
    if chunk_start + stride_seconds + 1e-3 >= clock {
        return None;
    }
    let aligned = live_stem_core_start(clock, stride_seconds);
    if aligned <= chunk_start + 1e-6 {
        return None;
    }
    if duration.is_finite() && duration > 0.0 && aligned >= duration {
        return None;
    }
    Some(aligned)
}

fn take_look_ahead_for(
    tiles: &mut Vec<LiveStemLookAhead>,
    start: f64,
) -> Option<LiveStemLookAhead> {
    let index = tiles.iter().position(|tile| tile.is_for(start))?;
    Some(tiles.remove(index))
}

#[allow(clippy::too_many_arguments)]
fn keep_live_stem_look_ahead<F>(
    path: &Path,
    track_id: i64,
    current_start: f64,
    stride_seconds: f64,
    duration: f64,
    pool: Arc<StemInferencePool>,
    hop_epoch: Arc<AtomicU64>,
    hop_expected: u64,
    cancelled: F,
    tiles: &mut Vec<LiveStemLookAhead>,
) -> Result<()>
where
    F: Fn() -> bool + Copy,
{
    let epsilon = 1.0 / f64::from(STEM_SAMPLE_RATE);
    tiles.retain(|tile| tile.start + epsilon >= current_start);
    for start in live_stem_look_ahead_starts(current_start, stride_seconds, duration) {
        if tiles.iter().any(|tile| tile.is_for(start)) {
            continue;
        }
        match prefetch_live_stem_block(
            path,
            track_id,
            start,
            duration,
            Arc::clone(&pool),
            Arc::clone(&hop_epoch),
            hop_expected,
            cancelled,
        )? {
            Some(tile) => tiles.push(tile),
            None => break,
        }
    }
    Ok(())
}

/// Queue one future classical Redress tile on the look-ahead lane. A full look-ahead queue
/// means audio still owns both workers; this Deck retries later or submits
/// the same window as mandatory audio when it becomes the audible boundary.
#[allow(clippy::too_many_arguments)]
fn prefetch_live_stem_block<F>(
    path: &Path,
    track_id: i64,
    start: f64,
    duration: f64,
    pool: Arc<StemInferencePool>,
    hop_epoch: Arc<AtomicU64>,
    hop_expected: u64,
    cancelled: F,
) -> Result<Option<LiveStemLookAhead>>
where
    F: Fn() -> bool + Copy,
{
    if !start.is_finite()
        || start < 0.0
        || (duration.is_finite() && duration > 0.0 && start >= duration)
        || cancelled()
        || hop_epoch.load(Ordering::Acquire) != hop_expected
    {
        return Ok(None);
    }
    let (left, right) = StemWindowCursor::new().window_for_core(path, start)?;
    if duration.is_finite() && duration > 0.0 {
        let remaining = ((duration - start).max(0.0) * f64::from(STEM_SAMPLE_RATE)).ceil();
        if remaining < 1.0 {
            return Ok(None);
        }
    }
    // Future tiles stay on the look-ahead lane so they cannot jump ahead of the other Deck's
    // currently audible block. Two workers can still run two successors at once; a full queue
    // means this Deck will submit the window as mandatory audio when it reaches the boundary.
    let Some(ticket) = pool.submit_look_ahead_for(
        stem_tile_cache_key(path, start),
        left,
        right,
        Arc::clone(&hop_epoch),
        hop_expected,
    )?
    else {
        return Ok(None);
    };
    let result = Arc::new(Mutex::new(None));
    let published_result = Arc::clone(&result);
    std::thread::Builder::new()
        .name(format!("kdj-live-stem-lookahead-{track_id}-{hop_expected}"))
        .spawn(move || {
            let outcome = ticket.wait();
            *published_result.lock().unwrap() = Some(outcome);
        })
        .context("启动 STEM look-ahead worker")?;
    Ok(Some(LiveStemLookAhead { start, result }))
}

fn await_prefetched_stem_chunk<F, R>(
    look_ahead: LiveStemLookAhead,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    cancelled: F,
    retargeted: R,
) -> Result<Arc<StemChunk>>
where
    F: Fn() -> bool + Copy,
    R: Fn() -> bool + Copy,
{
    loop {
        if let Some(result) = look_ahead.try_take() {
            return match result {
                Ok(chunk) => Ok(chunk),
                Err(_)
                    if !cancelled()
                        && (retargeted() || epoch.load(Ordering::Acquire) != expected_epoch) =>
                {
                    bail!("STEM hop retargeted")
                }
                Err(error) => Err(error),
            };
        }
        if cancelled() {
            bail!("STEM live stream preparation cancelled");
        }
        if retargeted() || epoch.load(Ordering::Acquire) != expected_epoch {
            bail!("STEM hop retargeted");
        }
        thread::sleep(Duration::from_millis(1));
    }
}

struct SeekBridgeResult {
    refined: Arc<StemChunk>,
    pushed: usize,
    outcome: StemPushOutcome,
}

#[allow(clippy::too_many_arguments)]
fn push_seek_bridge_until_refined<F, I>(
    layered: &LayeredInstant,
    admission: Option<InstantAdmissionGuard>,
    ticket: &kdj_stems::StemInferenceTicket,
    chunk_start: f64,
    frames: usize,
    resampler: &mut LiveStemResampler,
    writer: &mut StreamWriter<StemFrame>,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    cancelled: F,
    interrupted: I,
    deck: usize,
) -> Result<SeekBridgeResult>
where
    F: Fn() -> bool + Copy,
    I: Fn() -> bool + Copy,
{
    let started = std::time::Instant::now();
    let mut pushed = 0usize;
    let mut instant_active = admission.is_some();
    if let Some(refined) = ticket.try_wait()? {
        return Ok(SeekBridgeResult {
            refined,
            pushed: 0,
            outcome: StemPushOutcome::Complete,
        });
    }
    // Dry PCM is deliberately independent from model throughput. Rebuild a bounded destination
    // cushion first, then let HS-TasNet replace only future hops when it meets the audio deadline.
    // This preserves the immediate target-position jump without exposing callback starvation as
    // periodic silence/rebuffer pulses.
    if frames > 0 {
        let prefill = seek_bridge_prefill_frames(frames);
        let source_frame = (chunk_start * f64::from(STEM_SAMPLE_RATE)).round() as u64;
        let dry = dry_bridge_frames(&layered.track, source_frame, prefill);
        let outcome = push_seek_bridge_frames(
            &dry,
            0,
            chunk_start,
            resampler,
            writer,
            cancelled,
            interrupted,
        )?;
        pushed = prefill;
        if !matches!(outcome, StemPushOutcome::Complete) {
            let refined = await_stem_ticket(
                ticket,
                Arc::clone(&epoch),
                expected_epoch,
                cancelled,
                interrupted,
            )?;
            return Ok(SeekBridgeResult {
                refined,
                pushed,
                outcome,
            });
        }
    }
    let mut instant_started = false;
    while pushed < frames {
        if cancelled() {
            bail!("STEM live stream preparation cancelled");
        }
        if interrupted() || epoch.load(Ordering::Acquire) != expected_epoch {
            bail!("STEM hop retargeted");
        }
        let ready_before = ticket.try_wait()?;
        if let Some(refined) = ready_before.as_ref().filter(|_| pushed == 0) {
            return Ok(SeekBridgeResult {
                refined: Arc::clone(refined),
                pushed: 0,
                outcome: StemPushOutcome::Complete,
            });
        }
        let hop_frames = (frames - pushed).min(INSTANT_HOP_FRAMES);
        let source_frame = ((chunk_start * f64::from(STEM_SAMPLE_RATE)).round() as u64)
            .saturating_add(pushed as u64);
        let bridge = if instant_active {
            match instant_bridge_frames(
                layered,
                deck,
                source_frame,
                Arc::clone(&epoch),
                expected_epoch,
                hop_frames,
                cancelled,
                interrupted,
            ) {
                Ok(mut frames) => {
                    if !instant_started {
                        let dry = dry_bridge_frames(&layered.track, source_frame, frames.len());
                        let handoff = frames.len().min(INSTANT_HANDOFF_FRAMES);
                        for offset in 0..handoff {
                            frames[offset] = refinement_handoff_frame(
                                dry[offset],
                                frames[offset],
                                offset,
                                handoff,
                            );
                        }
                        instant_started = true;
                    }
                    frames
                }
                Err(error) => {
                    tracing::warn!(error = %error, deck, "instant STEM missed its hard deadline; switching to dry bridge");
                    // Keep the admission guard until this refinement bridge ends: the timed-out
                    // native call is not pre-emptible, so admitting the other Deck immediately
                    // would briefly recreate the proven dual-session overload.
                    instant_active = false;
                    dry_bridge_frames(&layered.track, source_frame, hop_frames)
                }
            }
        } else {
            dry_bridge_frames(&layered.track, source_frame, hop_frames)
        };
        let ready_after = if ready_before.is_some() {
            ready_before
        } else {
            ticket.try_wait()?
        };
        if let Some(refined) = ready_after {
            let handoff = bridge
                .len()
                .min(INSTANT_HANDOFF_FRAMES)
                .min(refined.frames().saturating_sub(pushed));
            let outcome = push_refinement_handoff(
                &bridge,
                &refined,
                pushed,
                handoff,
                chunk_start,
                resampler,
                writer,
                cancelled,
                interrupted,
            )?;
            return Ok(SeekBridgeResult {
                refined,
                pushed: pushed + handoff,
                outcome,
            });
        }
        let outcome = push_seek_bridge_frames(
            &bridge,
            pushed,
            chunk_start,
            resampler,
            writer,
            cancelled,
            interrupted,
        )?;
        pushed += bridge.len();
        if !matches!(outcome, StemPushOutcome::Complete) {
            let refined = await_stem_ticket(
                ticket,
                Arc::clone(&epoch),
                expected_epoch,
                cancelled,
                interrupted,
            )?;
            return Ok(SeekBridgeResult {
                refined,
                pushed,
                outcome,
            });
        }
        if !instant_active {
            // Dry PCM can be generated much faster than playback. Pace it to the source clock so
            // an eventual refinement replaces future samples instead of sitting behind seconds of
            // already-buffered fallback audio.
            let deadline =
                started + Duration::from_secs_f64(pushed as f64 / f64::from(STEM_SAMPLE_RATE));
            while std::time::Instant::now() < deadline {
                if cancelled() || interrupted() || epoch.load(Ordering::Acquire) != expected_epoch {
                    bail!("STEM hop retargeted");
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
    let refined = await_stem_ticket(ticket, epoch, expected_epoch, cancelled, interrupted)?;
    Ok(SeekBridgeResult {
        refined,
        pushed,
        outcome: StemPushOutcome::Complete,
    })
}

#[allow(clippy::too_many_arguments)]
fn instant_bridge_frames<F, I>(
    layered: &LayeredInstant,
    deck: usize,
    source_frame: u64,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    frames: usize,
    cancelled: F,
    interrupted: I,
) -> Result<Vec<StemFrame>>
where
    F: Fn() -> bool + Copy,
    I: Fn() -> bool + Copy,
{
    let started = std::time::Instant::now();
    let ticket = layered.pool.submit(
        deck,
        Arc::clone(&layered.track),
        source_frame,
        Arc::clone(&epoch),
        expected_epoch,
    )?;
    let chunk = loop {
        match ticket.try_wait()? {
            Some(chunk) => break chunk,
            None => {}
        }
        if cancelled() || interrupted() || epoch.load(Ordering::Acquire) != expected_epoch {
            bail!("HS-TasNet hop retargeted");
        }
        if started.elapsed() >= Duration::from_millis(INSTANT_HOP_BUDGET_MS) {
            bail!(
                "HS-TasNet hop exceeded the {} ms audio deadline",
                INSTANT_HOP_BUDGET_MS
            );
        }
        thread::sleep(Duration::from_millis(1));
    };
    Ok((0..frames.min(chunk.frames()))
        .map(|frame| instant_chunk_frame(&chunk, frame))
        .collect())
}

fn seek_bridge_prefill_frames(available: usize) -> usize {
    let target = (u64::from(STEM_SAMPLE_RATE) * LIVE_STEM_SEEK_PREFILL_MS / 1_000) as usize;
    available.min(target.max(INSTANT_HOP_FRAMES))
}

fn instant_chunk_frame(chunk: &InstantStemChunk, frame: usize) -> StemFrame {
    let stems = chunk.stems();
    StemFrame::separated([
        stems[0][frame][0],
        stems[0][frame][1],
        stems[1][frame][0],
        stems[1][frame][1],
        stems[2][frame][0],
        stems[2][frame][1],
        stems[3][frame][0],
        stems[3][frame][1],
    ])
}

fn dry_bridge_frames(track: &InstantTrack, source_frame: u64, frames: usize) -> Vec<StemFrame> {
    (0..frames)
        .map(|offset| {
            StemFrame::dry_bridge(
                track
                    .frame(source_frame.saturating_add(offset as u64))
                    .unwrap_or([0.0; 2]),
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn push_seek_bridge_frames<F, I>(
    bridge: &[StemFrame],
    source_offset: usize,
    chunk_start: f64,
    resampler: &mut LiveStemResampler,
    writer: &mut StreamWriter<StemFrame>,
    cancelled: F,
    interrupted: I,
) -> Result<StemPushOutcome>
where
    F: Fn() -> bool + Copy,
    I: Fn() -> bool + Copy,
{
    for (offset, frame) in bridge.iter().copied().enumerate() {
        if !resampler.push(
            frame,
            stem_frame_time(chunk_start, source_offset + offset),
            writer,
            cancelled,
            interrupted,
        )? {
            return Ok(StemPushOutcome::Interrupted);
        }
    }
    Ok(StemPushOutcome::Complete)
}

#[allow(clippy::too_many_arguments)]
fn push_refinement_handoff<F, I>(
    bridge: &[StemFrame],
    refined: &StemChunk,
    source_offset: usize,
    frames: usize,
    chunk_start: f64,
    resampler: &mut LiveStemResampler,
    writer: &mut StreamWriter<StemFrame>,
    cancelled: F,
    interrupted: I,
) -> Result<StemPushOutcome>
where
    F: Fn() -> bool + Copy,
    I: Fn() -> bool + Copy,
{
    for offset in 0..frames {
        let from = bridge[offset];
        let to = chunk_frame(refined, source_offset + offset);
        let frame = refinement_handoff_frame(from, to, offset, frames);
        if !resampler.push(
            frame,
            stem_frame_time(chunk_start, source_offset + offset),
            writer,
            cancelled,
            interrupted,
        )? {
            return Ok(StemPushOutcome::Interrupted);
        }
    }
    Ok(StemPushOutcome::Complete)
}

fn refinement_handoff_frame(
    from: StemFrame,
    to: StemFrame,
    offset: usize,
    frames: usize,
) -> StemFrame {
    let linear = if frames <= 1 {
        1.0
    } else {
        offset.min(frames - 1) as f32 / (frames - 1) as f32
    };
    let blend = linear * linear * (3.0 - 2.0 * linear);
    from.lerp(to, blend)
}

fn wait_for_pipeline_seek_ack<F, I>(
    seek: Option<&StreamSeekControl>,
    generation: u64,
    cancelled: F,
    interrupted: I,
) -> Result<()>
where
    F: Fn() -> bool + Copy,
    I: Fn() -> bool + Copy,
{
    let Some(seek) = seek else {
        return Ok(());
    };
    while !seek.pipeline_acknowledged(generation) {
        if cancelled() || interrupted() {
            bail!("STEM hop retargeted");
        }
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

fn await_stem_ticket<F, R>(
    ticket: &kdj_stems::StemInferenceTicket,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    cancelled: F,
    retargeted: R,
) -> Result<Arc<StemChunk>>
where
    F: Fn() -> bool + Copy,
    R: Fn() -> bool + Copy,
{
    loop {
        match ticket.try_wait() {
            Ok(Some(chunk)) => return Ok(chunk),
            Ok(None) => {}
            Err(_)
                if !cancelled()
                    && (retargeted() || epoch.load(Ordering::Acquire) != expected_epoch) =>
            {
                bail!("STEM hop retargeted");
            }
            Err(error) => return Err(error),
        }
        if cancelled() {
            bail!("STEM live stream preparation cancelled");
        }
        if retargeted() || epoch.load(Ordering::Acquire) != expected_epoch {
            bail!("STEM hop retargeted");
        }
        thread::sleep(Duration::from_millis(1));
    }
}

struct LiveStemResampler {
    previous: Option<StemFrame>,
    previous_time: f64,
    source_index: u64,
    next_output_position: f64,
    step: f64,
    media_origin: f64,
}

impl LiveStemResampler {
    fn new(output_sample_rate: u32, origin: f64) -> Self {
        Self {
            previous: None,
            previous_time: origin,
            source_index: 0,
            next_output_position: 0.0,
            step: f64::from(STEM_SAMPLE_RATE) / f64::from(output_sample_rate),
            media_origin: origin,
        }
    }

    fn reset(&mut self, origin: f64) {
        self.previous = None;
        self.previous_time = origin;
        self.source_index = 0;
        self.next_output_position = 0.0;
        self.media_origin = origin;
    }

    fn push<F, I>(
        &mut self,
        current: StemFrame,
        source_time: f64,
        writer: &mut StreamWriter<StemFrame>,
        cancelled: F,
        interrupted: I,
    ) -> Result<bool>
    where
        F: Fn() -> bool + Copy,
        I: Fn() -> bool + Copy,
    {
        if let Some(previous) = self.previous {
            while self.next_output_position <= self.source_index as f64 {
                let fraction = (self.next_output_position - (self.source_index - 1) as f64)
                    .clamp(0.0, 1.0) as f32;
                let media_time = if self.previous_time.is_finite() && source_time.is_finite() {
                    self.previous_time + (source_time - self.previous_time) * f64::from(fraction)
                } else if source_time.is_finite() {
                    source_time
                } else {
                    self.media_origin + self.next_output_position / f64::from(STEM_SAMPLE_RATE)
                };
                if !writer.push_with_media_timing_interruptible(
                    previous.lerp(current, fraction),
                    1.0,
                    0,
                    media_time,
                    cancelled,
                    interrupted,
                )? {
                    return Ok(false);
                }
                self.next_output_position += self.step;
            }
        }
        self.previous = Some(current);
        if source_time.is_finite() {
            self.previous_time = source_time;
        }
        self.source_index += 1;
        Ok(true)
    }
}

fn chunk_frame(chunk: &StemChunk, frame: usize) -> StemFrame {
    let stems = chunk.stems();
    StemFrame::separated_with_gain(
        [
            stems[0][frame][0],
            stems[0][frame][1],
            stems[1][frame][0],
            stems[1][frame][1],
            stems[2][frame][0],
            stems[2][frame][1],
            stems[3][frame][0],
            stems[3][frame][1],
        ],
        chunk.reconstruction_gain(),
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StemPushOutcome {
    Complete,
    Interrupted,
}

fn stem_frame_time(chunk_origin: f64, frame_index: usize) -> f64 {
    chunk_origin + frame_index as f64 / f64::from(STEM_SAMPLE_RATE)
}

fn push_stem_range<F, I>(
    chunk: &StemChunk,
    start: usize,
    frames: usize,
    chunk_origin: f64,
    resampler: &mut LiveStemResampler,
    writer: &mut StreamWriter<StemFrame>,
    cancelled: F,
    interrupted: I,
) -> Result<(usize, StemPushOutcome)>
where
    F: Fn() -> bool + Copy,
    I: Fn() -> bool + Copy,
{
    for offset in 0..frames {
        let index = start + offset;
        if !resampler.push(
            chunk_frame(chunk, index),
            stem_frame_time(chunk_origin, index),
            writer,
            cancelled,
            interrupted,
        )? {
            return Ok((offset, StemPushOutcome::Interrupted));
        }
    }
    Ok((frames, StemPushOutcome::Complete))
}

fn push_stem_overlap_range<F, I>(
    previous: &StemChunk,
    current: &StemChunk,
    start: usize,
    frames: usize,
    chunk_origin: f64,
    resampler: &mut LiveStemResampler,
    writer: &mut StreamWriter<StemFrame>,
    cancelled: F,
    interrupted: I,
) -> Result<(usize, StemPushOutcome)>
where
    F: Fn() -> bool + Copy,
    I: Fn() -> bool + Copy,
{
    for offset in 0..frames {
        let index = start + offset;
        let frame = if index < stem_segment_handoff_frames() {
            guarded_stem_handoff_frame(
                chunk_frame(previous, live_stem_output_stride_frames() + index),
                chunk_frame(current, index),
                index,
            )
        } else {
            chunk_frame(current, index)
        };
        if !resampler.push(
            frame,
            stem_frame_time(chunk_origin, index),
            writer,
            cancelled,
            interrupted,
        )? {
            return Ok((offset, StemPushOutcome::Interrupted));
        }
    }
    Ok((frames, StemPushOutcome::Complete))
}

/// Stitch retained cores only after their surrounding context has been discarded. This is not a
/// model-window-edge blend: both frames are at least one full guard band from that edge.
fn guarded_stem_handoff_frame(
    previous: StemFrame,
    current: StemFrame,
    overlap_index: usize,
) -> StemFrame {
    let handoff_frames = stem_segment_handoff_frames();
    if handoff_frames <= 1 || overlap_index >= handoff_frames {
        return current;
    }
    let linear = overlap_index as f32 / (handoff_frames - 1) as f32;
    // Adjacent classical Redress estimates are phase-aligned because both see the same real PCM context. A
    // smooth linear partition keeps identical signals at unity; the old equal-power blend raised
    // the complete mix by up to +3 dB through every handoff.
    let current_gain = linear * linear * (3.0 - 2.0 * linear);
    let previous_gain = 1.0 - current_gain;
    let mut lanes = [0.0; STEM_LANES * 2];
    for (index, lane) in lanes.iter_mut().enumerate() {
        *lane = previous.lanes[index] * previous_gain + current.lanes[index] * current_gain;
    }
    StemFrame::separated(lanes)
}

fn stem_segment_handoff_frames() -> usize {
    let geometry = stem_tile_geometry();
    geometry.handoff.min(geometry.core.max(1))
}

/// New context-safe material per model call. The short handoff uses the previous window's
/// right-hand context rather than shrinking this stride.
fn live_stem_output_stride_frames() -> usize {
    stem_tile_geometry().core.max(1)
}

fn stem_seek_pending(seek: Option<&StreamSeekControl>, seen: u64) -> bool {
    seek.is_some_and(|control| control.generation() != seen)
}

/// Streams a four-stem cache with every lane kept separate. The realtime renderer applies
/// per-lane gains (mute/volume), so a STEM toggle or slider drag never restarts this worker.
pub fn decode_stem_cache_streaming<F>(
    path: &Path,
    position: f64,
    output_sample_rate: u32,
    mut writer: StreamWriter<StemFrame>,
    cancelled: F,
) -> Result<StreamMetadata>
where
    F: Fn() -> bool + Copy,
{
    if output_sample_rate == 0 {
        bail!("output sample rate must be non-zero");
    }
    let header =
        read_cache_header(path).with_context(|| format!("read STEM cache: {}", path.display()))?;
    let source_sample_rate = header.sample_rate;
    if source_sample_rate == 0 || header.frames == 0 {
        bail!("STEM cache is empty");
    }
    let duration = header.frames as f64 / f64::from(source_sample_rate);
    let clamped_position = position
        .max(0.0)
        .min((duration - SEEK_END_MARGIN_SECONDS).max(0.0));
    let start_frame = (clamped_position * f64::from(source_sample_rate)).round() as u64;
    let mut file =
        File::open(path).with_context(|| format!("open STEM cache: {}", path.display()))?;
    seek_cache_frame(&mut file, start_frame)?;

    let mut remaining = header.frames.saturating_sub(start_frame);
    let mut bytes = vec![0u8; 4096 * BYTES_PER_FRAME as usize];
    let mut previous: Option<StemFrame> = None;
    let mut source_index = 0u64;
    let mut next_output_position = 0.0f64;
    let step = f64::from(source_sample_rate) / f64::from(output_sample_rate);
    while remaining > 0 {
        if cancelled() {
            bail!("STEM stream preparation cancelled");
        }
        let frames = remaining.min(4096) as usize;
        let count = frames * BYTES_PER_FRAME as usize;
        file.read_exact(&mut bytes[..count])?;
        for frame in bytes[..count].chunks_exact(BYTES_PER_FRAME as usize) {
            let current = stem_frame_from_cache(frame);
            if let Some(before) = previous {
                while next_output_position <= source_index as f64 {
                    let fraction =
                        (next_output_position - (source_index - 1) as f64).clamp(0.0, 1.0) as f32;
                    writer.push(before.lerp(current, fraction), cancelled)?;
                    next_output_position += step;
                }
            }
            previous = Some(current);
            source_index += 1;
        }
        remaining -= frames as u64;
    }
    if writer.counters.produced.load(Ordering::Acquire) == 0 {
        bail!("STEM cache produced no audio");
    }
    writer.finish();
    Ok(StreamMetadata {
        duration: Some(duration),
        source_sample_rate,
        output_sample_rate,
    })
}

fn stem_frame_from_cache(frame: &[u8]) -> StemFrame {
    let mut out = [0.0f32; STEM_LANES * 2];
    for stem in StemKind::ALL {
        let base = stem.index() * 4;
        out[stem.index() * 2] =
            f32::from(i16::from_le_bytes([frame[base], frame[base + 1]])) / 32768.0;
        out[stem.index() * 2 + 1] =
            f32::from(i16::from_le_bytes([frame[base + 2], frame[base + 3]])) / 32768.0;
    }
    StemFrame::separated(out)
}

fn finite(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn discontinuity_discards_pre_reset_output_before_the_callback_sees_it() {
        let (source, mut writer) = StreamSource::<[f32; 2]>::bounded(16);
        writer.push([0.25, 0.25], || false).unwrap();
        writer.push([0.5, 0.5], || false).unwrap();
        writer.begin_discontinuity();
        writer.push([0.75, 0.75], || false).unwrap();

        assert_eq!(source.pop_callback(), Some([0.75, 0.75]));
        assert_eq!(source.pop_callback(), None);
        assert_eq!(source.consumed_frames(), 3);
    }

    #[test]
    fn seek_control_latest_position_wins_for_each_observer() {
        let seek = StreamSeekControl::new();
        let mut decode_seen = 0;
        let mut stretch_seen = 0;
        assert!(seek.observe(&mut decode_seen).is_none());
        seek.request(12.5);
        seek.request(4.0);
        assert!((seek.observe(&mut decode_seen).unwrap() - 4.0).abs() < 1e-9);
        assert!(!seek.pipeline_acknowledged(decode_seen));
        assert!((seek.observe(&mut stretch_seen).unwrap() - 4.0).abs() < 1e-9);
        seek.acknowledge_pipeline(stretch_seen);
        assert!(seek.pipeline_acknowledged(decode_seen));
        assert!(seek.observe(&mut decode_seen).is_none());
        seek.publish_clock(48.0);
        assert!((seek.clock().unwrap() - 48.0).abs() < 1e-9);
        assert!(seek.observe(&mut decode_seen).is_none());
    }

    #[test]
    fn live_stem_look_ahead_covers_two_successor_tiles() {
        let stride = live_stem_output_stride_frames() as f64 / f64::from(STEM_SAMPLE_RATE);
        assert_eq!(
            live_stem_look_ahead_starts(12.0, stride, 180.0),
            vec![12.0 + stride, 12.0 + stride * 2.0]
        );
        assert_eq!(
            live_stem_look_ahead_starts(12.0, stride, 12.0 + stride * 1.5),
            vec![12.0 + stride]
        );
        assert!(live_stem_look_ahead_starts(12.0, stride, 12.0 + stride / 2.0).is_empty());
    }

    #[test]
    fn live_stem_skips_tiles_that_are_already_behind_the_playhead() {
        let stride = live_stem_output_stride_frames() as f64 / f64::from(STEM_SAMPLE_RATE);
        assert!(live_stem_skip_behind_start(0.0, stride / 2.0, stride, 180.0).is_none());
        assert!(live_stem_skip_behind_start(0.0, 0.5, stride, 180.0).is_some());
        let skipped = live_stem_skip_behind_start(0.0, 50.0, stride, 180.0)
            .expect("a 50s playhead must abandon the intro tile");
        assert!(skipped >= 50.0 - stride);
        assert!(skipped <= 50.0);
        assert!(live_stem_skip_behind_start(skipped, 50.0, stride, 180.0).is_none());
    }

    #[test]
    fn rubber_band_pipeline_drains_a_finite_stereo_decoder() {
        let sample_rate = 48_000;
        let input_frames = sample_rate as usize;
        let (output, writer) = StreamSource::<[f32; 2]>::bounded(sample_rate as usize * 2);
        let cancelled: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| false);
        let metadata = run_pitch_preserving_pipeline(
            TempoControl::new(1.5),
            sample_rate,
            8_192,
            writer,
            move |mut raw_writer, cancelled| {
                for frame in 0..input_frames {
                    let sample =
                        (std::f32::consts::TAU * 220.0 * frame as f32 / sample_rate as f32).sin();
                    raw_writer.push([sample, sample], &*cancelled)?;
                }
                raw_writer.finish();
                Ok(StreamMetadata {
                    duration: Some(1.0),
                    source_sample_rate: sample_rate,
                    output_sample_rate: sample_rate,
                })
            },
            cancelled,
            None,
            None,
        )
        .unwrap();

        assert_eq!(metadata.output_sample_rate, sample_rate);
        assert!(output.ended());
        let mut output_frames = 0usize;
        while output.pop_consumer().is_some() {
            output_frames += 1;
        }
        assert!((output_frames as f32 - input_frames as f32 / 1.5).abs() < 1_000.0);
        assert!(output.drained());
    }

    #[test]
    fn rubber_band_pipeline_cancellation_ends_the_callback_ring() {
        let sample_rate = 48_000;
        let (output, writer) = StreamSource::<[f32; 2]>::bounded(8_192);
        let cancelled: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| true);
        let result = run_pitch_preserving_pipeline(
            TempoControl::new(1.0),
            sample_rate,
            8_192,
            writer,
            move |raw_writer, _| {
                raw_writer.finish();
                Ok(StreamMetadata {
                    duration: Some(0.0),
                    source_sample_rate: sample_rate,
                    output_sample_rate: sample_rate,
                })
            },
            cancelled,
            None,
            None,
        );

        assert!(result.is_err());
        assert!(output.ended());
    }

    #[test]
    fn look_ahead_tile_is_consumed_only_at_its_exact_successor_start() {
        let stride = live_stem_output_stride_frames() as f64 / f64::from(STEM_SAMPLE_RATE);
        let first = LiveStemLookAhead {
            start: 12.0 + stride,
            result: Arc::new(Mutex::new(None)),
        };
        let second = LiveStemLookAhead {
            start: 12.0 + stride * 2.0,
            result: Arc::new(Mutex::new(None)),
        };
        let mut tiles = vec![first, second];
        assert!(take_look_ahead_for(&mut tiles, 12.0).is_none());
        let taken = take_look_ahead_for(&mut tiles, 12.0 + stride).expect("first successor");
        assert!(taken.is_for(12.0 + stride));
        assert_eq!(tiles.len(), 1);
        assert!(tiles[0].is_for(12.0 + stride * 2.0));
    }

    #[test]
    fn loop_window_publishes_one_atomic_in_out_generation() {
        let window = LoopWindow::new();
        let initial = window.generation();
        window.set(8.0, 4.0);
        assert_eq!(
            window.snapshot(),
            Some(LoopWindowSnapshot {
                start: 8.0,
                length: 4.0,
            })
        );
        assert!(window.generation() > initial);
        let armed = window.generation();
        window.clear();
        assert!(window.snapshot().is_none());
        assert!(window.generation() > armed);
    }

    fn timed_value(value: usize, sample_rate: u32) -> TimedPcm<[f32; 2]> {
        TimedPcm {
            frame: [value as f32, value as f32],
            media_time: value as f64 / f64::from(sample_rate),
        }
    }

    fn raw_ramp(
        frames: usize,
        sample_rate: u32,
    ) -> (Arc<StreamSource<[f32; 2]>>, StreamWriter<[f32; 2]>) {
        let (source, mut writer) = StreamSource::bounded(frames + 2);
        for value in 0..frames {
            let packet = timed_value(value, sample_rate);
            writer
                .push_at(packet.frame, packet.media_time, || false)
                .unwrap();
        }
        (source, writer)
    }

    #[test]
    fn pcm_loop_reader_captures_first_pass_then_replays_exact_half_open_region() {
        let sample_rate = 10;
        let (raw, writer) = raw_ramp(40, sample_rate);
        let window = Arc::new(LoopWindow::new());
        let mut reader = PcmLoopReader::new(sample_rate);
        reader.sync(Some(window.generation()), window.snapshot());

        let linear: Vec<usize> = (0..10)
            .map(|_| reader.next(&raw).unwrap().frame[0] as usize)
            .collect();
        assert_eq!(linear, (0..10).collect::<Vec<_>>());

        window.set(1.0, 0.4);
        reader.sync(Some(window.generation()), window.snapshot());
        let played: Vec<usize> = (0..12)
            .map(|_| reader.next(&raw).unwrap().frame[0] as usize)
            .collect();
        assert_eq!(played, vec![10, 11, 12, 13, 10, 11, 12, 13, 10, 11, 12, 13]);
        drop(writer);
    }

    #[test]
    fn pcm_loop_reader_uses_history_when_worker_is_ahead_of_the_audible_needle() {
        let sample_rate = 10;
        let (raw, writer) = raw_ramp(40, sample_rate);
        let window = Arc::new(LoopWindow::new());
        let mut reader = PcmLoopReader::new(sample_rate);
        reader.sync(Some(window.generation()), window.snapshot());
        for expected in 0..15 {
            assert_eq!(reader.next(&raw).unwrap().frame[0] as usize, expected);
        }

        // The worker is at frame 15 while the callback command captures frame 10. History must
        // supply 10..13; consuming unrelated frame 15 as loop-in would be a whole-song jump.
        window.set(1.0, 0.4);
        reader.sync(Some(window.generation()), window.snapshot());
        let looped: Vec<usize> = (0..8)
            .map(|_| reader.next(&raw).unwrap().frame[0] as usize)
            .collect();
        assert_eq!(looped, vec![10, 11, 12, 13, 10, 11, 12, 13]);
        drop(writer);
    }

    #[test]
    fn pcm_loop_reader_exits_at_out_and_resumes_untouched_linear_pcm() {
        let sample_rate = 10;
        let (raw, writer) = raw_ramp(40, sample_rate);
        let window = Arc::new(LoopWindow::new());
        let mut reader = PcmLoopReader::new(sample_rate);
        reader.sync(Some(window.generation()), window.snapshot());
        for _ in 0..10 {
            reader.next(&raw).unwrap();
        }
        window.set(1.0, 0.4);
        reader.sync(Some(window.generation()), window.snapshot());
        for expected in [10.0, 11.0, 12.0, 13.0, 10.0, 11.0] {
            assert_eq!(reader.next(&raw).unwrap().frame[0], expected);
        }

        window.clear();
        reader.sync(Some(window.generation()), window.snapshot());
        let exit: Vec<usize> = (0..5)
            .map(|_| reader.next(&raw).unwrap().frame[0] as usize)
            .collect();
        assert_eq!(exit, vec![12, 13, 14, 15, 16]);
        drop(writer);
    }

    #[test]
    fn pcm_loop_reader_extends_only_the_out_point() {
        let sample_rate = 10;
        let (raw, writer) = raw_ramp(40, sample_rate);
        let window = Arc::new(LoopWindow::new());
        let mut reader = PcmLoopReader::new(sample_rate);
        reader.sync(Some(window.generation()), window.snapshot());
        for _ in 0..10 {
            reader.next(&raw).unwrap();
        }
        window.set(1.0, 0.4);
        reader.sync(Some(window.generation()), window.snapshot());
        for expected in [10.0, 11.0, 12.0, 13.0] {
            assert_eq!(reader.next(&raw).unwrap().frame[0], expected);
        }

        window.set(1.0, 0.6);
        reader.sync(Some(window.generation()), window.snapshot());
        let extended: Vec<usize> = (0..12)
            .map(|_| reader.next(&raw).unwrap().frame[0] as usize)
            .collect();
        assert_eq!(
            extended,
            vec![14, 15, 10, 11, 12, 13, 14, 15, 10, 11, 12, 13]
        );
        drop(writer);
    }

    #[test]
    fn pitch_preserving_pipeline_loops_pcm_without_seek_or_discontinuity() {
        let sample_rate = 8_000;
        let window = Arc::new(LoopWindow::new());
        window.set(1.0, 0.05);
        let seek = StreamSeekControl::new();
        let (output, output_writer) = StreamSource::<[f32; 2]>::bounded(32);
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new({
            let stop = Arc::clone(&stop);
            move || stop.load(Ordering::Acquire)
        });
        let worker_window = Arc::clone(&window);
        let worker_seek = seek.clone();
        let handle = thread::spawn(move || {
            run_pitch_preserving_pipeline(
                TempoControl::new(1.25),
                sample_rate,
                256,
                output_writer,
                move |mut writer, cancelled| {
                    for frame in 7_840..10_400 {
                        writer.push_at(
                            [frame as f32, frame as f32],
                            frame as f64 / f64::from(sample_rate),
                            &*cancelled,
                        )?;
                    }
                    writer.finish();
                    Ok(StreamMetadata {
                        duration: Some(1.3),
                        source_sample_rate: sample_rate,
                        output_sample_rate: sample_rate,
                    })
                },
                cancelled,
                Some(worker_window),
                Some(worker_seek),
            )
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut times = Vec::new();
        let mut cleared = false;
        while std::time::Instant::now() < deadline {
            if let Some((_frame, _advance, _revision, time)) = output.pop_callback_timed() {
                if !cleared
                    && times
                        .last()
                        .is_some_and(|previous| time + 0.005 < *previous)
                {
                    window.clear();
                    cleared = true;
                }
                times.push(time);
                continue;
            }
            if output.drained() {
                break;
            }
            thread::yield_now();
        }
        if !output.drained() {
            stop.store(true, Ordering::Release);
            while output.pop_callback_timed().is_some() {}
        }
        handle.join().expect("loop pipeline thread").unwrap();

        assert!(cleared, "the cached region must wrap at least once");
        assert!(
            times.iter().any(|time| *time >= 1.02),
            "LOOP off must resume untouched linear PCM after out"
        );
        assert_eq!(
            seek.generation(),
            0,
            "natural wraps must not request decoder seek"
        );
        assert_eq!(
            output.counters.generation.load(Ordering::Acquire),
            0,
            "natural wraps must not invalidate the callback ring"
        );
    }

    #[test]
    fn segment_handoff_joins_only_retained_cores() {
        let previous = StemFrame::separated([0.25; STEM_LANES * 2]);
        let current = StemFrame::separated([0.75; STEM_LANES * 2]);
        let handoff_frames = stem_segment_handoff_frames();

        let early = guarded_stem_handoff_frame(previous, current, 0);
        let middle = guarded_stem_handoff_frame(previous, current, handoff_frames / 2);
        let late = guarded_stem_handoff_frame(previous, current, handoff_frames);

        assert_eq!(
            early.lanes[0], 0.25,
            "the outgoing retained core must start at full level"
        );
        let linear = (handoff_frames / 2) as f32 / (handoff_frames - 1) as f32;
        let current_gain = linear * linear * (3.0 - 2.0 * linear);
        let expected_middle = 0.25 * (1.0 - current_gain) + 0.75 * current_gain;
        assert!(
            (middle.lanes[0] - expected_middle).abs() < 0.001,
            "the short retained-core handoff must preserve a unity linear partition"
        );
        assert_eq!(
            late.lanes[0], 0.75,
            "the incoming retained core must take over after the handoff"
        );
        assert_eq!(handoff_frames, SEGMENT_HANDOFF_SAMPLES);
        assert!(handoff_frames < SEGMENT_CORE_SAMPLES);
    }

    #[test]
    fn seek_refinement_handoff_has_exact_dry_and_stem_endpoints() {
        let dry = StemFrame::dry_bridge([0.4, -0.4]);
        let refined = StemFrame::separated([0.1; STEM_LANES * 2]);
        let first = refinement_handoff_frame(dry, refined, 0, INSTANT_HANDOFF_FRAMES);
        let last = refinement_handoff_frame(
            dry,
            refined,
            INSTANT_HANDOFF_FRAMES - 1,
            INSTANT_HANDOFF_FRAMES,
        );

        assert_eq!(first.blend, 1.0);
        assert_eq!(first.original, [0.4, -0.4]);
        assert_eq!(last.blend, 1.0);
        assert_eq!(last.lanes, refined.lanes);
    }

    #[test]
    fn seek_bridge_uses_the_complete_short_classical_core() {
        let target = STEM_SAMPLE_RATE as usize * LIVE_STEM_SEEK_PREFILL_MS as usize / 1_000;
        let expected = SEGMENT_CORE_SAMPLES.min(target);
        assert_eq!(seek_bridge_prefill_frames(SEGMENT_CORE_SAMPLES), expected);
        assert!(expected >= INSTANT_HOP_FRAMES * 8);
        assert!(expected as f64 / f64::from(STEM_SAMPLE_RATE) < 0.1);
        assert_eq!(seek_bridge_prefill_frames(123), 123);
    }

    #[test]
    fn cached_tile_keeps_only_the_context_safe_core_and_handoff_tail() {
        let stride = live_stem_output_stride_frames();
        let handoff = stem_segment_handoff_frames();
        let cached_frames = stride + handoff;

        assert_eq!(stride, SEGMENT_CORE_SAMPLES);
        assert_eq!(
            cached_frames,
            SEGMENT_CORE_SAMPLES + SEGMENT_HANDOFF_SAMPLES
        );
        assert!(SEGMENT_CONTEXT_SAMPLES + cached_frames <= SEGMENT_SAMPLES);
        assert!(SEGMENT_CORE_SAMPLES > handoff);
    }

    #[test]
    fn first_classical_core_fits_in_the_output_ring() {
        let output_rate = 48_000u32;
        let tile_frames = live_stem_output_stride_frames();
        assert_eq!(tile_frames, SEGMENT_CORE_SAMPLES);
        let tile_seconds = tile_frames as f64 / f64::from(STEM_SAMPLE_RATE);
        assert!(
            tile_seconds < DEFAULT_STREAM_BUFFER_SECONDS as f64,
            "retained tile must fit the bounded ring, got {tile_seconds} s"
        );
        let rendered_output_frames = (tile_frames as f64 * f64::from(output_rate)
            / f64::from(STEM_SAMPLE_RATE))
        .ceil() as u64;
        assert!(
            rendered_output_frames < u64::from(output_rate) * DEFAULT_STREAM_BUFFER_SECONDS as u64
        );
    }

    fn write_test_cache(path: &Path) {
        let mut file = File::create(path).unwrap();
        file.write_all(b"KDJSTEM1").unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&[4, 0]).unwrap();
        file.write_all(&44_100u32.to_le_bytes()).unwrap();
        file.write_all(&8u64.to_le_bytes()).unwrap();
        file.write_all(&42i64.to_le_bytes()).unwrap();
        file.write_all(&[7u8; 32]).unwrap();
        for _ in 0..8 {
            for value in [1_000i16, 1_000, 2_000, 2_000, 3_000, 3_000, 4_000, 4_000] {
                file.write_all(&value.to_le_bytes()).unwrap();
            }
        }
    }

    #[test]
    fn stem_cache_streaming_keeps_all_lanes_separate() {
        let path =
            std::env::temp_dir().join(format!("kdj-stem-stream-{}.kdstem", std::process::id()));
        write_test_cache(&path);
        let (source, writer) = StreamSource::bounded(32);
        decode_stem_cache_streaming(&path, 0.0, 44_100, writer, || false).unwrap();
        let first = source.pop_callback().unwrap();
        // 缓存帧按 StemKind::index 排列：drums=1000, bass=2000, other=3000, vocals=4000。
        let expected = [
            1_000.0, 1_000.0, 2_000.0, 2_000.0, 3_000.0, 3_000.0, 4_000.0, 4_000.0,
        ];
        for index in 0..STEM_LANES * 2 {
            assert!((first.lanes[index] - expected[index] / 32768.0).abs() < 1e-6);
        }
        assert_eq!(first.blend, 1.0);
        assert_eq!(source.produced_frames(), 8);
        let _ = std::fs::remove_file(path);
    }
}
