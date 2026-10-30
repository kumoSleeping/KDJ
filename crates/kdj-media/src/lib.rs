//! Media containers and audio encoding without FFmpeg.
//!
//! - [`mp4`]: reading MP4 / M4A / DASH fragments and writing faststart MP4 by stream copy.
//! - [`remux`]: the download steps (merge DASH tracks, take out the audio, apply the offset).
//! - [`h264`] and [`export`]: an encoder's Annex B GOPs into an MP4 video track.
//! - [`aac`]: the system AAC encoders; [`audio`] and [`pcm`] feed them from any song
//!   symphonia decodes.
//! - [`webm`]: WebM Opus into Ogg Opus.

mod bits;
pub mod aac;
pub mod audio;
pub mod export;
pub mod h264;
pub mod mp4;
pub mod pcm;
pub mod remux;
pub mod webm;
