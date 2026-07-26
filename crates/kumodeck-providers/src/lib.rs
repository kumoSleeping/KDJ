//! 各音乐/视频平台的 provider 实现，统一在 [`provider::MusicProvider`] trait 之后。

pub mod bilibili;
pub mod ffmpeg;
pub mod net;
pub mod tags;
pub mod netease;
pub mod provider;
pub mod soundcloud;
pub mod qqmusic;

pub use provider::{
    Capabilities, DownloadJob, MusicProvider, ProgressSink, ProviderContext,
};
