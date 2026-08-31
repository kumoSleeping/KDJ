//! KDJ 的公共内核：前后端契约模型、运行期配置、事件广播、通用工具。
//!
//! 这一层不碰网络、不碰数据库，provider / analysis / library / server 都依赖它。

pub mod config;
pub mod events;
pub mod models;
pub mod musical_key;
pub mod paths;
pub mod thread_qos;
pub mod work_scheduler;

pub use config::{AppConfig, OnlineVideoPlayer, Settings};
pub use events::EventHub;
pub use models::*;

/// 版本号跟着 Cargo.toml 走，`/api/health` 直接回这个。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Install the single rustls crypto provider used by every KDJ HTTP client.
///
/// reqwest 0.13's `rustls-no-provider` feature deliberately leaves this choice
/// to the application. Keeping it here lets all binaries and library tests use
/// ring without also linking the substantially larger AWS-LC implementation.
#[cfg(feature = "rustls-ring")]
pub fn ensure_rustls_ring() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // A concurrent caller may win the race after the check. Either way a
        // process-wide provider is installed when this function returns.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}
