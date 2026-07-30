use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, Stream, StreamConfig, SupportedBufferSize};
use rtrb::Consumer;

use crate::command::SourceKind;
use crate::engine::{dynamic_command_channel, AudioRenderer};
use crate::{
    command_channel, CommandError, DeckId, DecodedTrack, PlayerController, RtCommand,
    StreamSource, TransportSnapshot,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutputSpec {
    pub sample_rate: u32,
    pub channels: usize,
    pub requested_buffer_frames: Option<u32>,
}

#[derive(Debug)]
pub enum OutputError {
    NoDevice,
    UnsupportedFormat(SampleFormat),
    Backend(cpal::Error),
}

impl fmt::Display for OutputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDevice => formatter.write_str("no default audio output device"),
            Self::UnsupportedFormat(format) => {
                write!(
                    formatter,
                    "output sample format {format} is not realtime f32"
                )
            }
            Self::Backend(error) => write!(formatter, "audio backend error: {error}"),
        }
    }
}

impl std::error::Error for OutputError {}

impl<E> From<E> for OutputError
where
    E: Into<cpal::Error>,
{
    fn from(error: E) -> Self {
        Self::Backend(error.into())
    }
}

/// Owns the platform output stream. Dropping it closes the device callback.
pub struct DeviceOutput {
    stream: Stream,
    spec: OutputSpec,
}

/// Complete native two-Deck output with control-thread ownership of decoded or streaming sources.
///
/// The callback receives only stable addresses. Replaced source IDs travel back through an SPSC
/// acknowledgement queue; only this owner drops their `Arc`s. `output` is explicitly dropped
/// first so no callback can observe freed source memory during shutdown.
pub struct DynamicPlayer {
    output: Option<DeviceOutput>,
    controller: PlayerController,
    sources: HashMap<u64, OwnedSource>,
    retired: Consumer<u64>,
    next_source_id: u64,
}

enum OwnedSource {
    Decoded(Arc<DecodedTrack>),
    Stream(Arc<StreamSource>),
}

/// Opens a complete two-deck native output path for already decoded tracks.
///
/// Track ownership moves into the callback once, outside realtime execution. The callback only
/// reads immutable PCM and applies bounded transport commands.
pub fn open_prepared_default<E>(
    deck_a: Arc<DecodedTrack>,
    deck_b: Arc<DecodedTrack>,
    command_capacity: usize,
    on_error: E,
) -> Result<(PlayerController, DeviceOutput), OutputError>
where
    E: FnMut(cpal::Error) + Send + 'static,
{
    let (controller, mut renderer) = command_channel(command_capacity);
    let output = DeviceOutput::open_default(
        move |samples, spec| {
            renderer.render_tracks(&deck_a, &deck_b, samples, spec.sample_rate, spec.channels);
        },
        on_error,
    )?;
    Ok((controller, output))
}

/// Opens the shared desktop engine without routing final audio through a WebView.
pub fn open_dynamic_default<E>(
    command_capacity: usize,
    on_error: E,
) -> Result<DynamicPlayer, OutputError>
where
    E: FnMut(cpal::Error) + Send + 'static,
{
    let retire_capacity = command_capacity.max(8);
    let (controller, renderer, retired) =
        dynamic_command_channel(command_capacity, retire_capacity);
    let output = DeviceOutput::open_dynamic(renderer, on_error)?;
    Ok(DynamicPlayer {
        output: Some(output),
        controller,
        sources: HashMap::new(),
        retired,
        next_source_id: 1,
    })
}

impl DynamicPlayer {
    pub fn install(
        &mut self,
        deck: DeckId,
        track: Arc<DecodedTrack>,
        start_frame: u64,
    ) -> Result<u64, CommandError> {
        self.collect_retired();
        let source_id = self.next_source_id;
        self.next_source_id = self.next_source_id.wrapping_add(1).max(1);
        let address = Arc::as_ptr(&track) as usize;
        self.sources.insert(source_id, OwnedSource::Decoded(track));
        if let Err(error) = self.controller.install_prepared(
            deck,
            source_id,
            SourceKind::Decoded,
            address,
            start_frame,
        )
        {
            self.sources.remove(&source_id);
            return Err(error);
        }
        Ok(source_id)
    }

    pub fn install_stream(
        &mut self,
        deck: DeckId,
        source: Arc<StreamSource>,
        start_frame: u64,
    ) -> Result<u64, CommandError> {
        self.collect_retired();
        let source_id = self.next_source_id;
        self.next_source_id = self.next_source_id.wrapping_add(1).max(1);
        let address = Arc::as_ptr(&source) as usize;
        self.sources.insert(source_id, OwnedSource::Stream(source));
        if let Err(error) = self.controller.install_prepared(
            deck,
            source_id,
            SourceKind::Stream,
            address,
            start_frame,
        ) {
            self.sources.remove(&source_id);
            return Err(error);
        }
        Ok(source_id)
    }

