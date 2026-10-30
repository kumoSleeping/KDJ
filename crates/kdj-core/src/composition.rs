//! Shared media-render contracts: the encoder a render prefers.
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
