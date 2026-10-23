use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "kdj", version = kdj_core::VERSION, about = "KDJ CLI：搜索、下载、登录与曲库查询")]
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
    /// 用法、账号、浏览器、账号歌单、下载位置；KDJ 没在运行时也能读取
    Status,
    /// 和 KDJ 搜索框一样：关键词、分享链接或 status/search 给出的引用
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
    Download {
        /// 引用、链接或集合引用，可多个
        #[arg(required = true, value_name = "REF")]
        refs: Vec<String>,
        /// 目标文件夹的绝对路径（须在曲库根目录内）；默认下载文件夹
        #[arg(long, value_name = "DIR")]
        to: Option<String>,
        /// 歌曲音质
        #[arg(long, value_parser = ["flac", "320", "128"])]
        quality: Option<String>,
        /// 视频保留完整画面（video，默认）或只要音轨（audio）
        #[arg(long = "as", value_parser = ["audio", "video"])]
        as_kind: Option<String>,
        /// 视频最高画面高度，例如 1080
        #[arg(long)]
        height: Option<i64>,
    },
    /// 登录平台，完成、失败或过期才返回；中断命令即放弃
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
    /// 截取视频画面；在线 B 站视频不用下载
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
        #[arg(long)]
        width: Option<u32>,
    },
    /// 把视频对齐到参考曲，返回几套定位方案；在线 B 站视频只读音轨
    Align {
        /// 参考曲：曲库 id 或音频文件路径
        #[arg(long = "ref", value_name = "REF")]
        reference: String,
        /// 视频：曲库 id、文件路径、bilibili 引用或链接
        #[arg(long)]
        video: String,
    },
    /// 查询本地曲库
    Library {
        #[command(subcommand)]
        command: LibraryCmd,
    },
    /// .kdjv 视频工程（docs/kdjv.md）
    Project {
        #[command(subcommand)]
        command: ProjectCmd,
    },
    /// 可视化：不经编辑器，用歌曲封面和默认样式出画面
    Visualizer {
        #[command(subcommand)]
        command: VisualizerCmd,
    },
}

#[derive(Debug, Subcommand)]
pub enum VisualizerCmd {
    /// 给曲库里的一首歌渲染整首的可视化 MP4（30 fps；偶数宽高，320×180 至 2560×1440）；不覆盖已有文件，全部结束才返回
    Render {
        /// 曲库 id
        id: i64,
        /// 输出的 .mp4 绝对路径（文件夹要已存在）
        #[arg(long)]
        out: String,
        #[arg(long)]
        width: Option<u32>,
        #[arg(long)]
        height: Option<u32>,
    },
}

#[derive(Debug, Subcommand)]
pub enum ProjectCmd {
    /// 打开一个 .kdjv 工程：标题、时长、画布、素材，是否已渲染好；不能播放时说明原因
    Check {
        /// .kdjv 文件路径
        path: String,
    },
    /// 渲染好一个 .kdjv 工程，之后在 KDJ 里立即播放；全部结束才返回，中断命令不取消渲染
    Render {
        /// .kdjv 文件路径
        path: String,
    },
    /// 用剪辑操作改 .kdjv 工程（自由轨道，docs/kdjv.md「格式 3」；格式 1、2 的工程第一次改时转成格式 3）：按顺序做完，能播放才写回；返回工程和每条轨道上片段的位置
    Edit {
        /// .kdjv 文件路径
        path: String,
        /// 操作列表（JSON 数组），如 [{"op":"add","clip":{"src":"/a.mp4","in":0,"out":10},"kind":"picture","at":12}]
        #[arg(long)]
        ops: String,
        /// 文件还没有时新建
        #[arg(long)]
        create: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum LibraryCmd {
    /// 按文本、调性、BPM、能量或文件夹筛选；不触发分析
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
        /// 文件夹绝对路径，包含子文件夹
        #[arg(long)]
        folder: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: i64,
        #[arg(long, default_value_t = 0)]
        offset: i64,
    },
    /// 曲目详情；缺少分析时当场补齐再返回
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
        ] {
            assert!(Cli::try_parse_from(retired).is_err(), "{retired:?}");
        }
    }
}
