//! 曲库层：SQLite 存储、查询过滤、扫描入库、文件夹管理、和声推荐。

pub mod camelot;
pub mod db;
pub mod folders;
pub mod scan;
pub mod service;

pub use db::Database;
pub use service::LibraryService;
