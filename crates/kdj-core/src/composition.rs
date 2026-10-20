//! Shared media-render contracts: the encoder a render prefers, and a matched span between a
//! song and a video (where the video's picture starts playing under the song).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncodingAcceleration {
    #[default]
    Auto,
    Software,
    VideoToolbox,
    Nvidia,
    Intel,
    Amd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompositionVideoSection {
    pub audio_start_ms: i64,
    pub video_start_ms: i64,
    pub duration_ms: i64,
}
