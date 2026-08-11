//! KDJ 的公共内核：前后端契约模型、运行期配置、事件广播、通用工具。
//!
//! 这一层不碰网络、不碰数据库，provider / analysis / library / server 都依赖它。

pub mod config;
pub mod events;
pub mod models;
pub mod musical_key;
pub mod paths;

pub use config::{AppConfig, Settings};
pub use events::EventHub;
pub use models::*;

/// 版本号跟着 Cargo.toml 走，`/api/health` 直接回这个。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
