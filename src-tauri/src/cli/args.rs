use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "kdj", version = kdj_core::VERSION, about = "KDJ 曲库与下载 CLI")]
pub struct Cli {
    /// 覆盖发现到的驻留地址（调试用）
    #[arg(long, global = true)]
    pub url: Option<String>,
    /// 覆盖 data_dir，用来找 runtime.json
    #[arg(long, global = true, value_name = "DIR")]
    pub data_dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    Spec,
    Status,
    Ui,
    Quit,
    Skill {
        #[command(subcommand)]
        command: SkillCmd,
    },
    Library {
        #[command(subcommand)]
        command: LibraryCmd,
    },
    Search {
        query: Option<String>,
        #[arg(long, default_value = "song")]
        kind: String,
        #[arg(long)]
        platform: Option<String>,
        #[arg(long)]
        no_merge: bool,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        capabilities: bool,
    },
    Collection {
        #[command(subcommand)]
        command: CollectionCmd,
    },
    Resolve {
        url: String,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        download: bool,
    },
    Download {
        #[command(subcommand)]
        command: DownloadCmd,
    },
    Mix {
        #[command(subcommand)]
        command: MixCmd,
    },
    Folder {
        #[command(subcommand)]
        command: FolderCmd,
    },
    Settings {
        #[command(subcommand)]
        command: SettingsCmd,
    },
    Account {
        #[command(subcommand)]
        command: AccountCmd,
    },
}

#[derive(Debug, Subcommand)]
pub enum SkillCmd {
    /// 覆盖写入各家 skills/kdj/SKILL.md
    Export {
        /// cursor / claude / codex / pi，或任意文件夹
        #[arg(long)]
        to: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum LibraryCmd {
    List {
        #[arg(long)]
        q: Option<String>,
        #[arg(long)]
        key: Option<String>,
        /// 例如 124..130
        #[arg(long)]
        bpm: Option<String>,
        #[arg(long)]
        energy: Option<i64>,
        #[arg(long)]
        folder: Option<String>,
        #[arg(long)]
        analyzed: Option<bool>,
        #[arg(long, default_value_t = 50)]
        limit: i64,
        #[arg(long, default_value_t = 0)]
        offset: i64,
    },
    Get {
        #[arg(long)]
        id: Option<i64>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        q: Option<String>,
    },
    Stats,
    Move {
        #[arg(long)]
        id: Vec<i64>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        q: Option<String>,
        #[arg(long)]
        to: String,
        #[arg(long)]
        dry_run: bool,
    },
    Forget {
        #[arg(long)]
        id: Vec<i64>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        q: Option<String>,
        #[arg(long)]
        folder: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
    Delete {
        #[arg(long)]
        id: Vec<i64>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        q: Option<String>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    Undo,
    Scan {
        paths: Vec<String>,
        #[arg(long)]
        analyze: bool,
    },
    Analyze {
        #[arg(long)]
        id: Vec<i64>,
        #[arg(long)]
        pending: bool,
        #[arg(long)]
        force: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum CollectionCmd {
    Get {
        #[arg(long)]
        platform: String,
        #[arg(long)]
        kind: String,
        #[arg(long)]
        key: String,
    },
    Download {
        #[arg(long)]
        platform: String,
        #[arg(long)]
        kind: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        quality: Option<String>,
        #[arg(long)]
        no_analyze: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum DownloadCmd {
    Dests,
    Ls,
    Enqueue {
        #[arg(long)]
        platform: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        quality: Option<String>,
    },
    Start,
    Cancel {
        id: String,
    },
    Retry {
        id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum MixCmd {
    Next {
        #[arg(long)]
        id: Option<i64>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        q: Option<String>,
        #[arg(long, default_value_t = 12.0)]
        bpm_tolerance: f64,
        #[arg(long, default_value_t = 12)]
        limit: usize,
        #[arg(long)]
        folder: Option<String>,
    },
    Query {
        #[arg(long)]
        bpm: Option<String>,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        energy: Option<i64>,
        #[arg(long)]
        folder: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: i64,
    },
}

#[derive(Debug, Subcommand)]
pub enum FolderCmd {
    Tree,
    Mkdir {
        #[arg(long)]
        parent: String,
        #[arg(long)]
        name: String,
    },
    Rename {
        #[arg(long)]
        path: String,
        #[arg(long)]
        name: String,
    },
    Mv {
        #[arg(long)]
        path: String,
        #[arg(long)]
        to: String,
    },
    Rmdir {
        #[arg(long)]
        path: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum SettingsCmd {
    Get,
    Set {
        #[arg(long)]
        download_dir: Option<String>,
        #[arg(long)]
        filename_template: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum AccountCmd {
    Ls,
    Playlists {
        #[arg(long)]
        platform: String,
    },
    Playlist {
        #[command(subcommand)]
        command: AccountPlaylistCmd,
    },
}

#[derive(Debug, Subcommand)]
pub enum AccountPlaylistCmd {
    Get {
        #[arg(long)]
        platform: String,
        #[arg(long)]
        key: String,
    },
    Download {
        #[arg(long)]
        platform: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        to: Option<String>,
    },
}
