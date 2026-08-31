# 演奏波形、Beat Grid 与 SCNet Small 实测

测试日期：2026-08-15。测试机是 MacBook Air M2（4P+4E CPU、10-core GPU、16 GB Unified Memory），macOS 26.5，PyTorch 2.13.0。除明确写着“估算”的表格外，下面的数字都来自这台机器。

## 先说结论

- 旧波形真正慢的不是画图，也不是新的三频段包络，而是为了展示做了一次没有必要的 32-tap sinc 整轨重采样。239.7 秒 MP3 的重采样路径用了 8.06 秒；保留源采样率后，高密度波形只用 0.56–0.59 秒。
- 不再启动全曲库“准备演奏波形”。KDJ 只预取当前 Deck 和预测下一首；有 640 列旧概览时先画概览，再替换为 100 列/秒的高级波形。
- 底部整曲预览和高级波形不能共用同一种缩放。高级波形保留瞬态峰；整曲预览按时间面积平均高度，避免每个像素都碰到鼓点后变成一条实心彩带。
- 当前测试曲的传统 DSP 结果为 144.01 BPM，grid phase 为 0.1434 秒。Beat This Full 给出的参考 phase 是 0.1394 秒，相差 4 ms。低置信度或没有 phase 的曲目不再从 0 秒硬画一套假网格。
- 三款 SCNet 真实权重都能在 M2 的 CPU 和 MPS 上运行，MPS 未开启 CPU fallback。11 秒 warm inference：SCNet Small 2.02 秒、Masked Small 2.02 秒、Tran Small 4.93 秒。
- DJ 的第一选择仍是 **SCNet Small 官方权重**。Masked 的镲片保留和部分串音指标略好，但 11 秒 MPS driver allocation 峰值更高；Tran 的平均 SDR 最好，却慢约 2.4 倍。

## 1. 波形为什么以前这么慢

旧路径要做三件事：

1. 用 Symphonia 解完整首压缩音频并混成 mono；
2. 从 44.1 kHz 用 32-tap Blackman-windowed sinc 降到 16/22.05 kHz；
3. 跑 1024 FFT、512 hop 的三频段 STFT。

第二步占了绝大部分时间。对《太陽曰く燃えよカオス - Exit Trance》的 239.673 秒 MP3，旧路径的解码加重采样为 8.01 秒，STFT/包络只占后面很小一段。新版直接在源采样率上扫一遍 PCM，不再为了几条屏幕柱子做分析级重采样。

### 新版 Mixxx 路径

实现参考了 Mixxx `AnalyzerWaveform` / `WaveformFactory` 的处理方式，而不是照搬皮肤：

- 600 Hz 和 4 kHz 互补 IIR crossover，分别形成 low / mid / high；
- 每 5 ms 保存一次总峰值和三段峰值，即 200 master columns/s；
- Performance Deck 保存 100 columns/s，普通曲目最多 24,000 列；
- overview 对 master 峰做时间平均；高级局部视图保留瞬态；
- 颜色只做约 30 ms 去毛刺。旧算法按 `count / 128` 平滑，4,096 列时会把颜色抹平一秒以上。

同一首 239.673 秒 MP3 的独立 release benchmark：

| 路径 | 输出列 | 解码 | 包络 | 总计 | 峰值 RSS |
|---|---:|---:|---:|---:|---:|
| 旧：22.05 kHz sinc + STFT | 640 | 8.013 s | 0.048 s | 8.061 s | 64.5 MiB |
| 新：native-rate + IIR | 23,970 | 0.474 s | 0.083 s | 0.558 s | 46.2 MiB |

高密度输出多了约 37 倍，计算反而快约 14.4 倍。

恢复 v0.2.41 release overview 后，两种视觉 profile 仍然独立存储，但交互冷命中不再独立解码。2026-08-25 在同一台 M2 上用 310.3 秒 MP3、热 OS page cache、7 轮中位数复测：`opt-level=2` 下分别解码 release/current 共 0.724 秒；共享一次 native PCM 解码并生成两份资产为 0.403 秒，节省 44.4%。此前体积优先的 `opt-level=z` 单算 release 就要 0.845 秒，因此 release 全局改为 level 2。相位累加器还把 44.1→16 kHz 的同一份 polyphase sinc 从 64.3 ms 降到 48.2 ms（1.34×），与逐样本坐标公式的输出最大误差为 0。

