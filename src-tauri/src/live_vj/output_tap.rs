//! macOS output-device capture, without stereo mixdown or a third-party driver.
//! Device discovery is read-only. The private tap/aggregate exist only while capturing.
use super::{audio_input::{channel_label, channel_range, InputDevice, Ring}, diagnostics::InputChannel};
use anyhow::{ensure, Context, Result};
use objc2::{msg_send, rc::{Allocated, Retained}, runtime::{AnyClass, AnyObject, Bool}};
use objc2_core_audio::*;
use objc2_core_audio_types::*;
use objc2_core_foundation::{CFDictionary, CFRetained, CFString};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use std::{ffi::c_void, mem::{size_of, MaybeUninit}, ops::Range, ptr::NonNull, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock}, thread::JoinHandle, time::{Duration, Instant}};

const PREFIX: &str = "kdj-output-tap-";
type CreateTap = unsafe extern "C" fn(*const AnyObject, *mut u32) -> i32;
type DestroyTap = unsafe extern "C" fn(u32) -> i32;
struct Api { create: CreateTap, destroy: DestroyTap }

fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        // Do not strongly link macOS 14.2 symbols: older systems must still be
        // able to launch KDJ and use ScreenCaptureKit/native recording inputs.
        let create = libc::dlsym(libc::RTLD_DEFAULT, c"AudioHardwareCreateProcessTap".as_ptr());
        let destroy = libc::dlsym(libc::RTLD_DEFAULT, c"AudioHardwareDestroyProcessTap".as_ptr());
        if create.is_null() || destroy.is_null() || AnyClass::get(c"CATapDescription").is_none() { return None; }
        Some(Api { create: std::mem::transmute::<*mut c_void, CreateTap>(create), destroy: std::mem::transmute::<*mut c_void, DestroyTap>(destroy) })
    }).as_ref()
}
pub fn available() -> bool { api().is_some() }
fn status(code: i32, operation: &str) -> Result<()> {
    ensure!(code == 0, "{operation}（Core Audio {code}）"); Ok(())
}
fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain }
}
// Only instantiated below for HAL POD scalars/structs and retained CF pointers.
fn property<T: Copy>(object: u32, selector: u32, scope: u32) -> Result<T> {
    let mut value = MaybeUninit::<T>::uninit(); let mut size = size_of::<T>() as u32;
    let mut addr = address(selector, scope);
    unsafe {
        status(AudioObjectGetPropertyData(object, NonNull::from(&mut addr), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::new(value.as_mut_ptr()).unwrap().cast()), "读取输出设备属性失败")?;
        ensure!(size as usize == size_of::<T>(), "输出设备属性长度已改变");
        Ok(value.assume_init())
    }
}
fn ids(object: u32, selector: u32, scope: u32) -> Result<Vec<u32>> {
    let mut addr = address(selector, scope); let mut size = 0;
    unsafe {
        status(AudioObjectGetPropertyDataSize(object, NonNull::from(&mut addr), 0, std::ptr::null(), NonNull::from(&mut size)), "读取输出设备列表失败")?;
        ensure!(size % 4 == 0 && size <= 65536, "输出设备列表长度无效");
        if size == 0 { return Ok(vec![]); }
        let mut values = vec![0; size as usize / 4]; let capacity = size;
        status(AudioObjectGetPropertyData(object, NonNull::from(&mut addr), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::new(values.as_mut_ptr()).unwrap().cast()), "输出设备列表已改变，请刷新设备")?;
        ensure!(size <= capacity && size % 4 == 0, "输出设备列表长度无效");
        values.truncate(size as usize / 4); Ok(values)
    }
}
fn text(object: u32, selector: u32) -> Result<String> {
    let ptr: *mut CFString = property(object, selector, kAudioObjectPropertyScopeGlobal)?;
    // HAL CF-valued properties transfer a reference to the caller.
    let string = unsafe { CFRetained::from_raw(NonNull::new(ptr).context("输出设备名称为空")?) };
    Ok(string.to_string())
}
#[derive(Clone)]
pub struct Source {
    device: u32, stream: u32, uid: String, stream_index: usize,
    pub label: String,
    format: AudioStreamBasicDescription,
    rank: u8,
}
impl Source {
    pub fn id(&self) -> String { format!("tap:{}", serde_json::to_string(&(&self.uid, self.stream_index)).unwrap()) }
    pub fn channels(&self) -> u16 { self.format.mChannelsPerFrame as u16 }
    fn validate(&self) -> Result<()> {
        ensure!(property::<u32>(self.device, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal)? != 0, "输出设备已断开");
        validate_format(self.format)
    }
    pub fn choice(&self) -> InputDevice {
        InputDevice { id: self.id(), label: format!("{} · Core Audio Tap", self.label), channels: self.channels(),
            kind: "output", resolved_id: None, error: self.validate().err().map(|e| format!("{e:#}")) }
    }
}
fn validate_format(f: AudioStreamBasicDescription) -> Result<()> {
    ensure!(f.mSampleRate.is_finite() && (8000.0..=192000.0).contains(&f.mSampleRate) && f.mSampleRate.fract() == 0.0 && (1..=32).contains(&f.mChannelsPerFrame), "输出设备采样率或声道数不支持");
    // HAL virtual output streams/taps normally deliver native-endian floats.
    // Reject unknown layouts rather than reinterpret/downmix cue channels.
    let planar = f.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;
    let stride = (f.mBitsPerChannel / 8) * if planar { 1 } else { f.mChannelsPerFrame };
    ensure!(f.mFormatID == kAudioFormatLinearPCM && f.mFormatFlags & kAudioFormatFlagIsFloat != 0
        && f.mFormatFlags & kAudioFormatFlagIsBigEndian == 0 && matches!(f.mBitsPerChannel, 32 | 64)
        && f.mBytesPerFrame == stride && f.mFramesPerPacket == 1, "输出设备格式不支持：需要原生 Float32/64 PCM");
    Ok(())
}
pub fn sources() -> Result<Vec<Source>> {
    ensure!(available(), "输出设备捕获需要 macOS 14.2 或更新版本");
    let default = property::<u32>(kAudioObjectSystemObject as u32, kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal).unwrap_or(0);
    let mut result = vec![];
    for device in ids(kAudioObjectSystemObject as u32, kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)? {
        let Ok(uid) = text(device, kAudioDevicePropertyDeviceUID) else { continue };
        if uid.starts_with(PREFIX) { continue; }
        let Ok(streams) = ids(device, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput) else { continue };
        let name = text(device, kAudioObjectPropertyName).unwrap_or_else(|_| uid.clone());
        let transport = property::<u32>(device, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal).unwrap_or(0);
        let running = property::<u32>(device, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal).unwrap_or(0) != 0;
        let external = [kAudioDeviceTransportTypeUSB, kAudioDeviceTransportTypeThunderbolt, kAudioDeviceTransportTypeFireWire, kAudioDeviceTransportTypePCI].contains(&transport);
        // Prefer an active wired audio interface, then the system output. This
        // is only a recommendation; CH 1/2 is never advertised as verified Master.
        let rank = if external && running { 0 } else if device == default { 1 } else if external { 2 } else { 3 };
        for (stream_index, &stream) in streams.iter().enumerate() {
            let Ok(format) = property::<AudioStreamBasicDescription>(stream, kAudioStreamPropertyVirtualFormat, kAudioObjectPropertyScopeGlobal) else { continue };
            let label = if streams.len() > 1 { format!("{name} · 音频流 {}", stream_index + 1) } else { name.clone() };
            result.push(Source { device, stream, uid: uid.clone(), stream_index, label, format, rank });
        }
    }
    result.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.label.cmp(&b.label)).then(a.stream_index.cmp(&b.stream_index)));
    Ok(result)
}
pub fn resolve(id: &str) -> Result<Source> {
    sources()?.into_iter().find(|s| s.id() == id).context("所选输出设备或音频流已断开，请刷新设备")
}
pub fn validate(id: &str, channel_start: u16) -> Result<()> {
    let source = resolve(id)?; source.validate()?;
    channel_range(channel_start, source.channels())?; Ok(())
}

