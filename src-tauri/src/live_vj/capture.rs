//! macOS automatic system-audio source. No screen frames or recordings retained.
use super::{audio_input::Ring, diagnostics::InputChannel};
use anyhow::{bail, Context, Result};
use block2::RcBlock;
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
};
use objc2_core_audio_types::{AudioBuffer, AudioBufferList};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionGetStreamBasicDescription, CMClock, CMSampleBuffer,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate,
    SCStreamOutput, SCStreamOutputType,
};
use std::{
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

struct Sink {
    ring: Arc<Mutex<Ring>>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[name = "KDJLiveVjAudioSink"]
    #[ivars = Sink]
    struct AudioSink;
    unsafe impl NSObjectProtocol for AudioSink {}
    unsafe impl SCStreamOutput for AudioSink {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn output(
            &self,
            _stream: &SCStream,
            sample: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            if kind != SCStreamOutputType::Audio {
                return;
            }
            // CoreMedia owns these buffers for the duration of the callback. Copy
            // bounded PCM before returning; never retain a pointer into CMSampleBuffer.
            let result = (|| -> Result<()> {
                let format = unsafe { sample.format_description() }.context("捕获音频缺少格式")?;
                let asbd =
                    unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&format).as_ref() }
                        .context("捕获音频格式无效")?;
                let channels = asbd.mChannelsPerFrame as usize;
                if !(1..=2).contains(&channels)
                    || asbd.mSampleRate != 48000.
                    || asbd.mBitsPerChannel != 32
                    || asbd.mFormatFlags & 3 != 1
                {
                    bail!("系统返回了不支持的捕获格式（需要 48 kHz 浮点 PCM）")
                }
                let frames = unsafe { sample.num_samples() };
                if frames == 0 {
                    return Ok(());
                }
                anyhow::ensure!((1..=48000).contains(&frames), "捕获音频包大小无效");
                let frames = frames as usize;
                // SCK's channelCount=1 is not the same downmix as reference
                // decoding. Request stereo and explicitly average every channel.
                // Use AudioBufferList, not assumptions about planar padding.
                #[repr(C)]
                struct StereoBuffers {
                    count: u32,
                    buffers: [AudioBuffer; 2],
                }
                let mut list = StereoBuffers {
                    count: 0,
                    buffers: [AudioBuffer {
                        mNumberChannels: 0,
                        mDataByteSize: 0,
                        mData: std::ptr::null_mut(),
                    }; 2],
                };
                let mut block = std::ptr::null_mut();
                let code = unsafe {
                    sample.audio_buffer_list_with_retained_block_buffer(
                        std::ptr::null_mut(),
                        (&mut list as *mut StereoBuffers).cast::<AudioBufferList>(),
                        std::mem::size_of::<StereoBuffers>(),
                        None,
                        None,
                        1,
                        &mut block,
                    )
                };
                let _owner =
                    std::ptr::NonNull::new(block).map(|p| unsafe { CFRetained::from_raw(p) });
                anyhow::ensure!(
                    code == 0 && (1..=2).contains(&list.count),
                    "读取捕获声道失败：{code}"
                );
                let mut values = vec![0f32; frames];
                let mut channel_power = [0f64; 2];
                let mut channel_peak = [0f64; 2];
                let mut seen = 0;
                for buffer in &list.buffers[..list.count as usize] {
                    let ch = buffer.mNumberChannels as usize;
                    anyhow::ensure!(
                        (1..=channels).contains(&ch)
                            && seen + ch <= channels
                            && !buffer.mData.is_null()
                            && buffer.mDataByteSize as usize == frames * ch * 4,
                        "捕获声道布局无效"
                    );
                    let samples = unsafe {
                        std::slice::from_raw_parts(buffer.mData.cast::<f32>(), frames * ch)
                    };
                    anyhow::ensure!(
                        samples.iter().all(|v| v.is_finite()),
                        "捕获音频包含无效数值"
                    );
                    for (mono, frame) in values.iter_mut().zip(samples.chunks_exact(ch)) {
                        *mono += frame.iter().sum::<f32>() / channels as f32;
                        for (i, &sample) in frame.iter().enumerate() {
                            channel_power[seen + i] += (sample as f64).powi(2);
                            channel_peak[seen + i] =
                                channel_peak[seen + i].max(sample.abs() as f64);
                        }
                    }
                    seen += ch;
                }
                anyhow::ensure!(seen == channels, "捕获声道不完整");
                // ScreenCaptureKit PTS is on the CoreMedia host clock. Map it to
                // Instant at callback entry, before locking/filtering this packet.
                let received_at = Instant::now();
                let host_now = unsafe { CMClock::host_time_clock().time().seconds() };
                let pts = unsafe { sample.presentation_time_stamp().seconds() };
                anyhow::ensure!(
                    pts.is_finite() && host_now.is_finite(),
                    "系统音频时间戳无效"
                );
                let levels = (0..channels)
                    .map(|i| InputChannel {
                        name: if channels == 1 {
                            "Mono"
                        } else if i == 0 {
                            "L"
                        } else {
                            "R"
                        }.into(),
                        rms_dbfs: 10. * (channel_power[i] / frames as f64).max(1e-12).log10(),
                        peak_dbfs: 20. * channel_peak[i].max(1e-6).log10(),
                    })
                    .collect();
                let age = host_now - pts;
                anyhow::ensure!((-0.1..=5.).contains(&age), "系统音频时钟与主机时钟不一致");
                let first = if age >= 0. { received_at - Duration::from_secs_f64(age) }
                    else { received_at + Duration::from_secs_f64(-age) };
                self.ivars().ring.lock().unwrap().push(&values, levels, first, received_at)
            })();
            if let Err(e) = result {
                if let Ok(mut ring) = self.ivars().ring.lock() {
                    ring.error = Some(e.to_string());
                }
            }
        }
    }
    unsafe impl SCStreamDelegate for AudioSink {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stopped(&self, _stream: &SCStream, error: &NSError) {
            if let Ok(mut ring) = self.ivars().ring.lock() {
                ring.error = Some(error.to_string());
            }
        }
    }
);
// SCShareableContent is an immutable framework snapshot. Transfer its retained
// ownership from Apple's completion queue to the worker; no AppKit UI is touched.
struct SharedContent(Retained<SCShareableContent>);
unsafe impl Send for SharedContent {}
pub struct Capture {
    stream: Retained<SCStream>,
    _sink: Retained<AudioSink>,
}
impl Capture {
    pub fn start(ring: Arc<Mutex<Ring>>) -> Result<Self> {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        if version.majorVersion < 13 {
            bail!("系统音频捕获需要 macOS 13 或更新版本")
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let block = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if let Some(error) = unsafe { error.as_ref() } {
                    Err(error.to_string())
                } else {
                    unsafe { Retained::retain(content) }
                        .map(SharedContent)
                        .ok_or_else(|| "没有可捕获的屏幕".into())
                };
                let _ = tx.send(result);
            },
        );
        unsafe {
            SCShareableContent::getShareableContentWithCompletionHandler(&block);
        }
        let content = rx
            .recv_timeout(Duration::from_secs(30))
            .context("等待系统录屏授权超时")?
            .map_err(anyhow::Error::msg)?
            .0;
        let displays = unsafe { content.displays() };
        let display = displays.firstObject().context("没有可捕获的屏幕")?;
        let sink: Retained<AudioSink> = unsafe {
            let this = AudioSink::alloc().set_ivars(Sink { ring });
            msg_send![super(this), init]
        };
        let stream = unsafe {
            let filter = SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::new(),
            );
            let config = SCStreamConfiguration::new();
            config.setWidth(2);
            config.setHeight(2);
            config.setCapturesAudio(true);
            config.setSampleRate(48000);
            config.setChannelCount(2);
            // KDJ's output is muted, but its music player may be the input DJ source.
            config.setExcludesCurrentProcessAudio(false);
            let stream = SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(ProtocolObject::from_ref(&*sink)),
            );
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*sink),
                    SCStreamOutputType::Audio,
                    None,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            stream
        };
        let capture = Self {
            stream,
            _sink: sink,
        };
        let (tx, rx) = mpsc::sync_channel(1);
        let done = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(unsafe { error.as_ref() }.map(|e| e.to_string()));
        });
        unsafe {
            capture
                .stream
                .startCaptureWithCompletionHandler(Some(&done));
        }
        if let Some(error) = rx
            .recv_timeout(Duration::from_secs(15))
            .context("启动系统音频捕获超时")?
        {
            bail!("{error}")
        }
        Ok(capture)
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            self.stream.stopCaptureWithCompletionHandler(None);
        }
    }
}
