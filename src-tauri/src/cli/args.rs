use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

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
    /// 输出机器可读的 CLI 能力摘要，不需要启动 KDJ
    Spec,
    /// 查看驻留进程与版本状态
    Status,
    /// 显示主窗口
    #[command(visible_alias = "ui")]
    Show,
    /// 真正退出 KDJ 驻留进程
    Quit,
    /// 查询、管理和分析本地曲库
    Library {
        #[command(subcommand)]
        command: LibraryCmd,
    },
    /// 搜索在线歌曲或集合
    Search {
        query: Option<String>,
        #[arg(
            long,
            default_value = "song",
            value_parser = ["song", "playlist", "album", "artist", "radio"]
        )]
        kind: String,
        #[arg(long)]
        platform: Option<String>,
        #[arg(long)]
        no_merge: bool,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// 只返回平台及搜索能力，不需要关键词
        #[arg(long)]
        capabilities: bool,
        /// 把选中的搜索结果加入下载队列
        #[arg(long)]
        download: bool,
        /// 选择第几条搜索结果，从 1 开始；默认 1，可写 1,3
        #[arg(long, value_delimiter = ',', value_name = "N")]
        pick: Vec<usize>,
        #[command(flatten)]
        transfer: DownloadFlowArgs,
    },
    /// 读取歌单/专辑等集合；加 --download 复用同一命令下载
    Collection {
        #[arg(long)]
        platform: String,
        #[arg(
            long,
            value_parser = ["playlist", "album", "artist", "radio"]
        )]
        kind: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        download: bool,
        #[command(flatten)]
        transfer: DownloadFlowArgs,
    },
    /// 解析分享链接；加 --download 复用同一命令下载
    Resolve {
        #[arg(value_name = "URL")]
        input: String,
        #[arg(long)]
        download: bool,
        #[command(flatten)]
        transfer: DownloadFlowArgs,
    },
    /// 查看下载落点、开始、等待或管理队列
    Download {
        #[command(subcommand)]
        command: DownloadCmd,
    },
    /// 查找适合接播的本地曲目
    Mix {
        #[command(subcommand)]
        command: MixCmd,
    },
    /// 管理 KDJ 曲库文件夹
    Folder {
        #[command(subcommand)]
        command: FolderCmd,
    },
    /// 读取或修改 CLI 可管理的设置
    Settings {
        #[command(subcommand)]
        command: SettingsCmd,
    },
    /// 管理平台账号、登录与账号歌单
    Account {
        #[command(subcommand)]
        command: AccountCmd,
    },
}

/// 所有产生下载任务的入口共用同一组控制参数。
#[derive(Debug, Clone, Args)]
pub struct DownloadFlowArgs {
    /// 侧栏文件夹唯一名称、绝对路径，或 default
    #[arg(long, value_name = "FOLDER")]
    pub to: Option<String>,
    /// 下载音质
    #[arg(long, value_parser = ["flac", "320", "128"])]
    pub quality: Option<String>,
    /// 下载完成后不自动分析
    #[arg(long)]
    pub no_analyze: bool,
    /// 入队后立即放行当前下载队列
    #[arg(long)]
    pub start: bool,
    /// 自动开始并等待本次任务全部结束；结果包含最终文件路径
    #[arg(long)]
    pub wait: bool,
    /// 等待下载的最长秒数（默认 3600）
    #[arg(long, value_name = "SECONDS")]
    pub timeout: Option<u64>,
}

#[derive(Debug, Subcommand)]
pub enum LibraryCmd {
    /// 按文本、调性、BPM、能量或文件夹筛选
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
    /// 按 id、精确路径或唯一文本匹配取得一首歌
    Get {
        #[arg(long)]
        id: Option<i64>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        q: Option<String>,
    },
    /// 返回曲库统计
    Stats,
    /// 移动曲目文件并更新曲库
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
    /// 只移除曲库记录，不删磁盘文件
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
    /// 彻底删除曲库记录和磁盘文件
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
    /// 撤销上一次文件夹操作
    Undo,
    /// 扫描一个或多个本地路径
    Scan {
        paths: Vec<String>,
        #[arg(long)]
        analyze: bool,
    },
    /// 分析指定 id；不传 id 时分析待分析曲目
    Analyze {
        #[arg(long)]
        id: Vec<i64>,
        #[arg(long)]
        force: bool,
        /// v1=完整分析，v2/v3=指定 BPM/调性算法代际
        #[arg(long, default_value = "v1", value_parser = ["v1", "v2", "v3"])]
        version: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum DownloadCmd {
    /// 列出可用下载落点
    #[command(visible_alias = "dests")]
    Destinations,
    /// 列出下载任务
    #[command(visible_alias = "ls")]
    List,
    /// 开始当前队列，可选择等待并返回最终路径
    Start {
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 3600, value_name = "SECONDS")]
        timeout: u64,
    },
    /// 等待指定任务；不传 id 时等待当前队列
    Wait {
        #[arg(value_name = "ID")]
        id: Vec<String>,
        #[arg(long, default_value_t = 3600, value_name = "SECONDS")]
        timeout: u64,
    },
    Cancel {
        id: String,
    },
    /// 取消全部排队中或运行中的任务
    CancelAll,
    Retry {
        id: String,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 3600, value_name = "SECONDS")]
        timeout: u64,
    },
    /// 从队列记录中移除一个已结束任务
    Remove {
        id: String,
    },
    /// 清理全部已结束任务记录
    Clear,
}

