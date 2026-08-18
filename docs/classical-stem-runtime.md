# Classical DSP 实时分解

当前桌面 STEM 默认路径不再是 AI 四轨分离。KDJ 把输出写成它真正能保证的三类信号：

| 界面名称 | 含义 | 不能承诺的内容 |
| --- | --- | --- |
| `TRANSIENT` | 频谱中随频率方向集中的瞬态，鼓点通常占比较高 | 不是乐器分类意义上的 Drums |
| `TONAL` | 时间方向持续的谐波/稳定成分 | 不是 Bass/Other，也不保证只有旋律 |
| `VOCAL` | Adobe Audition Center Channel Extractor 同类的频域公共成分；针对严格中置人声 | 不是语义人声检测；宽人声、混响会残留，中置军鼓、贝斯和合成器也可能被带走 |

播放器底层仍保留四个 float 槽位，以免同时破坏 Deck ring、MIDI 和缓存协议。原 `bass`
槽固定为静音且不在界面出现；另外三槽相加逐 sample 重构原曲。等旧四槽协议独立迁移后，
这个静音兼容槽可以删除。

## 生产算法

实现位于 [`crates/kdj-stems/src/classical.rs`](../crates/kdj-stems/src/classical.rs)：

1. 以 4,096-point Hann STFT、512-sample hop（8 倍 overlap）分析左右声道。Adobe 官方
   文档给 Center Channel Extractor 的建议范围是 4,096–8,192 FFT、3–9 overlap。
2. 在 80–12,000 Hz 软人声频带内，逐频点比较 L/R 的复数相位与幅度。相位余弦和幅度
   平衡分别形成 discrimination；5-bin 三角平滑对应 amplitude bandwidth，92% 时间保持
   对应 spectral decay，用于抑制孤立的 musical-noise bin。
3. 对通过判别的频点，取 L/R 中较小的幅度和两者平均相位作为公共 `VOCAL` 分量，并从
   两个声道分别相减。严格同相等幅的人声会完整进入 `VOCAL`，而不是像 v1 一样受 0.96
   上限和 harmonic 偏置限制。
4. 对相减后的 residual 做 17 帧时间中值和 17 bin 频率中值 HPSS，得到 `TONAL` 和
   `TRANSIENT`。频域上 `TRANSIENT + TONAL + VOCAL = L/R`；iSTFT 浮点尾差归入最后一轨。

这不是任何候选仓库源码的 Rust 逐行翻译。实现依据 Fitzgerald HPSS、STFT soft mask 和
Mid/Side 相干度这些公开 DSP 构造重新编写。选择 clean-room 实现是为了让生产代码保持
Rust 和 KDJ 的 GPL-3.0-or-later 项目边界，同时避免混入来源、notice、再分发义务或实现
质量尚未逐项审定的第三方插件代码。

## 流式边界与延迟

| 参数 | 值 |
| --- | ---: |
| 输入 chunk | 24,576 samples / 557.28 ms |
| 左右 context | 各 4,096 samples / 92.88 ms |
| 每次发布的 core | 16,384 samples / 371.52 ms |
| handoff | 1,024 samples / 23.22 ms |
| STFT / hop | 4,096 / 512 samples |
| median 半窗 | 8 hops / 92.88 ms |

音频 callback 仍然只读 bounded ring；解码、FFT、中值和 iSTFT 在最多两个 live-audio worker
执行。AI 路径原来的 7.8 秒 tile 已缩短为 557 ms 输入块。算法本身需要约 93 ms 前视，
不是零延迟；cache miss 继续播放 ORG，第一块准备好后按原有 block handoff 切入。

旧 v1（2,048 FFT、保守 CENTER mask）的 M2 optimized 基准为 mean **28.652 ms**、
P95/max **48.462 ms**；它不再代表 v2 Adobe-style extractor。v2 把 FFT 提升到 4,096，
因此必须以 live worker 的 `F/B/P95` 诊断重新记录，不能沿用旧数字。两版都不下载模型，
也不建立 ORT/Core ML session。

复跑：

```zsh
cargo test --release -p kdj-stems \
  classical::tests::production_chunk_stays_below_its_realtime_budget -- --nocapture
```

