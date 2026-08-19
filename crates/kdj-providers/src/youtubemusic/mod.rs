//! YouTube Music provider（InnerTube API + Google OAuth 设备码登录）。

pub mod auth;
pub mod client;
pub mod decipher;
pub mod provider;

pub use provider::YoutubeMusicProvider;
