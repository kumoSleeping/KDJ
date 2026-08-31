//! 哔哩哔哩 provider。

pub mod client;
pub mod login;
pub mod provider;
pub mod streams;
pub mod url;
pub mod wbi;

pub use crate::provider::VideoPreviewStream as PreviewStream;
pub use provider::BilibiliProvider;

/// 目标高度 → B 站的 qn 编号。传得比实际能拿到的高没关系，
/// 服务端会降到账号权限允许的最高档。
pub fn qn_for_height(max_height: i64) -> i64 {
    match max_height {
        h if h <= 360 => 16,
        h if h <= 480 => 32,
        h if h <= 720 => 64,
        // 100/112/116 都是 1080 高度但码率更高，用 116 当上界可以把它们放进来
        h if h <= 1080 => 116,
        h if h <= 2160 => 120,
        _ => 127,
    }
}

/// 交互预览使用较保守的档位：1080P 只请求普通 1080（qn=80），不把同高度的
/// 60fps/高码率档一起塞进 durl。下载仍走 `qn_for_height`，不降低成品质量。
pub fn preview_qn_for_height(max_height: i64) -> i64 {
    match max_height {
        h if h <= 360 => 16,
        h if h <= 480 => 32,
        h if h <= 720 => 64,
        h if h <= 1080 => 80,
        // 单文件预览在高于 1080 时仍以普通 1080 为上限；4K/HDR 的收益远小于
        // WebView 首帧延迟和内存压力，完整画质留给下载流程。
        _ => 80,
    }
}

#[cfg(test)]
mod tests {
    use super::{preview_qn_for_height, qn_for_height};

    #[test]
    fn qn_ladder_covers_every_tier() {
        assert_eq!(qn_for_height(360), 16);
        assert_eq!(qn_for_height(480), 32);
        assert_eq!(qn_for_height(720), 64);
        assert_eq!(qn_for_height(1080), 116, "要能拿到 1080P60/高码率");
        assert_eq!(qn_for_height(2160), 120);
        assert_eq!(qn_for_height(4320), 127);
    }

    #[test]
    fn preview_ladder_avoids_high_bitrate_durl() {
        assert_eq!(preview_qn_for_height(720), 64);
        assert_eq!(preview_qn_for_height(1080), 80);
        assert_eq!(preview_qn_for_height(2160), 80);
    }
}
