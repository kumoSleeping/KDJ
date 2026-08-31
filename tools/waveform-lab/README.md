# KDJ 波形重构独立实验

本目录用于在**不接入 KDJ 应用**的前提下，对两首真实歌曲做当前算法与候选算法的 A/B。

候选算法保留现有两种生成方式：

- `release-overview`：整曲预览；
- `performance-detail`：100 列/秒的右侧细节波形。

变化只发生在独立实验数据与渲染中：`amp-only` 矩形改为 signed min/max 连续轮廓。v6 保留 KDJ 当前两条取色链及各自的 Performance / release 显示 palette，但将候选 overview 的颜色 gamma 从 6.0 反算为 2.4，使 detail 与 overview 都使用 2.4；左侧当前基线仍保持原始的 detail 2.4 / overview 6.0。候选同时使用线性光插值、3× 垂直抗锯齿和瞬态的一物理像素边缘，不使用 Gaussian blur。

随机对比：

```sh
tools/waveform-lab/run-comparison.zsh
```

固定输出目录与随机种子，便于复现：

```sh
tools/waveform-lab/run-comparison.zsh artifacts/waveform-comparison-review 20260829
```

可通过 `KDJ_WAVEFORM_SONG_DIR` 指定歌曲目录。Rust 提取器会记录随机种子、歌曲绝对路径、解析时长和自动选择的 30 秒 Performance 细节窗口；不足 30 秒的歌曲使用全长。Python 只负责离线 PNG 排版。

## 边界

- 不修改 `crates/kdj-analysis/src/waveform.rs`、缓存、wire、Tauri 或前端波形文件。
- 当前基线直接调用仓库里的 `band_waveform` 与 `release_overview_waveform`，没有重写一份“近似基线”。
- 本轮随机普通歌曲没有现成 STEM，因此严格回退方案 D；不生成或展示伪造的四声部估算。真实 STEM 只能在用户批准接入后的渐进路径中使用。
- 候选 Rust 算法位于 `algorithm.rs`；只有获批后才会迁移进正式分析与渲染链路。
