# BPM 与 Key 分析算法提取

项目中的 BPM 与 Key 分析已经位于独立 Rust crate `crates/kdj-analysis`。本文件只提取
算法边界、计算流程和参数；核心代码仍以该 crate 为唯一实现，避免复制后产生两套结果。

## 最小代码边界

| 文件 | 职责 |
| --- | --- |
| `crates/kdj-analysis/src/tempo.rs` | BPM 粗估、倍频消歧、节拍跟踪、BPM 精修与置信度 |
| `crates/kdj-analysis/src/key.rs` | Chroma、24 调模板匹配、Camelot / OpenKey 映射与置信度 |
| `crates/kdj-analysis/src/dsp.rs` | 两套算法共用的 STFT、Mel、FFT 自相关、插值和统计原语 |
| `crates/kdj-analysis/src/decode.rs` | 音频解码、单声道下混、22.05 kHz 重采样 |
| `crates/kdj-analysis/src/engine.rs` | 分析窗选择与 BPM / Key 结果汇总 |

如果输入已经是单声道 `f32` PCM，只需要 `dsp.rs`、`tempo.rs` 和 `key.rs`；文件解码和
整轨截取不是算法本体。

## 公共调用入口

```rust
use kdj_analysis::{key::analyze_key, tempo::analyze_tempo};

let tempo = analyze_tempo(&mono_samples, sample_rate_hz);
let key = analyze_key(&mono_samples, sample_rate_hz);
```

分析文件并一次取得两类结果：

```rust
use kdj_analysis::engine::analyze_file;

let result = analyze_file(audio_path, 240.0);
```

可直接运行聚焦入口：

```bash
cargo run --release -p kdj-analysis --example bpm_key -- "/path/to/audio.mp3"
```

## 公共输入预处理

- 文件由 Symphonia 解码，声道按 `1/sqrt(channel_count)` 的能量守恒增益下混。
- 使用 16 taps Blackman 窗 sinc 重采样到 22050 Hz。
- 长度不少于 60 秒的曲目从总时长 15% 处开始，最多分析 240 秒，以绕过静音或无节奏
  intro；短曲整段分析。
- BPM 与 Key 都会先把分析窗按绝对峰值归一，因此文件原始增益不会直接改变结果。

## BPM 算法

完整入口是 `tempo::analyze_tempo(samples, sr)`，输出 `TempoResult`。

### 1. 起音强度包络

1. 使用 2048 点周期 Hann 窗、512 点 hop 做 STFT 幅度谱。
2. 投影到 64 个 HTK Mel 频带，范围 30–11000 Hz。
3. 对 `ln(1 + 10 * magnitude)` 沿时间做一阶差分和半波整流。
4. 对所有 Mel 频带求和，再减去 0.5 秒滑动均值并二次半波整流。
5. 按最大值归一，得到起音包络 `env[t]`；帧率为 `fps = sr / 512`。

### 2. 自相关粗估

对去均值后的起音包络做 FFT 自相关，并按重叠样本数给出无偏估计。只在
60–200 BPM 对应的 lag 区间寻找局部峰：

```text
bpm(lag) = 60 * fps / lag
weighted(lag) = max(autocorrelation(lag), 0) * prior(bpm)
prior(bpm) = exp(-0.5 * (log2(bpm / 120) / 0.9)^2)
```

峰位置用抛物线插值细化，保留分数最高的 5 个候选，最高者记为 `bpm_raw`。

### 3. 倍频与节奏层级消歧

候选只在已存在的自相关峰之间选择，不凭空生成速度。依次检查：

- `3:2`：修正三连音/八分重音把真速度识别成 2/3 的情况；
- `4:3`：修正每三拍一组的慢网格；
- `2:1`：修正半速 BPM。

选择依据包括 BPM 区间、每拍起音峰数量，以及梳状对比分数。梳状分在所有相位上寻找：

```text
score(period) = max_phase(mean(beat_energy) - mean(offbeat_energy))
                + 0.05 * mean(beat_energy)
```

若粗估落在高速细分拍，还会用同速度族内的半速或 3/4 速候选反向纠正。具体阈值来自
项目真实曲库调参，应由 `tempo.rs` 和对应测试共同维护。

### 4. Ellis 动态规划节拍跟踪

先按候选 BPM 得到目标周期 `period = 60 * fps / bpm_guess`，再跟踪整段拍点：

```text
D[t] = local[t] + max_tau(
  D[t - tau] - 100 * log(tau / period)^2
)
tau in [period / 2, 2 * period]
```

`local[t]` 是标准差归一后的起音包络，经 `sigma = period / 32` 的高斯核平滑所得。
回溯后会移除 intro/outro 中能量过弱的伪拍。

### 5. BPM 精修与置信度

- 先取相邻拍点间隔的中位数，并以 `±25%` 选内点。
- 在最长连续内点段上对“拍序号 → 帧位置”做最小二乘直线拟合，用斜率精修周期。
- `bpm = 60 * fps / refined_period`；若精修值偏离候选超过安全范围则回退粗估。
- 置信度由拍间隔四分位距计算：

```text
confidence = clamp(1 - (Q75 - Q25) / median_interval, 0, 1)
```

结果包含最终 BPM、原始自相关 BPM、置信度、首拍、拍间隔和完整拍点时间。

## Key 算法

完整入口是 `key::analyze_key(samples, sr)`，输出 `KeyResult`。

### 1. Chroma 提取

1. 使用 4096 点周期 Hann 窗、1024 点 hop 做 STFT，以提高低频音高分辨率。
2. 只保留 C2–C7（65.4–2093 Hz），过滤底鼓、低频噪声和高频镲片。
3. 每个频率 bin 按连续 MIDI 音高映射到相邻两个半音，使用线性三角权重，而不是四舍五入。
4. 每个频率 bin 沿时间做 17 帧中值滤波，压制瞬态打击成分、保留持续谐波。
5. 每帧的 12 维 Chroma 做 L2 归一，再对每个音级沿时间取中位数。
6. 最终 Chroma 按最大音级归一到 `[0, 1]`。

### 2. 谐波泄漏校正

先对 Chroma 开平方，减弱少数持续强音的垄断；再进行一阶纯五度泄漏校正：

```text
compressed[p] = sqrt(max(chroma[p], 0))
corrected[p] = max(compressed[p] - 0.30 * compressed[(p + 5) mod 12], 0)
```

这里扣除的是音级 `p-7` 的三次谐波落到 `p` 的能量，避免主音被系统性误判为属音。

### 3. Krumhansl–Schmuckler 模板匹配

分别把 Krumhansl 大调、小调模板旋转到 12 个主音，共得到 24 个候选。计算校正 Chroma
与每个候选模板的 Pearson 相关系数，最高分即识别结果。

```text
confidence = clamp((best_score - second_score) / (abs(best_score) + 1e-9), 0, 1)
```

最终返回完整调名、短调名、Camelot、OpenKey、置信度和原始 12 维 Chroma。静音或无有效
Chroma 时返回空调名和 0 置信度，不猜测随机调性。

## 当前验证基线

```bash
cargo test -p kdj-analysis
```

当前 `kdj-analysis` 共 54 个测试，覆盖 DSP 数值、BPM 合成节拍轨、倍频消歧、节拍网格、
调性模板、五度谐波泄漏、静音和短输入等边界。
