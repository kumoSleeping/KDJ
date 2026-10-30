//! Local media rendering: the song visualizer's export (encoded by the window, put into an MP4
//! by kdj-media). `media` is what is left of the FFmpeg probing the CLI's peek still uses.
pub mod audio_visualizer;
pub(crate) mod media;
