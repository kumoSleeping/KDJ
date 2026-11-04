//! Local media rendering: `.kdjv` video projects (workshop/kdjv.rs) and the song visualizer's
//! export. Pictures are encoded by the window and put into an MP4 by kdj-media; nothing here
//! runs FFmpeg.
pub mod audio_visualizer;
pub mod workshop;
pub(crate) mod media;

fn entry_id() -> String {
    format!(
        "{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    )
}