用户截图里的《願いはShine On The Sea》也做了同宽度复算：旧渲染把 21,854 列直接按屏幕像素取 peak，1,812 个像素里有 79.2% 高于 0.8；新版先派生 960 列时间均值，再插值到屏幕，超过 0.8 的像素降到 36.2%。中位高度仍是 0.77，颜色不减采样，只把“几乎根根顶满”的垂直填充压下来。

### 缓存、内存和后台影响

`.kdwave` 的大小是固定 30-byte header 加每列 7 bytes：

| 波形 | 单曲磁盘占用 |
|---|---:|
| 640 列概览 | 4,510 bytes（4.40 KiB） |
| 239.7 秒高级波形，23,970 列 | 167,820 bytes（163.9 KiB） |
| 24,000 列上限 | 168,030 bytes（164.1 KiB） |

二进制响应不再展开成四个 boxed Number 数组：amp 使用响应内的 `Float32Array` view，RGB 使用三个 `Uint8Array` view，四个通道共享原始 `ArrayBuffer`。24,000 列因此保持约 164 KiB wire 大小，而不是约 0.8–1.5 MiB/曲；JSON 兼容回退仍使用普通数组。Canvas 的屏幕列暂存也从五个 Float64 缓冲收紧为 Float32 amp/edge + Uint8 RGB/known。Performance canvas 的 backing store 限制为 16,384 pixels；Retina、50 CSS px 高时，最坏约 6.25 MiB/Deck，像素面仍是主要显存占用。

旧 HTTP 路径会把 24,000 列磁盘二进制重新编码成约 691 KiB JSON。现在前端显式请求 `application/vnd.kdj.waveform`：36-byte wire header 自描述格式版本、current/release profile 与算法 revision，随后仍是每列 7 bytes。24,000 列响应固定为 168,036 bytes；服务端不再生成大段 JSON 文本，WebView 也不再解析数万个数字 token。未升级的后端仍可回退到 JSON。

正常用户不会再看到软件启动后逐首完整解码整个曲库。当前曲和预测下一首先到先算；310 秒测试曲一次冷命中约 0.4 秒便同时得到 release overview 与 detail，普通长度歌曲更短。缓存命中只读一份最多约 164 KiB 的二进制文件。DJ detail 直接复用这份高密度资产，颜色沿用 overview 的 RGB 频段语言，但保留 peak 屏幕汇聚、100 列/秒、Beat Grid 与 GAIN 高度，不套用 overview 的中位值离群过滤。后台 BPM/Key 分析结束后也不再顺手排一遍全库波形。

当前 detail 缓存算法版本是 v6。某一首歌的新 v6 文件原子写入成功后，才删除这首歌对应的 v2 JSON、v3 STFT、v4 重采样和 v5 peak 缓存。失败或中断不删旧文件，也不会动音频、BPM/Key、Cue 或曲库记录。没有装入过 Deck 的歌不会为了清旧文件而被全库重算；它第一次装轨成功后再完成替换和清理。

## 2. Beat Grid

波形密度和网格是否对拍是两件事。原 UI 只要有 BPM 就画线；`first_beat` 缺失时甚至从 0 秒开始造相位，每四拍还会显示成像 downbeat 一样的重线。

当前规则：

- 必须有有效 `first_beat`；
- `bpm_confidence < 0.45` 时不画固定网格；
- BPM 的离散拍点仍交给 DJ grid fitter 检查倍率、覆盖和规则性；
- 合成变速序列保持 variable，不生成固定 `grid_beats`；
- Hot Cue quantize 没有可靠 phase 时不吸附。

指定测试曲的结果：

