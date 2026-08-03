//! SoundCloud provider。
//!
//! Python 版是 yt-dlp 的一层壳（**15MB** 依赖，还捎带 curl-cffi / deno）。
//! 这里直接打 api-v2：`client_id` 从首页的 JS bundle 里抓，
//! 曲目的 `media.transcodings[]` 里挑 progressive（MP3 直链），
//! 拿授权地址换到真正的 CDN URL 就能直接流式下载。
//!
//! SoundCloud 使用 OAuth 2.1 + PKCE 登录，公开搜索仍可在未登录时使用。

pub mod provider;

pub use provider::{OAuthStatus, SoundCloudProvider};
