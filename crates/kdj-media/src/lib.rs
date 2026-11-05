//! Media containers and audio encoding without FFmpeg.
//!
//! - [`mp4`]: reading MP4 / M4A / DASH fragments and writing faststart MP4 by stream copy.
//! - [`remux`]: the download steps (merge DASH tracks, take out the audio, apply the offset).
//! - [`h264`] and [`export`]: an encoder's Annex B GOPs into an MP4 video track.
//! - [`aac`]: the system AAC encoders; [`audio`] and [`pcm`] feed them from any song
//!   symphonia decodes.
//! - [`flv`]: 哔哩哔哩's single-stream FLV (H.264 with AAC or MP3) into MP4 by stream copy.
//! - [`webm`]: WebM Opus into Ogg Opus.
//! - [`probe`]: what a file holds (picture size, rate, colour, sound, lengths) from its container.
//! - [`stretch`]: sound played faster or slower at its own pitch (WSOLA).
//! - [`mix`]: the sample loops of a project's sound mix (16-bit PCM, a clip at one gain, the limiter).

mod bits;
pub mod aac;
pub mod audio;
pub mod export;
pub mod flv;
pub mod h264;
pub mod mix;
pub mod mp4;
pub mod pcm;
pub mod probe;
pub mod remux;
pub mod stretch;
pub mod webm;
