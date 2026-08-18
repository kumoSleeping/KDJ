# 双 Deck 实时 STEM / RT3S 原型

结论：本轮已经跑通真实的 GPU Audio RT3S 权重、Metal processor、RT3SLib 和四轨导出，
也实现了可复用的 PCM 随机访问与双 Deck latest-request-wins 控制。但固定模型在这台 M2
上没有通过最终门槛：单 Deck P99 越过 11.610 ms，两个并发 Deck 持续积压；RT3S 的 LSTM
状态在 0–1000 ms pre-roll 后也不能可靠复现连续播放状态。因此状态是 **No-go**，没有开始
V100 训练，也没有把 RT3S backend 链接进 KDJ runtime。KDJ 已明确为非商业项目，RT3S 的
非商业条款不是当前集成阻断项；仍须满足署名、相同方式共享和 model-specific 条款。

机器可读结果在
[`research/stems/results/m2-rt3s-stemgen-2026-08-18.json`](../research/stems/results/m2-rt3s-stemgen-2026-08-18.json)，
固定对象在
[`research/stems/reference-lock.json`](../research/stems/reference-lock.json)。

## 可运行原型

[`scripts/setup-rt3s-reference.sh`](../scripts/setup-rt3s-reference.sh) 会：

1. 校验五个 reference checkout 的精确 commit，并初始化 GPU Audio SDK 的固定 submodule；
2. 下载 StemgenRT ONNX、RT3S `params.bw` 和签名/公证过的 GPU Audio Platform；
3. 对每个模型文件做完整字节数和 SHA-256 校验；
4. 在 `/tmp` 的源副本中编译 SDK、Metal RT3S processor、RT3SLib 和插件，不污染 reference
   checkout，也不向 `/Library` 安装 proprietary engine；
5. 编译 [`scripts/rt3s-dj-bench.cpp`](../scripts/rt3s-dj-bench.cpp)。

```zsh
scripts/setup-rt3s-reference.sh
source /tmp/kdj-rt3s-reference/run-env.sh

# 一个/两个 Deck，真实 GPU processor，按 11.610 ms deadline 发布 hop
$KDJ_RT3S_BENCH bench "$KDJ_RT3S_PARAMS" 1 1000 sync parallel
$KDJ_RT3S_BENCH bench "$KDJ_RT3S_PARAMS" 2 1000 async parallel

# 输入必须是 44.1 kHz、双声道、interleaved float32 PCM
$KDJ_RT3S_BENCH seek "$KDJ_RT3S_PARAMS" track.f32le 862 87
$KDJ_RT3S_BENCH audition "$KDJ_RT3S_PARAMS" track.f32le /tmp/rt3s-audition 0 861
```

`bench` 输出 process service 和从理想 release 到完成的平均/P50/P95/P99/max、deadline
miss、host CPU、physical footprint、非有限样本，以及 250 ms 输出环的 starvation
simulation。simulation 不是实际声卡 callback underrun，字段名有意保留这一限定。

`seek` 先连续处理到目标位置作为 reference，再对 0/50/100/250/500/1000 ms pre-roll
逐一销毁并重建 processor state。它输出首块 waveform NRMSE、逐 hop SDR、首个 10 dB
proxy 和连续五块 30 dB proxy。阈值只是相对连续 reference 的自动化回归标准，不冒充
人耳结论。

`audition` 从真实模型写出 `drums/bass/vocals/other` 四个 44.1 kHz stereo float WAV。
本轮 9.996 s artifact 的四轨和与 source 的左右声道 PSNR 为 174.989/175.028 dB，说明
导出顺序、overlap 和写盘链没有丢 mix；四个独立文件也都做了 SHA-256。没有伪造“已
试听通过”：当前执行环境没有人类听感输入，所以主观串音、kick/bass 归属仍是未评分项。

## DJ transport contract

[`crates/kdj-stems/src/dj.rs`](../crates/kdj-stems/src/dj.rs) 增加了 runtime-independent
transport primitive：

- `PcmRandomAccessCache` 持有一次解码/重采样后的 immutable 44.1 kHz stereo PCM；
- `rt3s_window(frameIndex)` 直接复制 `[frameIndex-512, frameIndex+512)`，歌曲边缘补零；
- `DeckStemSeekControl` 用 atomic seqlock 发布 `{generation, frameIndex}`；连续 Hot Cue
  只保留最后一个 generation，旧 GPU job 即使跑完也不能 publish；