| 分析器 | BPM | phase | 说明 |
|---|---:|---:|---|
| KDJ DSP + grid validation | 144.01 | 0.1434 s | 当前产品快路径 |
| Beat This Full | 144.009 | 0.1394 s | 全模型参考，无 warning |
| 差值 | 0.001 | 4 ms | 小于 MIR 常用 70 ms 容差 |

Beat This Full 本身在这台 M2 上处理 239.7 秒曲目用了 44.66 秒、峰值 RSS 约 806 MiB；Small 虽快一些，却在这首歌上给出了错误的可变网格。因此这轮没有把 Beat This 模型塞进产品，保留它作离线参考。

## 3. SCNet 资产

原计划中的 Band-SCNet 和论文版 Moises-Light S/Full 继续暂停，原因是没有可复核的公开预训练权重。这里测试的是三款已经拿到真实 checkpoint 的 SCNet Small。

| 模型 | 参数 | checkpoint | SHA-256 | 发布指标（MUSDB avg SDR） |
|---|---:|---:|---|---:|
| SCNet Small（starrytong） | 10,578,768 | 42,434,986 B | `1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa` | 9.03 dB |
| SCNet Tran Small | 10,380,032 | 41,696,502 B | `253882ba7222fd07bad164044b9b0d980a39bbb3e243be64d748244aff8fd4ef` | 8.92 dB |
| SCNet Masked Small | 10,597,284 | 42,517,058 B | `dcd70804f21d97a63e32e246ef6a8fe32644cbae6399be857df3215b3288ece9` | 8.81 dB |

SCNet 仓库和权重为 MIT；作者在 license clarification issue 中明确允许原 checkpoint 和 ONNX 转换件随 MIT 工具再分发并保留署名。SCNet Small 的首选下载入口是 ZFTurbo
[`v.1.0.6` release](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v.1.0.6)：其中明确同时列出
[`config_musdb18_scnet.yaml`](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v.1.0.6/config_musdb18_scnet.yaml)
和
[`scnet_checkpoint_musdb18.ckpt`](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v.1.0.6/scnet_checkpoint_musdb18.ckpt)。本次没有把文件复制进 KDJ。

## 4. M2 chunk inference

输入统一为 44.1 kHz stereo float，取指定 DJ 曲 72–83 秒。表中是同一进程、每个长度先跑一次，再跑三次后的 warm median。MPS 设置 `PYTORCH_ENABLE_MPS_FALLBACK=0`，所以没有不知情地掉回 CPU。

### MPS

| 模型 | 7 s | RTF | 9 s | RTF | 11 s | RTF |
|---|---:|---:|---:|---:|---:|---:|
| SCNet Small | 1.309 s | 0.187 | 1.599 s | 0.178 | 2.021 s | 0.184 |
| SCNet Tran Small | 3.093 s | 0.442 | 4.196 s | 0.466 | 4.927 s | 0.448 |
| SCNet Masked Small | 1.395 s | 0.199 | 1.873 s | 0.208 | 2.017 s | 0.183 |

三款都能在音频时长内完成，Small/Masked 有约 5.4× realtime，Tran 约 2.2× realtime。

同一 11 秒输出的 CPU↔MPS 数值差很小：三款所有 stem 的 RMS difference 都低于 `3.3e-7`，最大单样本差低于 `3.9e-6`。MPS 路径不是一个明显改变结果的近似版本。

### CPU

M2 Air 没有风扇。连续跑三种长度时出现明显热降频，系统当时也有其它开发进程和 swap，因此 CPU 数字应看作“持续后台压力”，不是清洁实验室峰值。

| 模型 | 7 s | RTF | 9 s | RTF | 11 s | RTF | 11 s 独立进程 warm |
|---|---:|---:|---:|---:|---:|---:|---:|
| SCNet Small | 4.207 s | 0.601 | 11.894 s | 1.322 | 13.799 s | 1.254 | 8.473 s |
| SCNet Tran Small | 14.377 s | 2.054 | 18.960 s | 2.107 | 19.472 s | 1.770 | 10.484 s |
| SCNet Masked Small | 9.861 s | 1.409 | 8.749 s | 0.972 | 16.907 s | 1.537 | 15.229 s |

