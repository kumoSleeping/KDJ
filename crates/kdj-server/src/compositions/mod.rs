//! Local media rendering: the audio visualizer export, over shared FFmpeg probing and encoder
//! selection.
mod acceleration;
mod frame_pipe;
pub mod running;
pub mod audio_visualizer;
pub(crate) mod media;