## 质量损失

纯 DSP 的代价不是小幅退化，而是**不再做语义乐器识别**。使用此前 SCNet 评测相同的
MUSDB 7 首 excerpt、直接 waveform SDR，三轨结果为：

| 输出（旧 v1 基线） | Classical DSP mean SDR | 可直接比较的旧 SCNet mean SDR | 差值 |
| --- | ---: | ---: | ---: |
| TRANSIENT vs drums truth | 1.837 dB | 8.385 dB | **−6.548 dB** |
| v1 CENTER vs vocals truth（全部 7 首） | −0.995 dB | 5.446 dB | **−6.441 dB** |
| TONAL vs bass+other truth | 1.179 dB | 无同口径合并结果 | 不虚构差值 |

其中两首 excerpt 几乎无人声，中心算法仍会提取中置乐器，所以 v1 全体 `CENTER` SDR 很低；
只看 vocal ratio 大于约 0.09 的五首，v1 CENTER mean 为 2.329 dB。这些是推翻 v1 保守
mask 的证据，不冒充 v2 的结果。旧 SCNet 的正式发布 MUSDB 四轨平均为 9.03 dB；三轨
定义不同，不能拿 9.03 直接相减。

尤其要注意：`VOCAL` 是经典中心通道提取器，不是人声检测器。它的验收是“严格同相等幅的
中置人声能被强抵消”，不是“任何歌曲都得到 AI 级干净 vocal stem”。宽人声、双轨人声、
混响尾声和侧置和声仍会残留；反过来，严格中置的军鼓、贝斯和合成器也会被带走。这与 Adobe
官方对 Center Channel Extractor 的描述一致：它处理左右声道共有的频率，而不识别演唱者。

外部 MUSDB fixture 不进入仓库。复跑需先把每首 `.stem.mp4` 的 mixture/drums/bass/other/
vocals 五个 audio stream 转成 float WAV，再执行：

```zsh
KDJ_CLASSICAL_MUSDB_DIR=/tmp/kdj-classical-musdb7 \
  cargo test --release -p kdj-stems \
  classical::tests::report_external_three_lane_sdr -- --ignored --nocapture
```

## 调试台

调试台不再依赖 `KDJ_STEM_DEBUG_MODEL_DIR`，普通构建直接提供：

1. **Adobe-style Vocal Extractor + Median HPSS (Production)**：生产三轨。
2. **Transient / Steady (Second Choice)**：快慢能量 follower 的零前视互补分解；瞬态更干脆，
   但没有频率选择性，密集母带上容易把整段一起拉进 transient。
3. **Median HPSS**：原始 harmonic/percussive 两轨。
4. **Adobe-style Vocal Extract / Remove**：VOCAL/BACKGROUND 两轨，用于直接检查提取与
   karaoke 抵消，不再用普通 Mid/Side 冒充人声分离。
5. **Classic Mid / Side**：最低成本 MID/SIDE 基线。

每个方案都输出可试听 float WAV、Unity sum、重构误差和 RTF。列表为空时仍保持为空，不加
提示性占位文案。

## 候选仓库与许可结论

所有仓库只作为只读研究对象，clone 在 `/Users/kumo/Frameworks`。固定提交如下：