struct Callback {
    ring: Arc<Mutex<Ring>>, selected: Range<usize>, format: AudioStreamBasicDescription,
}
pub struct Capture {
    tap: u32, aggregate: u32, io: AudioDeviceIOProcID,
    state: Option<Box<Callback>>, stop: Arc<AtomicBool>, watch: Option<JoinHandle<()>>,
}
impl Capture {
    pub fn start(id: &str, channel_start: u16) -> Result<(Self, Arc<Mutex<Ring>>)> {
        let source = resolve(id)?; source.validate()?;
        let selected = channel_range(channel_start, source.channels())?;
        let api = api().context("输出设备捕获需要 macOS 14.2 或更新版本")?;
        let ring = Arc::new(Mutex::new(Ring::new(format!("输出设备 · Core Audio Tap · {} · {}", source.label, channel_label(&selected)), source.format.mSampleRate as u32)));
        let mut capture = Self { tap: 0, aggregate: 0, io: None, state: None, stop: Arc::new(AtomicBool::new(false)), watch: None };
        unsafe {
            let class = AnyClass::get(c"CATapDescription").context("Core Audio Tap 不可用")?;
            let allocated: Allocated<AnyObject> = msg_send![class, alloc];
            let processes = NSArray::<NSNumber>::new();
            let description: Retained<AnyObject> = msg_send![allocated, initWithProcesses: &*processes, andDeviceUID: &*NSString::from_str(&source.uid), withStream: source.stream_index as isize];
            let _: () = msg_send![&*description, setExclusive: Bool::YES]; // empty exclusion list = all processes on this stream
            let _: () = msg_send![&*description, setPrivate: Bool::YES];
            let _: () = msg_send![&*description, setMixdown: Bool::NO];
            let _: () = msg_send![&*description, setMono: Bool::NO];
            let _: () = msg_send![&*description, setMuteBehavior: 0isize]; // unmuted: leave DJ playback untouched
            status((api.create)(&*description, &mut capture.tap), "创建输出设备捕获失败，请检查系统音频录制权限")?;
            let format: AudioStreamBasicDescription = property(capture.tap, kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal)?;
            validate_format(format)?;
            ensure!(format.mChannelsPerFrame == source.format.mChannelsPerFrame && format.mSampleRate == source.format.mSampleRate, "捕获格式与输出设备不一致，已拒绝混音降级");
            let tap_uid = text(capture.tap, kAudioTapPropertyUID)?;
            let sub = dict(&[("uid", NSString::from_str(&tap_uid).as_ref()), ("drift", NSNumber::new_bool(true).as_ref())]);
            let taps = NSArray::from_slice(&[&*sub]);
            let uid = NSString::from_str(&format!("{PREFIX}{}", super::document::id()));
            // No physical subdevice: this is an input-only private tap reader,
            // not a new system playback route or a replacement default device.
            let description = dict(&[("uid", &*uid), ("name", &*NSString::from_str("KDJ 输出设备捕获")),
                ("private", &*NSNumber::new_bool(true)), ("tapautostart", &*NSNumber::new_bool(true)), ("taps", &*taps)]);
            let cf = &*(Retained::as_ptr(&description) as *const CFDictionary);
            status(AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut capture.aggregate)), "创建私有音频采集设备失败")?;
            capture.state = Some(Box::new(Callback { ring: ring.clone(), selected, format }));
            let state = capture.state.as_mut().unwrap().as_mut() as *mut Callback;
            status(AudioDeviceCreateIOProcID(capture.aggregate, Some(callback), state.cast(), NonNull::from(&mut capture.io)), "创建输出设备音频回调失败")?;
            status(AudioDeviceStart(capture.aggregate, capture.io), "启动输出设备捕获失败，请检查系统音频录制权限")?;
        }
        let stop = capture.stop.clone(); let errors = ring.clone();
        capture.watch = Some(std::thread::Builder::new().name("vj-output-device".into()).spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let result = (|| -> Result<()> {
                    source.validate()?;
                    let streams = ids(source.device, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput)?;
                    ensure!(streams.get(source.stream_index) == Some(&source.stream), "输出设备音频流已改变，请停止并刷新设备");
                    let format: AudioStreamBasicDescription = property(source.stream, kAudioStreamPropertyVirtualFormat, kAudioObjectPropertyScopeGlobal)?;
                    ensure!(format == source.format, "输出设备音频格式已改变，请停止并刷新设备");
                    Ok(())
                })();
                if let Err(error) = result {
                    if let Ok(mut ring) = errors.lock() { ring.error = Some(format!("{error:#}")); }
                    break;
                }
                std::thread::park_timeout(Duration::from_millis(250));
            }
        }).context("启动输出设备状态监测失败")?);
        Ok((capture, ring))
    }
}
fn dict(entries: &[(&str, &AnyObject)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: Vec<_> = entries.iter().map(|(k, _)| NSString::from_str(k)).collect();
    NSDictionary::from_slices(&keys.iter().map(|k| &**k).collect::<Vec<_>>(), &entries.iter().map(|(_, v)| *v).collect::<Vec<_>>())
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(watch) = self.watch.take() { watch.thread().unpark(); let _ = watch.join(); }
        unsafe {
            if self.io.is_some() {
                let _ = AudioDeviceStop(self.aggregate, self.io);
                let code = AudioDeviceDestroyIOProcID(self.aggregate, self.io);
                if code != 0 {
                    // Never free callback storage while HAL could still call it.
                    if let Some(state) = self.state.take() { let _ = Box::leak(state); }
                    tracing::warn!("live VJ output callback teardown failed: {code}");
                }
            }
            if self.aggregate != 0 {
                let code = AudioHardwareDestroyAggregateDevice(self.aggregate);
                if code != 0 { tracing::warn!("live VJ private aggregate teardown failed: {code}"); }
            }
            if self.tap != 0 {
                if let Some(api) = api() {
                    let code = (api.destroy)(self.tap);
                    if code != 0 { tracing::warn!("live VJ output tap teardown failed: {code}"); }
                }
            }
        }
    }
}
unsafe extern "C-unwind" fn callback(
    _device: u32, _now: NonNull<AudioTimeStamp>, input: NonNull<AudioBufferList>, time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>, _output_time: NonNull<AudioTimeStamp>, context: *mut c_void,
) -> i32 {
    let state = unsafe { &*(context as *const Callback) };
    let received = Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { state.receive(input.as_ref(), time.as_ref(), received) }));
    let error = match result { Ok(Ok(())) => None, Ok(Err(e)) => Some(format!("{e:#}")), Err(_) => Some("输出设备音频回调异常".into()) };
    if let Some(error) = error { if let Ok(mut ring) = state.ring.lock() { ring.error = Some(error); } }
    0
}
impl Callback {
    unsafe fn receive(&self, input: &AudioBufferList, time: &AudioTimeStamp, received: Instant) -> Result<()> {
        if input.mNumberBuffers == 0 { return Ok(()); }
        ensure!(input.mNumberBuffers <= 32, "输出捕获缓冲区数量无效");
        // AudioBufferList is a variable-length HAL allocation; mBuffers[1] is
        // its ABI placeholder, not its actual array length.
        let buffers = unsafe { std::slice::from_raw_parts(input.mBuffers.as_ptr(), input.mNumberBuffers as usize) };
        let channels = self.format.mChannelsPerFrame as usize;
        ensure!(buffers.iter().map(|b| b.mNumberChannels as usize).sum::<usize>() == channels, "输出捕获声道布局已改变，已停止读取");
        let bytes = self.format.mBitsPerChannel as usize / 8;
        let mut frames = None;
        for buffer in buffers {
            let stride = buffer.mNumberChannels as usize * bytes;
            ensure!(stride > 0 && buffer.mDataByteSize as usize % stride == 0, "输出捕获缓冲区布局无效");
            let count = buffer.mDataByteSize as usize / stride;
            if let Some(frames) = frames { ensure!(frames == count, "输出捕获声道长度不一致"); }
            frames = Some(count);
        }
        let frames = frames.unwrap_or(0);
        if frames == 0 { return Ok(()); }
        ensure!(frames <= self.format.mSampleRate as usize, "输出捕获音频包过大");
        ensure!(time.mFlags.contains(AudioTimeStampFlags::HostTimeValid), "输出捕获时间戳无效");
        let host_now = unsafe { AudioGetCurrentHostTime() };
        ensure!(time.mHostTime <= host_now, "输出捕获时间戳超前");
        let age = Duration::from_nanos(unsafe { AudioConvertHostTimeToNanos(host_now - time.mHostTime) });
        ensure!(age <= Duration::from_secs(5), "输出捕获时间戳已过期");
        let first = received.checked_sub(age).context("输出捕获时钟无效")?;
        let mut mono = vec![0f32; frames]; let mut power = [0f64; 2]; let mut peak = [0f64; 2];
        let mut offset = 0;
        for buffer in buffers {
            let n = buffer.mNumberChannels as usize;
            for channel in self.selected.clone() {
                if channel < offset || channel >= offset + n || buffer.mData.is_null() { continue; }
                let local = channel - offset; let index = channel - self.selected.start;
                for (frame, value) in mono.iter_mut().enumerate() {
                    let ptr = unsafe { buffer.mData.cast::<u8>().add((frame * n + local) * bytes) };
                    let sample = if bytes == 4 { unsafe { ptr.cast::<f32>().read_unaligned() } }
                        else { unsafe { ptr.cast::<f64>().read_unaligned() as f32 } };
                    ensure!(sample.is_finite(), "输出捕获包含无效采样");
                    *value += sample / self.selected.len() as f32;
                    power[index] += (sample as f64).powi(2); peak[index] = peak[index].max(sample.abs() as f64);
                }
            }
            offset += n;
        }
        let levels = self.selected.clone().enumerate().map(|(i, channel)| InputChannel {
            name: format!("CH {}", channel + 1), rms_dbfs: 10. * (power[i] / frames as f64).max(1e-12).log10(), peak_dbfs: 20. * peak[i].max(1e-6).log10(),
        }).collect();
        if let Ok(mut ring) = self.ring.lock() { if ring.error.is_none() { ring.push(&mono, levels, first, received)?; } }
        Ok(())
    }
}