CPU 不适合 Hot Cue 后才开始的同步推理。即使 Small 的独立 11 秒进程能在 8.5 秒左右完成，持续演出负载下也会越过实时线。

### 内存

这里同时给出 PyTorch 能看到的 tensor allocation 和 MPS driver allocation。后者包括 Metal graph/kernel/temporary allocations，更接近 unified memory 压力。

| 模型 | CPU peak RSS，11 s 独立进程 | MPS host RSS | MPS tensor peak | MPS driver peak |
|---|---:|---:|---:|---:|
| SCNet Small | 2.51 GiB | 453 MiB | 366 MiB | 3.63 GiB |
| SCNet Tran Small | 3.32 GiB | 571 MiB | 1.32 GiB | 2.38 GiB |
| SCNet Masked Small | 2.67 GiB | 464 MiB | 500 MiB | 4.99 GiB |

在同一进程依次跑 7/9/11 秒的多 shape 测试里，driver peak 还会升到 Small 5.53 GiB、Masked 7.74 GiB。产品若固定 11 秒 shape 并复用模型，会比反复切 shape 更可控。

### Mac M1 / M5 估算，不是真机实测

没有 M1 或 M5 真机入口。下面只把本机 M2 10-core GPU 的 11 秒 warm time，按 Geekbench Metal 公布的 M1 8-core 27,447、M2 40,897、M5 10-core 76,278 做反比缩放，并额外放宽约 25%。SCNet 的 STFT、RNN/attention 和内存访问不会严格按 Metal 综合分数线性缩放，所以区间比中心值更重要。

| 模型 | M1 MPS 估算 | M2 MPS 实测 | M5 MPS 估算 |
|---|---:|---:|---:|
| SCNet Small | 3.01 s（2.26–3.76） | 2.021 s | 1.08 s（0.81–1.35） |
| SCNet Tran Small | 7.34 s（5.52–9.16） | 4.927 s | 2.64 s（1.98–3.30） |
| SCNet Masked Small | 3.01 s（2.26–3.75） | 2.017 s | 1.08 s（0.81–1.35） |

M1/M5 的 unified-memory 峰值不按 GPU 分数缩小，仍应按 M2 测到的 2.4–5.1 GiB driver allocation 预留，并给播放器、波形和系统留余量。

### Windows CPU / NVIDIA

以下全部是**估算，不是 Windows 实测**。由于没有具体型号，按三档给区间，而不是给一个没有对象的单一秒数。

CPU 以本机 M2 Geekbench 6 multi-core 9,703 为基准，分别套用普通笔记本 7,500–10,000、高性能笔记本 10,500–13,200、现代桌面 15,500–17,000 的公开分数范围，再为 PyTorch x86/ARM kernel、功耗和散热差异额外放宽约 35–40%。基线使用 11 秒独立进程 warm time，不使用 M2 Air 已热降频的持续最差值。

| Windows CPU 档位 | SCNet Small 11 s | Tran Small 11 s | Masked Small 11 s |
|---|---:|---:|---:|
| 6–8 核普通笔记本 | 5.8–15.3 s | 7.1–19.0 s | 10.4–27.6 s |
| 12700H / 7840HS 一档 | 4.4–11.0 s | 5.4–13.6 s | 7.8–19.7 s |
| Ryzen 7700 / i7-13700 一档桌面 | 3.4–7.4 s | 4.2–9.2 s | 6.1–13.3 s |

Windows CPU 的结论与 M2 CPU 一样：Small 在较快机器上可能赶得上 11 秒窗口，Tran/Masked 的下限和上限跨度大，不应依赖 CPU 做即时 Hot Cue cache miss。

NVIDIA 以 Geekbench 6 compute 的公开范围做第一层缩放：RTX 3060 约 79k、RTX 4060 Mobile/Desktop 约 89k–102k、RTX 4070 Laptop 约 110k、RTX 4070/5070 desktop 约 165k–172k；本机 M2 Metal 约 40.9k。OpenCL/Metal 综合分数不能代表 cuFFT、LSTM 和 attention，因此最终区间再放宽约 45–50%。

