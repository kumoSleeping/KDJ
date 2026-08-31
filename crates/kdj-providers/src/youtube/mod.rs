//! 普通 YouTube 视频 provider。内容、账号与会话都和 YouTube Music 分开。

mod client;
mod hls_download;
mod provider;

pub use client::{valid_browser_user_agent, valid_proof_token, ProtectedHlsContext, VideoFormat};
pub use provider::YoutubeProvider;
