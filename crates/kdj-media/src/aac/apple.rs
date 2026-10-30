//! AudioToolbox's AAC encoder through `AudioConverter`.

use super::{AacEncoder, FrameQueue, FRAME};
use anyhow::{bail, Result};
use std::ffi::c_void;

type OSStatus = i32;
type AudioConverterRef = *mut c_void;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct AudioStreamBasicDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
struct AudioBuffer {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    number_buffers: u32,
    buffers: [AudioBuffer; 1],
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct AudioStreamPacketDescription {
    start_offset: i64,
    variable_frames_in_packet: u32,
    data_byte_size: u32,
}

#[repr(C)]
#[derive(Default)]
struct AudioConverterPrimeInfo {
    leading_frames: u32,
    trailing_frames: u32,
}

type InputProc = extern "C" fn(AudioConverterRef, *mut u32, *mut AudioBufferList, *mut *mut AudioStreamPacketDescription, *mut c_void) -> OSStatus;

#[link(name = "AudioToolbox", kind = "framework")]
extern "C" {
    fn AudioConverterNew(source: *const AudioStreamBasicDescription, destination: *const AudioStreamBasicDescription, converter: *mut AudioConverterRef) -> OSStatus;
    fn AudioConverterDispose(converter: AudioConverterRef) -> OSStatus;
    fn AudioConverterSetProperty(converter: AudioConverterRef, id: u32, size: u32, data: *const c_void) -> OSStatus;
    fn AudioConverterGetProperty(converter: AudioConverterRef, id: u32, size: *mut u32, data: *mut c_void) -> OSStatus;
    fn AudioConverterFillComplexBuffer(converter: AudioConverterRef, input: InputProc, user: *mut c_void, packets: *mut u32, output: *mut AudioBufferList, descriptions: *mut AudioStreamPacketDescription) -> OSStatus;
}

const fn fourcc(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}
const LINEAR_PCM: u32 = fourcc(b"lpcm");
const MPEG4_AAC: u32 = fourcc(b"aac ");
const FLOAT_PACKED: u32 = 1 | 8;
const ENCODE_BIT_RATE: u32 = fourcc(b"brat");
const CODEC_QUALITY: u32 = fourcc(b"cdqu");
const PRIME_INFO: u32 = fourcc(b"prim");
const MAXIMUM_OUTPUT_PACKET_SIZE: u32 = fourcc(b"xops");
const QUALITY_MAX: u32 = 0x7f;
/// Returned by the input callback when it has no more PCM yet (not end of stream).
const NEED_INPUT: OSStatus = 1;

/// The PCM handed to the converter. It must stay alive until the next callback.
struct Feed {
    queue: FrameQueue,
    hold: Vec<f32>,
    channels: u32,
    eof: bool,
}

extern "C" fn supply(_: AudioConverterRef, packets: *mut u32, list: *mut AudioBufferList, _: *mut *mut AudioStreamPacketDescription, user: *mut c_void) -> OSStatus {
    // SAFETY: `user` is the `Feed` owned by the encoder for the duration of the call.
    let feed = unsafe { &mut *(user as *mut Feed) };
    let wanted = unsafe { *packets } as usize;
    let channels = feed.channels as usize;
    let take = wanted.max(1).min(FRAME * 4) * channels;
    feed.hold = match feed.queue.take(take) {
        Some(pcm) => pcm,
        None if feed.eof => feed.queue.rest(),
        None => {
            // Partial input only goes in at the end: the converter must not run dry mid-stream.
            unsafe { *packets = 0 };
            return NEED_INPUT;
        }
    };
    let frames = feed.hold.len() / channels;
    unsafe {
        *packets = frames as u32;
        (*list).number_buffers = 1;
        (*list).buffers[0] = AudioBuffer {
            number_channels: feed.channels,
            data_byte_size: (feed.hold.len() * 4) as u32,
            data: if frames == 0 { std::ptr::null_mut() } else { feed.hold.as_mut_ptr() as *mut c_void },
        };
    }
    0
}

pub struct Encoder {
    converter: AudioConverterRef,
    feed: Box<Feed>,
    rate: u32,
    channels: u32,
    priming: u32,
    max_packet: u32,
    done: bool,
}

// The converter is used from one thread at a time; AudioToolbox converters are not tied to a thread.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(rate: u32, channels: u32, bitrate: u32) -> Result<Self> {
        let source = AudioStreamBasicDescription {
            sample_rate: rate as f64,
            format_id: LINEAR_PCM,
            format_flags: FLOAT_PACKED,
            bytes_per_packet: 4 * channels,
            frames_per_packet: 1,
            bytes_per_frame: 4 * channels,
            channels_per_frame: channels,
            bits_per_channel: 32,
            reserved: 0,
        };
        let destination = AudioStreamBasicDescription { sample_rate: rate as f64, format_id: MPEG4_AAC, frames_per_packet: FRAME as u32, channels_per_frame: channels, ..Default::default() };
        let mut converter: AudioConverterRef = std::ptr::null_mut();
        let status = unsafe { AudioConverterNew(&source, &destination, &mut converter) };
        if status != 0 || converter.is_null() {
            bail!("AudioToolbox 无法创建 AAC 编码器（{status}）");
        }
        let mut encoder = Self { converter, feed: Box::new(Feed { queue: FrameQueue::default(), hold: Vec::new(), channels, eof: false }), rate, channels, priming: 0, max_packet: 0, done: false };
        let quality = QUALITY_MAX;
        unsafe { AudioConverterSetProperty(converter, CODEC_QUALITY, 4, &quality as *const u32 as *const c_void) };
        let status = unsafe { AudioConverterSetProperty(converter, ENCODE_BIT_RATE, 4, &bitrate as *const u32 as *const c_void) };
        if status != 0 {
            bail!("AudioToolbox 不接受 {bitrate} bps 的 AAC 码率（{status}）");
        }
        let mut prime = AudioConverterPrimeInfo::default();
        let mut size = std::mem::size_of::<AudioConverterPrimeInfo>() as u32;
        if unsafe { AudioConverterGetProperty(converter, PRIME_INFO, &mut size, &mut prime as *mut _ as *mut c_void) } == 0 {
            encoder.priming = prime.leading_frames;
        }
        let mut size = 4u32;
        unsafe { AudioConverterGetProperty(converter, MAXIMUM_OUTPUT_PACKET_SIZE, &mut size, &mut encoder.max_packet as *mut u32 as *mut c_void) };
        if encoder.max_packet == 0 {
            encoder.max_packet = 6144 * channels;
        }
        Ok(encoder)
    }

    fn drain(&mut self) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let mut buffer = vec![0u8; self.max_packet as usize * 16];
        let mut descriptions = [AudioStreamPacketDescription::default(); 16];
        loop {
            let mut packets = 16u32;
            let mut list = AudioBufferList { number_buffers: 1, buffers: [AudioBuffer { number_channels: self.channels, data_byte_size: buffer.len() as u32, data: buffer.as_mut_ptr() as *mut c_void }] };
            let feed: *mut Feed = &mut *self.feed;
            let status = unsafe { AudioConverterFillComplexBuffer(self.converter, supply, feed as *mut c_void, &mut packets, &mut list, descriptions.as_mut_ptr()) };
            for d in &descriptions[..packets as usize] {
                let start = d.start_offset as usize;
                out.push(buffer[start..start + d.data_byte_size as usize].to_vec());
            }
            match status {
                0 if packets > 0 => continue,
                0 => {
                    self.done = self.feed.eof;
                    return Ok(out);
                }
                NEED_INPUT => return Ok(out),
                status => bail!("AudioToolbox AAC 编码失败（{status}）"),
            }
        }
    }
}

impl AacEncoder for Encoder {
    fn sample_rate(&self) -> u32 {
        self.rate
    }
    fn channels(&self) -> u32 {
        self.channels
    }
    fn priming(&self) -> u32 {
        self.priming
    }
    fn encode(&mut self, pcm: &[f32]) -> Result<Vec<Vec<u8>>> {
        self.feed.queue.push(pcm);
        self.drain()
    }
    fn finish(&mut self) -> Result<Vec<Vec<u8>>> {
        self.feed.eof = true;
        let mut out = Vec::new();
        while !self.done {
            let more = self.drain()?;
            if more.is_empty() && !self.done {
                bail!("AudioToolbox AAC 编码器没有结束输出");
            }
            out.extend(more);
        }
        Ok(out)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { AudioConverterDispose(self.converter) };
    }
}
