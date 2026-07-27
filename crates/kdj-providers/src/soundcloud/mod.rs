//! SoundCloud provider。
//!
//! Python 版是 yt-dlp 的一层壳（**15MB** 依赖，还捎带 curl-cffi / deno）。
//! 这里直接打 api-v2：`client_id` 从首页的 JS bundle 里抓，
//! 曲目的 `media.transcodings[]` 里挑 progressive（MP3 直链），
//! 拿授权地址换到真正的 CDN URL 就能直接流式下载。
//!
//! SoundCloud 没有扫码登录，账号态只反映"设置里有没有打开这个开关"。

pub mod provider;

pub use provider::SoundCloudProvider;