| 项目 | Commit | 许可/可否引用 | 本轮结论 |
| --- | --- | --- | --- |
| [Adobe Audition Center Channel Extractor 文档](https://helpx.adobe.com/audition/desktop/effects-reference/stereo-imagery-effects.html) | 官方在线文档，读取于 2026-08-18 | 行为/参数参考；Adobe 源码未提供，也未复制 | 确认 Frequency Range、Phase/Amplitude Discrimination、Amplitude Bandwidth、Spectral Decay、4,096–8,192 FFT 和 3–9 overlap；KDJ 以这些公开行为 clean-room 实现 |
| `hpss-cpp-ref` | `db603009e92bdc2b077ad757b122f937a78600cd` | BSD-3-Clause，可直接集成并保留 notice | 最成熟的实时 HPSS 结构参考；生产仍使用 Rust clean-room，避免 C++/arena/FFT FFI |
| `FFmpeg` | `4b47405e1c251405bfa5196e79aa395c59ad2323` | `dialoguenhance` 为 LGPL-2.1+；直接复用须保留 notice 并满足 LGPL 再分发要求 | 作为最成熟流式中心语音基准；未复制 template/C 代码 |
| `ZLSplitter` | `2f50824ab925eeff7950986eac640dab43c3ce67` | AGPL-3.0；会给 KDJ 引入比现有 GPL 更强的网络源码义务，本轮禁止直接并入 | 第二推荐效果基准；调试台用独立的双 envelope Transient/Steady，不是其实现移植 |
| `unravel-vst` | `c6b717932163637f423db3850f12ea26ef6ecaf4` | GPL-3.0，与 KDJ 许可方向兼容但直接复用仍须保留来源、版权和修改记录；本轮未复制 | 三路命名有价值，但 checkout 自带 review 还记录 ring/latency/scale 问题，不作为生产基线 |
| `VoiceFront` | `c31d9db104ff69b9d11eba489f25502b8caa455f` | MIT，可引用并保留 notice | 2,048/512 AudioWorklet 证明轻量中心 mask 可实时；KDJ 使用不同的 mid/side power mask |
| `Zen/libzen` | `953f0a2d3b5bb215639f8b795b2a4512f4fcaf31` | `libzen` MIT | H/P/residual 参考；CUDA/IPP/Thrust 依赖不进入跨平台默认构建 |
| `Music-Separation-TF` | `1e21d3802b7df8f6c25778bca6a6c576f805fc4a` | MIT | 研究和参数证据；MATLAB/PEASS/vendor 栈不进入 runtime |
| `Earys-Spatial-Expander` | `1e029fac3f9d8df24332214c1eb56f51a4846878` | checkout **没有 LICENSE 文件** | 只能参考 README 所述 phantom-center 概念，源码必须视为 all-rights-reserved，不复制 |
| `swh/ladspa` | `0f54d2430febb4d5f02d13132dd91d7345e080b5` | GPL-2.0；版本兼容性和逐文件来源需额外审查，本轮未复制 | Karaoke 明确 `HARD_RT_CAPABLE`，但只做 L+R/L−R；调试台自己实现基础 Mid/Side |

源码证据：`hpss-cpp` README 说明逐 hop API 和分摊运算（README 22–67），其实现用横/纵
中值、互补 mask 和 OLA（`hpss.cpp` 139–203、241–267、347–367）；ZLSplitter 的
`ts_splitter.hpp` 1–8 明示 AGPL，并在 105–154 执行频率/时间中值 mask；FFmpeg
`af_dialoguenhance.c` 1–18 明示 LGPL，111–180 是 2,048 FFT/quarter-overlap 流；VoiceFront
`separator-worklet.js` 1–2、67–105 是 2,048/512 中置 mask；SWH `karaoke_1409.xml` 7–33
给出 GPL、`HARD_RT_CAPABLE` 和 M/S 运算；Music-Separation-TF README 36–48 明确说明
因果 HPSS 的 harmonic 质量损失和 0.621 ms MATLAB 结果。

## AI 删除边界

默认 feature 为空。`reqwest`/`zip`/`ort`、Core ML bridge 和模型安装器都不参与默认
`kdj-stems` 构建。旧实现暂存于一个明确边界：

- Cargo feature：`ai-stem-legacy`（默认关闭）；旧 `stem-debug-onnx` 只作为它的别名。
- 文件：`debug_ai.rs`、`manager_ai.rs`、`runtime_ai.rs`、`dsp.rs`、`model.rs`、`coreml.rs`、
  `coreml_bridge.m`、`coreml_link_stub.c`、`onnx.rs`。
- `build.rs` 只有启用该 feature 才编译 Objective-C bridge。

彻底删除时可以一次移除上述 feature、文件和 `cc/reqwest/zip/ort` 可选依赖；默认 classical
runtime、server 路由和前端不需要再改协议。旧模型数据目录不会再被读取或下载，本轮也不
主动删除用户磁盘上已有的模型，避免应用升级时越权清理数据。
