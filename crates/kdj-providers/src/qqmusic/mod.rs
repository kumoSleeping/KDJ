//! QQ 音乐 provider。

pub mod client;
pub mod error;
mod media;
pub use media::valid_audio_prefix;
pub mod login;
pub mod mqtt_ws;
pub mod provider;

pub use provider::QqMusicProvider;

#[cfg(test)]
mod test_support;