    pub fn clear(&mut self, deck: DeckId) -> Result<(), CommandError> {
        self.collect_retired();
        self.controller.clear_prepared(deck)
    }

    pub fn send(&mut self, command: RtCommand) -> Result<(), CommandError> {
        self.collect_retired();
        self.controller.send(command)
    }

    pub fn snapshot(&mut self) -> TransportSnapshot {
        self.collect_retired();
        self.controller.snapshot()
    }

    pub fn spec(&self) -> OutputSpec {
        self.output
            .as_ref()
            .expect("dynamic output exists until drop")
            .spec()
    }

    pub fn collect_retired(&mut self) {
        while let Ok(source_id) = self.retired.pop() {
            self.sources.remove(&source_id);
        }
    }
}

impl Drop for DynamicPlayer {
    fn drop(&mut self) {
        // Stop and join the platform callback's ownership before releasing stable source addresses.
        self.output.take();
        self.sources.clear();
    }
}

impl DeviceOutput {
    fn open_dynamic<E>(mut renderer: AudioRenderer, on_error: E) -> Result<Self, OutputError>
    where
        E: FnMut(cpal::Error) + Send + 'static,
    {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
        let supported = device.default_output_config()?;
        let sample_format = supported.sample_format();
        let supported_buffer = supported.buffer_size();
        let mut config: StreamConfig = supported.into();
        let target_frames = (config.sample_rate / 100).max(1);
        let requested_buffer_frames = match supported_buffer {
            SupportedBufferSize::Range { min, max } => Some(target_frames.clamp(*min, *max)),
            SupportedBufferSize::Unknown => None,
        };
        config.buffer_size = requested_buffer_frames
            .map(BufferSize::Fixed)
            .unwrap_or(BufferSize::Default);
        let spec = OutputSpec {
            sample_rate: config.sample_rate,
            channels: usize::from(config.channels),
            requested_buffer_frames,
        };
        let stream = match sample_format {
            SampleFormat::F32 => device.build_output_stream(
                config,
                move |samples: &mut [f32], _| {
                    renderer.render_prepared(samples, spec.sample_rate, spec.channels);
                },
                on_error,
                None,
            )?,
            SampleFormat::I16 => device.build_output_stream(
                config,
                move |samples: &mut [i16], _| {
                    renderer.render_prepared_i16(samples, spec.sample_rate, spec.channels);
                },
                on_error,
                None,
            )?,
            SampleFormat::U16 => device.build_output_stream(
                config,
                move |samples: &mut [u16], _| {
                    renderer.render_prepared_u16(samples, spec.sample_rate, spec.channels);
                },
                on_error,
                None,
            )?,
            other => return Err(OutputError::UnsupportedFormat(other)),
        };
        stream.play()?;
        Ok(Self { stream, spec })
    }

    /// Opens the system default device without routing audio through a WebView.
    ///
    /// The callback runs on CoreAudio/AAudio/WASAPI/ALSA's realtime thread. It must not allocate,
    /// lock, perform I/O or call Tauri. Current Apple and Android output paths expose native f32;
    /// another format is rejected rather than allocating a conversion buffer in the callback.
    pub fn open_default<F, E>(mut render: F, on_error: E) -> Result<Self, OutputError>
    where
        F: FnMut(&mut [f32], OutputSpec) + Send + 'static,
        E: FnMut(cpal::Error) + Send + 'static,
    {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
        let supported = device.default_output_config()?;
        if supported.sample_format() != SampleFormat::F32 {
            return Err(OutputError::UnsupportedFormat(supported.sample_format()));
        }
        let supported_buffer = supported.buffer_size();
        let mut config: StreamConfig = supported.into();
        // Ten milliseconds leaves room for command dispatch and the hardware queue under the
        // 20 ms warm-transport target. Clamp to the device's advertised range instead of forcing
        // an unsupported quantum; backends that cannot report a range keep their native default.
        let target_frames = (config.sample_rate / 100).max(1);
        let requested_buffer_frames = match supported_buffer {
            SupportedBufferSize::Range { min, max } => Some(target_frames.clamp(*min, *max)),
            SupportedBufferSize::Unknown => None,
        };
        config.buffer_size = requested_buffer_frames
            .map(BufferSize::Fixed)
            .unwrap_or(BufferSize::Default);
        let spec = OutputSpec {
            sample_rate: config.sample_rate,
            channels: usize::from(config.channels),
            requested_buffer_frames,
        };
        let stream = device.build_output_stream(
            config,
            move |samples: &mut [f32], _| render(samples, spec),
            on_error,
            None,
        )?;
        stream.play()?;
        Ok(Self { stream, spec })
    }

    pub const fn spec(&self) -> OutputSpec {
        self.spec
    }

    pub fn play(&self) -> Result<(), OutputError> {
        self.stream.play()?;
        Ok(())
    }

    pub fn pause(&self) -> Result<(), OutputError> {
        self.stream.pause()?;
        Ok(())
    }
}
