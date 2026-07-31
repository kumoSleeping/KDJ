//! QQ 音乐 provider。

pub mod client;
pub mod login;
pub mod mqtt_ws;
pub mod provider;

pub use provider::QqMusicProvider;