| Windows NVIDIA 档位 | SCNet Small 11 s warm | Tran Small 11 s warm | Masked Small 11 s warm |
|---|---:|---:|---:|
| RTX 3060（功耗/6GB 与 12GB 版本差异另算） | 0.6–1.6 s | 1.5–3.9 s | 0.6–1.6 s |
| RTX 4060 Laptop/Desktop 8GB | 0.5–1.4 s | 1.3–3.4 s | 0.5–1.4 s |
| RTX 4070 Laptop 到 4070/5070 Desktop | 0.3–1.2 s | 0.8–2.8 s | 0.3–1.2 s |

首次 CUDA 路径还应在 warm inference 上预留约 0.4–1.5 秒给权重读取、context 和 kernel 初始化。MPS allocation 不能直接当成 CUDA VRAM，但本轮 11 秒 tensor/driver 峰值表明 6 GB 版本可能过紧；**8 GB 是复跑下限，12 GB 更适合保留多个 shape 或同时运行图形界面**。这些显存判断同样需要真机 JSON 才能转成保证值。

`~/Frameworks/kdj-scnet-eval/benchmark_scnet.py` 已包含 `--device cpu` 和 `--device cuda`，在 Windows 会输出同样的 7/9/11 秒、RTF、RSS、CUDA allocated/reserved memory 和 Hot Cue cache miss JSON。拿到 CPU/GPU/显存型号后可直接补表，不需要改测试方法。

## 5. Hot Cue cache miss

端到端路径包括读 11 秒 float WAV、四轨推理和写四个 stereo float WAV。四轨缓存合计 15,523,552 bytes（14.8 MiB）。这只是研究时的无压缩基线；整首 4 分钟按同格式外推约 323 MiB，产品不能不加策略地长期保存所有整轨 float stem。

| 模型 | MPS 驻留路径 | MPS 首次路径 | CPU 驻留路径 | CPU 首次路径 |
|---|---:|---:|---:|---:|
| SCNet Small | 1.808 s | 2.675 s | 8.607 s | 9.112 s |
| SCNet Tran Small | 3.862 s | 4.714 s | 10.597 s | 9.851 s |
| SCNet Masked Small | 2.227 s | 2.492 s | 15.312 s | 10.027 s |

“首次”是新 Python 进程内的模型构造、权重读取、device move 和第一次 11 秒 inference；Metal pipeline cache 可能已被前面的测试暖过，不能解释成重启系统后的绝对最坏值。

## 6. MUSDB 7 秒真值比较

从 MUSDB test sample 按 vocal、bass、drums 和 drums 8–16 kHz 能量固定选出 7 个 excerpt。它不是完整 50 首官方评测，所以绝对 SDR 不能和 release 表直接横比；三款模型使用同一批输入，可以做本轮相对比较。

| 模型 | 四轨平均 SDR | Vocal→Drums bleed | Vocal→Bass bleed | Vocal→Other bleed | Drums→Bass bleed | Bass→Drums bleed | Cymbal 8–16k retention | Cymbal 高频误差 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SCNet Small | 5.558 dB | −28.50 dB | **−42.69 dB** | −20.65 dB | −32.00 dB | **−26.22 dB** | −0.63 dB | −9.82 dB |
| SCNet Tran Small | **5.916 dB** | **−30.76 dB** | −35.43 dB | −21.81 dB | −29.54 dB | −25.68 dB | −0.90 dB | −9.54 dB |
| SCNet Masked Small | 5.437 dB | −26.77 dB | −38.38 dB | **−23.13 dB** | **−33.13 dB** | −23.95 dB | **−0.54 dB** | **−10.07 dB** |

Bleed 是 estimate 对另一条 ground-truth stem 的 least-squares projection，数值越负越好。MUSDB 没有单独的 kick stem，所以 Bass/Kick 只能诚实地写成 bass↔drums proxy。Cymbal retention 越接近 0 dB 越好；高频误差越负越好。

