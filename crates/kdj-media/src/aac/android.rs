//! MediaCodec's AAC encoder through the NDK (`libmediandk`, API 21+).

use super::{AacEncoder, FrameQueue, FRAME};
use anyhow::{bail, Result};
use std::ffi::{c_char, c_long, c_void, CString};

#[repr(C)]
#[derive(Default)]
struct BufferInfo {
    offset: i32,
    size: i32,
    presentation_time_us: i64,
    flags: u32,
}

#[link(name = "mediandk")]
extern "C" {
    fn AMediaCodec_createEncoderByType(mime: *const c_char) -> *mut c_void;
    fn AMediaCodec_configure(codec: *mut c_void, format: *const c_void, surface: *mut c_void, crypto: *mut c_void, flags: u32) -> i32;
    fn AMediaCodec_start(codec: *mut c_void) -> i32;
    fn AMediaCodec_stop(codec: *mut c_void) -> i32;
    fn AMediaCodec_delete(codec: *mut c_void) -> i32;
    fn AMediaCodec_dequeueInputBuffer(codec: *mut c_void, timeout_us: i64) -> isize;
    fn AMediaCodec_getInputBuffer(codec: *mut c_void, index: usize, size: *mut usize) -> *mut u8;
    fn AMediaCodec_queueInputBuffer(codec: *mut c_void, index: usize, offset: c_long, size: usize, time: u64, flags: u32) -> i32;
    fn AMediaCodec_dequeueOutputBuffer(codec: *mut c_void, info: *mut BufferInfo, timeout_us: i64) -> isize;
    fn AMediaCodec_getOutputBuffer(codec: *mut c_void, index: usize, size: *mut usize) -> *mut u8;
    fn AMediaCodec_releaseOutputBuffer(codec: *mut c_void, index: usize, render: bool) -> i32;
    fn AMediaFormat_new() -> *mut c_void;
    fn AMediaFormat_delete(format: *mut c_void) -> i32;
    fn AMediaFormat_setString(format: *mut c_void, name: *const c_char, value: *const c_char);
    fn AMediaFormat_setInt32(format: *mut c_void, name: *const c_char, value: i32);
}

const CONFIGURE_ENCODE: u32 = 1;
const FLAG_CODEC_CONFIG: u32 = 2;
const FLAG_END_OF_STREAM: u32 = 4;
const TIMEOUT_US: i64 = 10_000;

pub struct Encoder {
    codec: *mut c_void,
    rate: u32,
    channels: u32,
    queue: FrameQueue,
    frames: u64,
    ended: bool,
}

unsafe impl Send for Encoder {}

fn key(name: &str) -> CString {
    CString::new(name).unwrap()
}

impl Encoder {
    pub fn new(rate: u32, channels: u32, bitrate: u32) -> Result<Self> {
        unsafe {
            let codec = AMediaCodec_createEncoderByType(key("audio/mp4a-latm").as_ptr());
            if codec.is_null() {
                bail!("这台设备没有 MediaCodec AAC 编码器");
            }
            let format = AMediaFormat_new();
            AMediaFormat_setString(format, key("mime").as_ptr(), key("audio/mp4a-latm").as_ptr());
            AMediaFormat_setInt32(format, key("sample-rate").as_ptr(), rate as i32);
            AMediaFormat_setInt32(format, key("channel-count").as_ptr(), channels as i32);
            AMediaFormat_setInt32(format, key("bitrate").as_ptr(), bitrate as i32);
            AMediaFormat_setInt32(format, key("aac-profile").as_ptr(), 2);
            AMediaFormat_setInt32(format, key("max-input-size").as_ptr(), (FRAME * 2 * channels as usize) as i32);
            let status = AMediaCodec_configure(codec, format, std::ptr::null_mut(), std::ptr::null_mut(), CONFIGURE_ENCODE);
            AMediaFormat_delete(format);
            if status != 0 || AMediaCodec_start(codec) != 0 {
                AMediaCodec_delete(codec);
                bail!("MediaCodec AAC 编码器无法启动（{status}）");
            }
            Ok(Self { codec, rate, channels, queue: FrameQueue::default(), frames: 0, ended: false })
        }
    }

    fn queue_input(&mut self, pcm: &[f32], end: bool, out: &mut Vec<Vec<u8>>) -> Result<()> {
        loop {
            let index = unsafe { AMediaCodec_dequeueInputBuffer(self.codec, TIMEOUT_US) };
            if index < 0 {
                self.drain(false, out)?;
                continue;
            }
            let mut capacity = 0usize;
            let buffer = unsafe { AMediaCodec_getInputBuffer(self.codec, index as usize, &mut capacity) };
            let bytes = pcm.len() * 2;
            if buffer.is_null() || capacity < bytes {
                bail!("MediaCodec 输入缓冲区不足");
            }
            let target = unsafe { std::slice::from_raw_parts_mut(buffer as *mut i16, pcm.len()) };
            for (to, from) in target.iter_mut().zip(pcm) {
                *to = (from.clamp(-1., 1.) * 32767.).round() as i16;
            }
            let time = self.frames * 1_000_000 / self.rate as u64;
            self.frames += (pcm.len() / self.channels as usize) as u64;
            let status = unsafe { AMediaCodec_queueInputBuffer(self.codec, index as usize, 0, bytes, time, if end { FLAG_END_OF_STREAM } else { 0 }) };
            if status != 0 {
                bail!("MediaCodec 拒绝输入（{status}）");
            }
            return Ok(());
        }
    }

    /// Collects output; with `until_end`, waits for the end-of-stream buffer.
    fn drain(&mut self, until_end: bool, out: &mut Vec<Vec<u8>>) -> Result<()> {
        let mut idle = 0;
        loop {
            let mut info = BufferInfo::default();
            let index = unsafe { AMediaCodec_dequeueOutputBuffer(self.codec, &mut info, TIMEOUT_US) };
            if index < 0 {
                // -1 try again later, -2 format changed, -3 buffers changed.
                if index == -1 {
                    if !until_end {
                        return Ok(());
                    }
                    idle += 1;
                    if idle > 500 {
                        bail!("MediaCodec AAC 编码器没有结束输出");
                    }
                }
                continue;
            }
            let mut size = 0usize;
            let buffer = unsafe { AMediaCodec_getOutputBuffer(self.codec, index as usize, &mut size) };
            if !buffer.is_null() && info.size > 0 && info.flags & FLAG_CODEC_CONFIG == 0 {
                let data = unsafe { std::slice::from_raw_parts(buffer.add(info.offset as usize), info.size as usize) };
                out.push(data.to_vec());
            }
            unsafe { AMediaCodec_releaseOutputBuffer(self.codec, index as usize, false) };
            if info.flags & FLAG_END_OF_STREAM != 0 {
                self.ended = true;
                return Ok(());
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
        // Measured by `super::measure_priming` before use.
        0
    }
    fn encode(&mut self, pcm: &[f32]) -> Result<Vec<Vec<u8>>> {
        self.queue.push(pcm);
        let mut out = Vec::new();
        while let Some(frame) = self.queue.take(FRAME * self.channels as usize) {
            self.queue_input(&frame, false, &mut out)?;
            self.drain(false, &mut out)?;
        }
        Ok(out)
    }
    fn finish(&mut self) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let rest = self.queue.rest();
        self.queue_input(&rest, true, &mut out)?;
        self.drain(true, &mut out)?;
        Ok(out)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            AMediaCodec_stop(self.codec);
            AMediaCodec_delete(self.codec);
        }
    }
}
