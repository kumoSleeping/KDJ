use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// 每个子命令的 --help 末尾都带上：输出格式和退出码。
const AFTER_HELP: &str = "\
输出：stdout 一行 JSON。成功 {\"ok\":true,\"data\":…}；失败 {\"ok\":false,\"error\":{\"code\",\"message\",\"hint\"?,\"candidates\"?}}。
error.code：usage（参数不对）、not_found（找不到）、ambiguous（不止一个，见 candidates）、failed（其余失败）。
退出码：0 成功；1 not_found / ambiguous / failed；2 usage。
KDJ 没在运行时，除 status 外的命令会在后台拉起它（不开窗口）。先运行 kdj status 看账号、默认下载目录和曲库。";

#[derive(Debug, Parser)]
#[command(
    name = "kdj",
    version = kdj_core::VERSION,
    about = "KDJ 命令行：帮你找歌和视频、下载、截帧、查曲库",
    after_help = AFTER_HELP
)]
pub struct Cli {
    /// 覆盖发现到的驻留地址（调试用）
    #[arg(long, global = true, hide = true)]
    pub url: Option<String>,
    /// 覆盖 data_dir，用来找 runtime.json
    #[arg(long, global = true, value_name = "DIR", hide = true)]
    pub data_dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// 用法、各平台登录状态、浏览器、账号歌单、默认下载目录（download.default_dir）和曲库根目录；KDJ 没在运行时也能读取
    #[command(after_help = AFTER_HELP)]
    Status,
    /// 和 KDJ 搜索框一样：关键词、分享链接或 status/search 给出的引用
    #[command(after_help = AFTER_HELP)]
    Search {
        /// 关键词、链接或引用
        text: String,
        /// 关键词搜索的类型；链接和引用自动识别
        #[arg(long, default_value = "song", value_parser = ["song", "playlist", "album", "artist", "radio"])]
        kind: String,
        /// 只搜这些平台，逗号分隔；默认用 KDJ 设置里的搜索平台
        #[arg(long, value_delimiter = ',')]
        platform: Vec<String>,
        /// 每个平台的结果数
        #[arg(long)]
        limit: Option<usize>,
    },
    /// 立即下载，全部结束才返回；中断命令即取消
    #[command(after_help = AFTER_HELP)]
    Download {
        /// 引用、链接或集合引用，可多个
        #[arg(required = true, value_name = "REF")]
        refs: Vec<String>,
        /// 下载到这个文件夹（绝对路径，须已存在且在曲库根目录 download.library_roots 之内）；默认是 status 的 download.default_dir
        #[arg(long, value_name = "DIR")]
        to: Option<String>,
        /// 歌曲音质
        #[arg(long, value_parser = ["flac", "320", "128"])]
        quality: Option<String>,
        /// 视频保留完整画面（video，默认）或只要音轨（audio）
        #[arg(long = "as", value_parser = ["audio", "video"])]
        as_kind: Option<String>,
        /// 视频最高画面高度，例如 1080
        #[arg(long, value_name = "PX")]
        height: Option<i64>,
    },
    /// 登录平台，完成、失败或过期才返回；中断命令即放弃
    #[command(after_help = AFTER_HELP)]
    Login {
        /// wyy / qqm / bilibili 默认扫码；youtube / ytm / soundcloud 从本机浏览器导入
        platform: String,
        /// 从这个浏览器导入已有登录（status 的 browsers）
        #[arg(long)]
        browser: Option<String>,
        /// 浏览器 Profile id；默认该浏览器的第一个
        #[arg(long)]
        profile: Option<String>,
    },
    /// 截取视频画面存成 JPEG，返回文件路径；在线 B 站视频不用下载
    #[command(after_help = AFTER_HELP)]
    Peek {
        /// 曲库 id、文件路径、bilibili 引用或链接
        source: String,
        /// 时间点，逗号分隔，秒或 分:秒，例如 75,1:30
        #[arg(long, value_delimiter = ',')]
        at: Vec<String>,
        /// 每隔多少秒截一张（最多 48 张）
        #[arg(long)]
        every: Option<f64>,
        /// 画面宽度（像素），默认 480
        #[arg(long, value_name = "PX")]
        width: Option<u32>,
    },
    /// 查询本地曲库、把文件夹加进曲库
    #[command(after_help = AFTER_HELP)]
    Library {
        #[command(subcommand)]
        command: LibraryCmd,
    },
    /// 歌曲可视化视频
    #[command(after_help = AFTER_HELP)]
    Visualizer {
        #[command(subcommand)]
        command: VisualizerCmd,
    },
}

