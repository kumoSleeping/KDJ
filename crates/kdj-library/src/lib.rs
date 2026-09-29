//! 曲库层：SQLite 存储、查询过滤、扫描入库、文件夹管理、和声推荐。

pub mod camelot;
pub mod db;
pub mod folders;
pub mod scan;
pub mod service;
pub mod rhythm;
#[cfg(test)]
#[path = "../../test-support/peak_alloc.rs"]
mod peak_alloc;

pub use db::Database;
pub use service::LibraryService;
