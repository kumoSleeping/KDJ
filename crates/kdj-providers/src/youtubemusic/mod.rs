//! YouTube Music provider（InnerTube API + 独立浏览器 Cookie 会话）。

pub mod auth;
pub mod client;
pub mod decipher;
pub mod provider;

pub use provider::{gvs_playback_request, YoutubeMusicProvider};
