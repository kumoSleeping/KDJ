# Beat This + DJ Grid Fitter 实现说明

## 结论

评估方案可以实现。当前已完成第一阶段的可运行纵切：

```text
Beat This beat/downbeat/logits
          ↓
稳健 beat line 与局部 tempo segment
          ↓
7 个节奏层级候选独立评分
          ↓
固定 / 变速 / 歧义判断
          ↓
当前 DSP BPM 弱权重第二意见
          ↓
多维置信度、warnings、固定 DJ grid
```

这条实验路径不改变应用当前默认分析器，也不进入 Android/iOS 构建。

## 已实现代码

- `crates/kdj-analysis/src/dj_grid.rs`
  - 与检测器无关的 DJ Grid Fitter；
  - Huber IRLS 稳健拟合；
  - 固定/变速/歧义分类；
  - tempo segments；
  - 0.5×、2/3×、0.75×、1×、4/3×、1.5×、2× 候选；
  - beat 覆盖率、grid 占用率、相位中位/P95 误差；
  - downbeat 小节一致性；
  - 多维置信度与 warnings。
- `crates/kdj-analysis/src/beat_this_backend.rs`
  - `beat-this` 1.0.0 + 纯 Rust `rten`；
  - 模型实例复用；
  - 全曲 PCM 推理；
  - 保留 50 fps beat/downbeat 概率；
  - 当前 `analyze_tempo` 作为弱权重第二意见。
- `crates/kdj-analysis/examples/beat_this_grid.rs`
  - 不接数据库即可对真实音频输出完整 JSON，方便先做回归曲库。

## 为什么传统 DSP 只能是弱权重

真实烟测使用 `beat-this-rs` 仓库的小模型与其 swing 样本：

```text
模型拍点层级：约 229.5 BPM
当前 DSP：约 172 BPM
两者关系：约 0.75×
```

若给 DSP agreement 过高权重，0.75× 候选会压过模型实际检测到的四拍 downbeat 结构。
现在 agreement 只占候选总分 3%；它能拆接近平局并产生 `analyzer_disagreement`，但不能
覆盖更强的 beat/downbeat 证据。该样本最终会返回：

```text
predominant_bpm = 229.537
grid_mode = variable
warnings = sparse_detection, variable_tempo, analyzer_disagreement
overall confidence ≈ 0.35
```

重点不是把它强行判成高置信度固定网格，而是正确暴露“两个分析器发生节奏层级冲突，且
整首固定网格拟合不好”。

## 编译与运行

默认分析 crate 不携带模型，也不编译 RTen：

```bash
cargo test -p kdj-analysis
```

启用桌面实验后端：

```bash
cargo check -p kdj-analysis --features beat-this --example beat_this_grid
```

准备 `mel_spectrogram.onnx` 和 `beat_this_small.onnx` 或 `beat_this.onnx` 后：

```bash
cargo run --release -p kdj-analysis \
  --features beat-this \
  --example beat_this_grid -- \
  /path/to/mel_spectrogram.onnx \
  /path/to/beat_this.onnx \
  /path/to/audio.mp3
```

## 已确认的生产接入约束

### Rust 版本

`beat-this` 1.0.0 声明的 MSRV 是 Rust 1.89，项目当前声明 Rust 1.85。实验特性已在
Rust 1.90 上验证，但设为默认分析器前必须二选一：

1. 把项目 MSRV 升到 1.89，并验证三桌面平台及移动端工具链；
2. 维护经过验证的 fork，把 MSRV 与无关 CLI 依赖降下来。

### 模型资源

crates.io 包不包含 ONNX 文件：

- Mel 模型约 270 KB；
- small 模型约 10 MB；
- full FP32 模型约 83 MB。

正式接入需要给模型记录固定版本、SHA-256 和来源。不要在运行时静默使用“最新”权重。
Tauri resource 与首次启动下载都可行，但属于发布体积/离线能力的产品选择。

### 后台任务

Full 模型不能沿用现在“两个分析 worker 各自加载一份模型”的结构。生产实现应持有一个
长生命周期模型实例，由单独队列串行调用；RTen 内部已经使用并行线程。Key、响度、波形
等传统分析仍可走现有闸门。

### 持久化

不应把 50 fps 概率数组塞入 `tracks` 主表。建议：

- 主表新增最终 BPM、grid mode、分析器/模型版本、多维置信度摘要；
- beat/downbeat、tempo segments、候选结果写独立 `beat_analysis_assets` 表或压缩文件；
- 逐帧概率作为可清理的分析资产，仅在网格编辑/诊断需要时保留；
- 缓存键必须包含模型 SHA 和 grid fitter 版本。

### UI

生产切换前仍需完成：

- 波形图绘制固定 grid 与 variable tempo segments；
- 首拍左右移动；
- BPM ×0.5 / ×2 和候选选择；
- Ambiguous / analyzer disagreement 的明确提示；
- 人工编辑后锁定结果，重新分析不得覆盖。

## 下一阶段验收门槛

先用 full 模型跑项目自己的标注曲库，再决定默认切换。至少统计：

- beat/downbeat F1（±70 ms）；
- 固定网格相位中位与 P95 误差；
- 整轨累计漂移；
- 0.5×、2/3×、0.75×、4/3×、1.5×、2×误判率；
- Constant / Variable / Ambiguous 分类；
- 单曲耗时、峰值内存、安装包增量。

在这组数据通过前，当前 DSP 仍是默认后端，Beat This 保持实验特性。这不是实现障碍，
而是避免在没有项目自身准确率证据时直接重算整库。