- `DualDeckStemSeekControl` 明确分开 A/B generation。PCM 和未来的 immutable 权重可以
  共享，但 LSTM state、input/output history 和音频环不能共享。

这些 primitive 的四个单元测试覆盖任意 PCM 窗口、边缘 padding、旧 generation
失效、双 Deck 隔离和 NaN/Inf 清理。它们只供 decode/inference worker 调用；音频
callback 不会文件解码、模型推理、锁、分配或重置模型。

KDJ 当前 native player 已有 bounded stream ring、每 Deck underrun atomic、audio 优先级
inference lane 和 callback-only consumer。StemgenRT 路径的 seek 也已通过 atomic generation
retarget 同一个 worker。新 PCM/seek primitive 把未来 stateful backend 缺少的随机访问
和明确 generation contract 补齐。原型没有把 RT3SLib FFI 塞进 Tauri 路径的原因是本轮
runtime/Seek No-go，而不是非商业许可。

## 固定仓库、许可和 checkpoint 真实性

| 对象 | Commit | 源码许可 | 真实权重 | 平台/用途 |
| --- | --- | --- | --- | --- |
| StemgenRT | `eaaba4fe8ed77a312ddaee34948bea34e0cbc30b` | MIT | ONNX pair 已下载校验；但精确训练 checkpoint 的训练清单和权重再发布许可未找到 | macOS/Windows/Linux plugin；KDJ 只把它当研究/用户下载的现成低延迟基准 |
| GPU Audio SDK | `4cde62009594e0f4f1db712d27be4fea8b0d06c8` | CC BY-NC-SA 4.0 | SDK 不是 checkpoint | Windows 11；macOS 13/14/15/26；商业集成需另谈许可 |
| RT3S Processor | `f0631f5f7d1460d5ba9b9d4f456722315fa0c1d2` | CC BY-NC-SA 4.0 | processor repo 本身不含参数 | CUDA/HIP/Metal processor source |
| RT3SLib | `2de98f8129073927f7a7dc4fb2629535ebf70c79` | repo LICENSE 为 CC BY-NC-SA 4.0；部分文件头另写 proprietary | 独立 repo 的 `deps/params` 为空 | sync 和 async double-buffering client；没有 reset/state import/export API |
| lucidrains HS-TasNet | `5bd950260d26efb2797c7c2d8b101c77f69abda7` | MIT | **没有公开 checkpoint**：Git tree 没有 `.pt/.pth/.ckpt/onnx`，GitHub release 也都没有 asset | Python 训练、save/load 和 stateful stream reference；不是可交付权重 |

有一份真正公开、可下载、已校验的 **GPU Audio RT3S model**：

- archive `RT3S_model.zip`: 185,693,806 bytes，SHA-256
  `3e9bf313557081abcc5fd54f448f21702964253277cd6cce56bd53b88406a935`；
- `params.bw`: 200,653,256 bytes，SHA-256
  `0bbc9b0e335e38e11585e340192421f5fb9e44e49edd0fb3c482377aa4e3bad9`；
- archive 内含独立 Model License，明确只允许 research/evaluation/academic/demo、禁止商业
  产品/SaaS/最终用户服务，并说明训练数据是 MUSDB18。

这份参数不是“论文提到模型”，而是实际进入 processor 并生成了四轨的 artifact。反过来，
lucidrains README 中的 `./checkpoints/path.to.desired.ckpt.pt` 只是本地加载示例，不能写成
“公开提供 checkpoint”。StemgenRT ONNX metadata 中的 `hs-tasnet.ckpt.1673.pt` 名称和
hash 也不能替代 checkpoint 的下载来源及许可证。

## RT3S 单 frame 数据流

固定 processor 的 learned parameter 数是 **50,163,208**。`params.bw` 有 53 个 tensor，
每个 tensor 前有 8-byte 长度；`(200,653,256 - 53×8) / 4` 与源码维度逐项求和一致。

```text
当前 512 stereo samples
  + input_history 中前 512
  = 1024-sample stereo window
        │
        ├─ 1024 STFT，2×513×(real,imag)=2052 → Linear 500
        │     → pre-spec LSTM: 2 layers, hidden 500
        │
        └─ Conv1D 2→3000, kernel/stride 1024/512
              → ReLU×sigmoid = 1500 basis → Linear 500
              → pre-wave LSTM: 2 layers, hidden 500
                    │
              concat 1000 → fusion LSTM: 2 layers, hidden 1000
                    │
              split + encoded residual
                    ├─ post-spec LSTM 2×500 → current-vector RMSNorm
                    │    → Linear 8208 mask = 4×2×513×complex → iSTFT
                    └─ post-wave LSTM 2×500 → current-vector RMSNorm
                         → Linear 6000 mask = 4×1500 → ConvTranspose1D
                    │
              spec + waveform branch，四个 stereo source
                    │
              上一 call 的 512 output overlap + 当前 window 前 512
              当前 512 输出；后 512 留给下一 call
```