#[derive(Debug, Subcommand)]
pub enum MixCmd {
    /// 以一首本地曲目为基准查找和谐接播候选
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
}

#[derive(Debug, Subcommand)]
pub enum FolderCmd {
    /// 返回曲库文件夹树
    Tree,
    /// 创建文件夹
    #[command(visible_alias = "mkdir")]
    Create {
        #[arg(long)]
        parent: String,
        #[arg(long)]
        name: String,
    },
    /// 重命名文件夹
    Rename {
        #[arg(long)]
        path: String,
        #[arg(long)]
        name: String,
    },
    /// 移动文件夹
    #[command(visible_alias = "mv")]
    Move {
        #[arg(long)]
        path: String,
        #[arg(long)]
        to: String,
    },
    /// 删除空文件夹
    #[command(visible_alias = "rmdir")]
    Remove {
        #[arg(long)]
        path: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum SettingsCmd {
    /// 读取设置
    Get,
    /// 更新下载目录或文件名模板
    Set {
        #[arg(long)]
        download_dir: Option<String>,
        #[arg(long)]
        filename_template: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum AccountCmd {
    /// 列出账号状态和登录方式
    #[command(visible_alias = "ls")]
    List,
    /// 创建二维码登录会话，返回 URL / PNG data URL
    Login {
        #[arg(long, value_parser = ["wyy", "qqm", "bilibili"])]
        platform: String,
    },
    /// 查询或等待二维码登录结果
    LoginStatus {
        #[arg(long, value_parser = ["wyy", "qqm", "bilibili"])]
        platform: String,
        #[arg(long)]
        session: String,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 180, value_name = "SECONDS")]
        timeout: u64,
    },
    /// 退出指定平台账号
    Logout {
        #[arg(long)]
        platform: String,
    },
    /// 列出指定账号的歌单
    Playlists {
        #[arg(long)]
        platform: String,
    },
    /// 读取账号歌单；加 --download 复用同一命令下载
    Playlist {
        #[arg(long)]
        platform: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        download: bool,
        #[command(flatten)]
        transfer: DownloadFlowArgs,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_keeps_global_url_separate_from_input_url() {
        let cli = Cli::try_parse_from([
            "kdj",
            "resolve",
            "https://music.example/item",
            "--url",
            "http://127.0.0.1:43123",
        ])
        .unwrap();
        assert_eq!(cli.url.as_deref(), Some("http://127.0.0.1:43123"));
        let Commands::Resolve {
            input, download, ..
        } = cli.command
        else {
            panic!("expected resolve");
        };
        assert_eq!(input, "https://music.example/item");
        assert!(!download);
    }

    #[test]
    fn collection_reuses_the_shared_download_flow() {
        let cli = Cli::try_parse_from([
            "kdj",
            "collection",
            "--platform",
            "wyy",
            "--kind",
            "playlist",
            "--key",
            "42",
            "--download",
            "--to",
            "House",
            "--quality",
            "320",
            "--wait",
            "--timeout",
            "90",
        ])
        .unwrap();
        let Commands::Collection {
            download, transfer, ..
        } = cli.command
        else {
            panic!("expected collection");
        };
        assert!(download);
        assert_eq!(transfer.to.as_deref(), Some("House"));
        assert_eq!(transfer.quality.as_deref(), Some("320"));
        assert!(transfer.wait);
        assert_eq!(transfer.timeout, Some(90));
    }

    #[test]
    fn search_can_plan_selected_results_with_the_same_download_options() {
        let cli = Cli::try_parse_from([
            "kdj",
            "search",
            "Around the World",
            "--platform",
            "wyy",
            "--download",
            "--pick",
            "1,3",
            "--to",
            "House",
            "--wait",
        ])
        .unwrap();
        let Commands::Search {
            download,
            pick,
            transfer,
            ..
        } = cli.command
        else {
            panic!("expected search");
        };
        assert!(download);
        assert_eq!(pick, vec![1, 3]);
        assert_eq!(transfer.to.as_deref(), Some("House"));
        assert!(transfer.wait);
    }

    #[test]
    fn skill_export_is_not_a_command_anymore() {
        assert!(Cli::try_parse_from(["kdj", "skill", "export", "--to", "codex"]).is_err());
    }
}
