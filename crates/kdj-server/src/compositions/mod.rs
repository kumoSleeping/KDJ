//! Local media rendering: `.kdjv` video projects (workshop/kdjv.rs) and the audio visualizer
//! export, over shared FFmpeg probing and encoder selection.
mod acceleration;
mod frame_pipe;
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