RT3S 源码的 README 把 frequency feature 写成 `252`，但可执行源码是
`Linear<2052,500>`，mask 也是 `4×2×513×2=8208`；本原型以代码和实际参数文件为准。

## 全部跨块状态

| 状态 | 尺寸 | Seek 要求 |
| --- | ---: | --- |
| input history | `2×1024` float ring | 清零或恢复；只喂目标前 512 并不等价于恢复 LSTM |
| spectrogram output overlap | `8×1024` float ring | 清零或 checkpoint restore |
| waveform output overlap | `8×1024` float ring | 清零或 checkpoint restore |
| pre-spec LSTM | 2 层，每层 h/c 各 500 | 每 Deck 独立 |
| pre-wave LSTM | 2 层，每层 h/c 各 500 | 每 Deck 独立 |
| fusion LSTM | 2 层，每层 h/c 各 1000 | 每 Deck 独立 |
| post-spec LSTM | 2 层，每层 h/c 各 500 | 每 Deck 独立 |
| post-wave LSTM | 2 层，每层 h/c 各 500 | 每 Deck 独立 |
| host counters | `ringbuffer_cursor`、`running_counter` | 与 ping-pong h/c parity 一起恢复 |
| RMSNorm | 500 learned scales + 当前 vector RMS | **没有跨块 running normalization state** |

语义 checkpoint 约为 12,000 个当前 h/c float + 18,432 个 history/overlap float，再加
counter，约 122 KiB。GPU primitive 为 h/c 保存两份 ping-pong storage，物理对象更大；
restore 时要同时恢复 parity/alternate buffer，不能只拷一份 h。

RT3SLib 目前 `SetData` 是 no-op，`GetData` 直接失败，public interface 也没有 reset、
export state 或 import state。现有“reset”只能 `disarm()` 删除 processor，再 `arm()` 重建，
本机花 89–181 ms，已经单独超过 30 ms Hot Cue 目标。

## M2 实测

### 20 首输入

同一批 20 个本地不同曲目 excerpt 分别喂 StemgenRT 和 RT3S；文件名不进入仓库。每首
200 hop，总计 4,000 hop。这里的 underrun 是 deadline/ring simulation，不冒充声卡实测。

| Runtime | mean | 20-track P95 均值（范围） | P99 均值（范围） | deadline miss | CPU / memory |
| --- | ---: | ---: | ---: | ---: | --- |
| StemgenRT ONNX CPU | 9.975 ms | 12.621 (8.792–19.172) ms | 23.305 (9.671–52.717) ms | 1,516/4,000 | 348% host CPU；RSS 240–676 MiB |
| RT3S Metal sync | 9.775 ms | 11.184 (10.858–11.665) ms | 12.605 (11.850–15.205) ms | 259/4,000 | 4.79% host CPU；armed footprint 1.262 GiB |

两者单 Deck 平均吞吐都快于 hop，但 **P99 都不合格**。RT3S 的 250 ms cushion simulation
能吸收一个 500-hop单 Deck retest 的尖峰；这不能让“两 Deck P99 < deadline”变成通过。

### 两 Deck

RT3S 两个独立 async RT3SLib instance 并发 500 hop：两边 service mean 为
15.995/15.979 ms，P99 为 26.494/27.900 ms，各 498/500 deadline miss。从 ideal release
到完成的 P99 已积压到 2.20 s，250 ms ring 仍有 434/435 个 starved hop。RT3SLib 每个
instance 都复制权重、创建自己的 processor/graph；armed physical footprint 约 1.67 GiB。

所以增加 startup ring 只能延后第一次 dropout，不能修复持续低于实时的双 Deck吞吐。
StemgenRT 的既有双 Deck 1000-hop CPU 隔离结果更慢：P50 约 22.9 ms，P99 48.1/55.9 ms，
两边全部 miss。

### LSTM Seek

10.008 s target 的首块结果：