这组样本里：Tran 的平均 SDR 最高；Masked 的 drums→bass bleed 和 cymbal 指标最好；官方 Small 的 vocal→bass、bass→drums 和内存/速度组合更平衡。指定 DJ 曲的 11 秒四轨试听文件在外部研究目录 `results/hot-cue-cache/<model>/mps/`，对应频谱摘要在 `results/quality-musdb7.json`，没有 ground truth 的部分没有写成客观音质分数。

## 7. 复跑位置

外部研究目录：`~/Frameworks/kdj-scnet-eval`

- `prepare_assets.py`：跨平台下载和 SHA-256 校验；
- `benchmark_scnet.py`：CPU / MPS / CUDA 的 7/9/11 秒、内存和 Hot Cue cache miss；
- `evaluate_quality.py`：MUSDB 真值指标和 DJ 片段频谱摘要；
- `results/*.json`：本次原始结果；
- `README.md`：Windows 与 macOS 复跑命令。

## 8. 后续接入边界（本轮不实现）

KDJ 当前只有 Rust + Tauri 是活动架构。若以后确认一个 SCNet 模型，接入点应保持单向：

1. `crates/kdj-analysis` 负责模型 manifest、checkpoint hash、chunk inference 契约，不让 `kdj-player` 知道 PyTorch 或模型下载细节；
2. `kdj-server` 增加独立 StemCoordinator，按 `(track, mtime, model hash, chunk start, chunk length)` 单飞和缓存。Hot Cue 请求抢占普通预热，但不能在音频 callback 里跑模型或写文件；
3. `kdj-player` 只接收已经可读的四轨 PCM/ring buffer，在现有 engine/stream mixer 里做 Vocals / Drums / Bass / Other gain/mute。cache miss 时继续播原混音，四轨就绪后在 block 边界短 crossfade，不能阻塞设备线程；
4. 管理模式只绘制当前原曲波形；实时音频处理不生成、传输或绘制额外分轨波形；
5. 设置只允许下载和选中一个模型。模型切换后按 hash 隔离缓存，不设计运行时双模型兜底。

完整 11 秒 float stem cache 已经是 14.8 MiB，整轨无压缩约 323 MiB。正式方案要么按 11 秒附近按需缓存并做 LRU，要么采用可随机访问的无损压缩；不能把全库四轨 float 当成和 164 KiB 波形缓存同一类资产。

## 资料来源

- Mixxx waveform analyzer：<https://github.com/mixxxdj/mixxx/tree/main/src/analyzer>
- Mixxx waveform renderer：<https://github.com/mixxxdj/mixxx/tree/main/src/waveform>
- SCNet official：<https://github.com/starrytong/SCNet>
- SCNet checkpoint/license clarification：<https://github.com/starrytong/SCNet/issues/35>
- MSST pretrained model table：<https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md>
- MUSDB sample excerpts：<https://github.com/sigsep/sigsep-mus-db>
- Beat This paper/repo：<https://github.com/CPJKU/beat_this>
- Beat This Rust reference port：<https://github.com/danigb/beat-this-rs>
- Geekbench Metal chart（仅用于 M1/M5 粗估）：<https://browser.geekbench.com/metal-benchmarks>
- M5 10-core Metal result 76,278：<https://browser.geekbench.com/v6/compute/5055930>
- M2 Air Geekbench 6 CPU（9,703 multi）：<https://browser.geekbench.com/macs/macbook-air-2022>
- Geekbench processor chart：<https://browser.geekbench.com/processor-benchmarks>
- Ryzen 7 7700（15,476 multi）：<https://browser.geekbench.com/processors/amd-ryzen-7-7700>
- Core i7-13700（17,012 multi）：<https://browser.geekbench.com/processors/intel-core-i7-13700>
- RTX 3060 compute（79,191 OpenCL）：<https://browser.geekbench.com/gpus/nvidia-geforce-rtx-3060>
- RTX 4070 Laptop compute（110,373 OpenCL）：<https://browser.geekbench.com/gpus/nvidia-geforce-rtx-4070-laptop>
- Geekbench OpenCL chart：<https://browser.geekbench.com/opencl-benchmarks>
