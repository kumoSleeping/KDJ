//! 普通 YouTube 视频 provider。内容、账号与会话都和 YouTube Music 分开。

mod client;
mod provider;

pub use provider::YoutubeProvider;