| pre-roll | Hot Cue→首输出 | 首块 SDR vs continuous | 首个 10 dB proxy | 1 s 内连续五块 30 dB |
| ---: | ---: | ---: | ---: | --- |
| 0 ms | 109.1 ms | 0.41 dB | 313.5 ms | 否 |
| 50 ms | 140.3 ms | 8.07 dB | 197.4 ms | 否 |
| 100 ms | 182.3 ms | 6.42 dB | 197.4 ms | 否 |
| 250 ms | 285.3 ms | 9.98 dB | 127.7 ms | 否 |
| 500 ms | 475.1 ms | 9.00 dB | 313.5 ms | 否 |
| 1000 ms | 851.2 ms | 20.20 dB | 0 ms | 否 |

另一处 target 的 8.13 s 长观测显示恢复不单调：50 ms pre-roll 到 3.634 s 才首次持续
30 dB；100/250 ms 接近 8 s；0/500/1000 ms 在窗口内仍没有持续五块 30 dB。结论不是
“固定用 50 ms”，而是 **短 pre-roll 不能可靠代替位置相关 LSTM state**。

## 下一道 runtime gate

### 已完成的调度/精度实验

[`scripts/rt3s-dual-graph-bench.cpp`](../scripts/rt3s-dual-graph-bench.cpp) 已验证一个
launcher/graph 内两个独立 RT3S processor、两个 input port 和两个 output callback。全质量
双 Deck mean 15.91 ms、P99 21.65 ms；相对双 launcher 的 26–28 ms P99 有改善，内存也从
约 1.67 GiB 降到 1.50 GiB，但持续吞吐仍失败。

[`scripts/rt3s-mixed-fp16-params.cpp`](../scripts/rt3s-mixed-fp16-params.cpp) 和
[`research/stems/patches/rt3s-mixed-fp16.patch`](../research/stems/patches/rt3s-mixed-fp16.patch)
把 11 个 feed-forward tensor 转成 FP16，LSTM/RMSNorm/state 继续 FP32。参数从
200,653,256 降到 164,424,840 bytes；相对 FP32 四轨的 SDR 为 62.9–71.7 dB。单 Deck
mean 降到 9.13 ms，但共享 graph 双 Deck仍是 mean 15.60 ms、P99 19.10 ms，不能交付。

在 `setup-rt3s-reference.sh` 生成的 disposable source 中复跑 mixed FP16：

```zsh
patch -p1 -d /tmp/kdj-rt3s-reference/gpuaudio-sdk-src \
  < research/stems/patches/rt3s-mixed-fp16.patch
$KDJ_RT3S_FP16_CONVERTER "$KDJ_RT3S_PARAMS" /tmp/params-mixed-fp16.bw
cmake --build /tmp/kdj-rt3s-reference/gpuaudio-sdk-build \
  --config RelWithDebInfo --target rt3s_processor_rt3s_processor --parallel
```

删除 waveform branch 的 spectral-lite patch 也保留在
[`research/stems/patches/rt3s-spectral-lite-experiment.patch`](../research/stems/patches/rt3s-spectral-lite-experiment.patch)：
双 Deck mean 9.87 ms，但 P99 12.69 ms，四轨和相对 source SDR 只有约 −2.1 dB，因此明确
拒绝。即使这个低质量版本在 M2 上也没有过严格 P99，不能声称更低端 Apple Silicon 可用。

在训练任何 Small 模型前，下一轮只做 runtime：

1. 用 GPU Audio 文档要求的 Xcode 26 在 macOS 26 复测；当前机器只有 Xcode 15.2，虽然
   Metal build 成功，不能把它包装成 vendor validated pairing；
2. 在一个 launcher/graph 中放两个 processor，验证 scheduler 是否能真正 batch 两 Deck，
   并把 immutable weights 从 processor state 中拆出共享；
3. 给 RT3S 增加 worker-only device reset 和约 122 KiB state export/import；不能用当前
   89–181 ms 的 destroy/recreate；
4. 后台按歌曲位置保存稀疏 LSTM/history checkpoint，seek 从最近 checkpoint 快进，并用
   本 harness 的逐-hop SDR 验证；
5. 只有当双 Deck P99、实际 audio callback underrun、<30 ms Hot Cue、Xcode 26 和功耗都
   通过，才运行 lucidrains 自有数据 train/save/load/stream/export 和小型 2-stem 训练。

本轮没有 `powermetrics` 数据：它需要管理员权限，当前 non-interactive shell 没有 sudo。
结果文件把功耗明确记为未测，而不是估算。为 timestretch/EQ/FX 预留算力也因此尚未证明。
