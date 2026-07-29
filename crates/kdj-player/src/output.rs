use std::fmt;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, Stream, StreamConfig, SupportedBufferSize};

use crate::{command_channel, DecodedTrack, PlayerController};

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

impl DeviceOutput {
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