#[derive(Debug, Subcommand)]
pub enum VisualizerCmd {
    /// 用歌曲内嵌封面和可视化的默认样式，给曲库里的一首歌渲染整首的可视化 MP4（30 fps）；由 KDJ 的窗口渲染（后台运行时窗口隐藏着也行），不覆盖已有文件，全部结束才返回
    #[command(after_help = AFTER_HELP)]
    Render {
        /// 曲库 id（library list / get 的 id）
        id: i64,
        /// 输出的 .mp4 绝对路径（文件夹要已存在）
        #[arg(long, value_name = "MP4")]
        out: String,
        /// 画面宽度，偶数，320–2560；默认 1920
        #[arg(long, value_name = "PX")]
        width: Option<u32>,
        /// 画面高度，偶数，180–1440；默认 1080
        #[arg(long, value_name = "PX")]
        height: Option<u32>,
    },
}

#[derive(Debug, Subcommand)]
pub enum LibraryCmd {
    /// 按文本、调性、BPM、能量或文件夹筛选；不触发分析
    #[command(after_help = AFTER_HELP)]
    List {
        /// 在标题、艺术家、专辑、文件名里找的文本
        #[arg(long)]
        q: Option<String>,
        /// Camelot 调性，例如 8A
        #[arg(long)]
        key: Option<String>,
        /// BPM 或范围，例如 128 或 124..130
        #[arg(long)]
        bpm: Option<String>,
        /// 能量 1–10
        #[arg(long)]
        energy: Option<i64>,
        /// 文件夹绝对路径，包含子文件夹
        #[arg(long)]
        folder: Option<String>,
        /// 最多返回多少首
        #[arg(long, default_value_t = 50)]
        limit: i64,
        /// 跳过前多少首（翻页）
        #[arg(long, default_value_t = 0)]
        offset: i64,
    },
    /// 曲目详情；缺少分析时当场补齐再返回
    #[command(after_help = AFTER_HELP)]
    Get {
        /// 一个或多个 id，逗号分隔
        #[arg(long, value_delimiter = ',')]
        id: Vec<i64>,
        /// 文件的绝对路径
        #[arg(long)]
        path: Option<String>,
        /// 唯一匹配的文本
        #[arg(long)]
        q: Option<String>,
        /// 同时返回每一拍的时间（默认只给小节线）
        #[arg(long)]
        beats: bool,
    },
    /// 把一个文件夹加进曲库，和「添加文件夹」一样：导入其中的歌，并登记为曲库根目录（已在某个根里的不重复登记）
    #[command(after_help = AFTER_HELP)]
    Add {
        /// 文件夹的绝对路径
        path: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_takes_several_refs_and_shared_options() {
        let cli = Cli::try_parse_from([
            "kdj", "download", "wyy:1", "bilibili:BV1xx411c7mD:p2", "--as", "audio", "--height", "720",
        ])
        .unwrap();
        let Commands::Download { refs, as_kind, height, .. } = cli.command else {
            panic!("expected download");
        };
        assert_eq!(refs, vec!["wyy:1", "bilibili:BV1xx411c7mD:p2"]);
        assert_eq!(as_kind.as_deref(), Some("audio"));
        assert_eq!(height, Some(720));
    }

    #[test]
    fn search_keeps_global_url_separate_from_input_url() {
        let cli = Cli::try_parse_from([
            "kdj",
            "search",
            "https://music.example/item",
            "--url",
            "http://127.0.0.1:43123",
        ])
        .unwrap();
        assert_eq!(cli.url.as_deref(), Some("http://127.0.0.1:43123"));
        let Commands::Search { text, .. } = cli.command else {
            panic!("expected search");
        };
        assert_eq!(text, "https://music.example/item");
    }

    #[test]
    fn every_help_names_the_exit_codes() {
        use clap::CommandFactory;
        fn walk(command: &mut clap::Command, path: &str) {
            let help = command.render_long_help().to_string();
            assert!(help.contains("退出码：0 成功"), "{path} --help");
            for sub in command.get_subcommands_mut().filter(|sub| sub.get_name() != "help") {
                let name = format!("{path} {}", sub.get_name());
                walk(sub, &name);
            }
        }
        walk(&mut Cli::command(), "kdj");
    }

    #[test]
    fn retired_commands_are_gone() {
        for retired in [
            &["kdj", "spec"][..],
            &["kdj", "resolve", "https://x"],
            &["kdj", "folder", "tree"],
            &["kdj", "mix", "next", "--id", "1"],
            &["kdj", "library", "delete", "--id", "1", "--yes"],
            &["kdj", "library", "analyze"],
            &["kdj", "account", "list"],
            &["kdj", "quit"],
            &["kdj", "align", "--ref", "1", "--video", "2"],
            &["kdj", "project", "check", "a.kdjv"],
        ] {
            assert!(Cli::try_parse_from(retired).is_err(), "{retired:?}");
        }
    }
}
