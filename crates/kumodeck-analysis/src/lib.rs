//! 音频分析：BPM / 调号 / 响度 / 波形。
//!
//! 相对 Python 版最大的结构性变化：**解码不再依赖 ffmpeg 子进程**。
//! symphonia 直接解 mp3/flac/m4a/ogg/wav，所以没装 ffmpeg 的用户也能分析
//! （现状是完全用不了）。

pub mod decode;
pub mod dsp;
pub mod engine;
pub mod key;
pub mod loudness;
pub mod tempo;
pub mod waveform;
