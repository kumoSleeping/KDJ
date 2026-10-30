//! Media Foundation's AAC encoder MFT (`CLSID_AACMFTEncoder`). It takes 16-bit PCM at
//! 44.1 or 48 kHz and offers 96, 128, 160 and 192 kbps.

use super::{AacEncoder, FrameQueue, FRAME};
use anyhow::{bail, Context, Result};
use std::mem::ManuallyDrop;
use windows::core::GUID;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

const CLSID_AAC_ENCODER: GUID = GUID::from_u128(0x93af0c51_2275_45d2_a35b_f2ba21caed00);

pub struct Encoder {
    mft: IMFTransform,
    rate: u32,
    channels: u32,
    queue: FrameQueue,
    frames: i64,
    output_size: u32,
    provides_samples: bool,
}

// One thread at a time; the MFT is created in the multithreaded apartment.
unsafe impl Send for Encoder {}

fn audio_type(subtype: &GUID, rate: u32, channels: u32) -> windows::core::Result<IMFMediaType> {
    unsafe {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        media.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        media.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
        media.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)?;
        Ok(media)
    }
}

impl Encoder {
    pub fn new(rate: u32, channels: u32, bitrate: u32) -> Result<Self> {
        if ![44100, 48000].contains(&rate) {
            bail!("Media Foundation 的 AAC 编码器只支持 44.1 kHz 和 48 kHz");
        }
        // 12000/16000/20000/24000 bytes per second are the only rates it accepts.
        let bytes_per_second = (bitrate / 8).clamp(12_000, 24_000) / 4000 * 4000;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).context("Media Foundation 启动失败")?;
            let mft: IMFTransform = CoCreateInstance(&CLSID_AAC_ENCODER, None, CLSCTX_INPROC_SERVER).context("系统没有 Media Foundation AAC 编码器")?;
            let input = audio_type(&MFAudioFormat_PCM, rate, channels)?;
            input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2 * channels)?;
            input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * 2 * channels)?;
            let output = audio_type(&MFAudioFormat_AAC, rate, channels)?;
            output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bytes_per_second)?;
            output.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
            output.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;
            if mft.SetOutputType(0, &output, 0).and_then(|_| mft.SetInputType(0, &input, 0)).is_err() {
                mft.SetInputType(0, &input, 0).context("AAC 编码器不接受这个 PCM 格式")?;
                mft.SetOutputType(0, &output, 0).context("AAC 编码器不接受这个输出格式")?;
            }
            let info = mft.GetOutputStreamInfo(0)?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Self {
                mft,
                rate,
                channels,
                queue: FrameQueue::default(),
                frames: 0,
                output_size: info.cbSize.max(8192),
                provides_samples: info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0,
            })
        }
    }

    fn input(&mut self, pcm: &[f32]) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let frames = pcm.len() / self.channels as usize;
        unsafe {
            let buffer = MFCreateMemoryBuffer((pcm.len() * 2) as u32)?;
            let mut data = std::ptr::null_mut();
            buffer.Lock(&mut data, None, None)?;
            let target = std::slice::from_raw_parts_mut(data as *mut i16, pcm.len());
            for (to, from) in target.iter_mut().zip(pcm) {
                *to = (from.clamp(-1., 1.) * 32767.).round() as i16;
            }
            buffer.Unlock()?;
            buffer.SetCurrentLength((pcm.len() * 2) as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(self.frames * 10_000_000 / self.rate as i64)?;
            sample.SetSampleDuration(frames as i64 * 10_000_000 / self.rate as i64)?;
            self.frames += frames as i64;
            loop {
                match self.mft.ProcessInput(0, &sample, 0) {
                    Ok(()) => break,
                    Err(error) if error.code() == MF_E_NOTACCEPTING => out.extend(self.output()?),
                    Err(error) => return Err(error).context("AAC 编码器拒绝输入"),
                }
            }
        }
        out.extend(self.output()?);
        Ok(out)
    }

    fn output(&mut self) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        loop {
            unsafe {
                let sample = if self.provides_samples {
                    None
                } else {
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&MFCreateMemoryBuffer(self.output_size)?)?;
                    Some(sample)
                };
                let mut buffers = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(sample), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
                let mut status = 0u32;
                let result = self.mft.ProcessOutput(0, &mut buffers, &mut status);
                let sample = ManuallyDrop::take(&mut buffers[0].pSample);
                drop(ManuallyDrop::take(&mut buffers[0].pEvents));
                match result {
                    Ok(()) => {}
                    Err(error) if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(out),
                    Err(error) => return Err(error).context("AAC 编码失败"),
                }
                let Some(sample) = sample else { continue };
                let buffer = sample.ConvertToContiguousBuffer()?;
                let mut data = std::ptr::null_mut();
                let mut length = 0u32;
                buffer.Lock(&mut data, None, Some(&mut length))?;
                let bytes = std::slice::from_raw_parts(data, length as usize).to_vec();
                buffer.Unlock()?;
                if !bytes.is_empty() {
                    out.push(bytes);
                }
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
            out.extend(self.input(&frame)?);
        }
        Ok(out)
    }
    fn finish(&mut self) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let rest = self.queue.rest();
        if !rest.is_empty() {
            out.extend(self.input(&rest)?);
        }
        unsafe {
            self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
        }
        out.extend(self.output()?);
        Ok(out)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = MFShutdown();
        }
    }
}
