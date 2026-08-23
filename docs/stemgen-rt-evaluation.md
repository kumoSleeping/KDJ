# StemgenRT / HS-TasNet 隔离评测（M2）

评测日期：2026-08-16，播放链复测：2026-08-18。结论先行：**当前 pinned 权重不通过
KDJ 的双 Deck / 高质量 STEM 准入（No-go）**。单 Deck 加 250 ms 缓冲后可以连续播放，
但尾延迟没有即时逐-hop 余量；双 Deck 是稳定落后的。它的分离质量也明显低于 SCNet。
更重要的是，这个精确 checkpoint 的训练来源与权重再发布授权无法证实。KDJ 可把它保留
为用户明确选择的单 Deck 低延迟实验路径，但不应把它当成默认高质量模型、承诺双 Deck
实时能力，或随安装包再分发；SCNet 仍应保留为后台精修。

本文件和 [`../scripts/stemgen-rt-eval.cpp`](../scripts/stemgen-rt-eval.cpp) 是研究工具，
不属于 KDJ 运行时。它们不会写入 KDJ 数据目录、不会创建歌曲缓存，也不把权重放进
仓库。

## 固定对象与方法

| 项目 | 值 |
| --- | --- |
| 测试机 | MacBook Air M2，8 CPU cores，16 GB unified memory，macOS 26.5 |
| StemgenRT 提交 | `eaaba4fe8ed77a312ddaee34948bea34e0cbc30b` |
| 模型路径 | `/Users/kumo/Frameworks/stemgen-rt-artifacts/eaaba4f/` |
| `model.onnx` SHA-256 | `3e6432f8704c44ed61f9709296acea07112913a62cc7465b1ea44071197f58b1` |
| `model.onnx.data` SHA-256 | `355f036eb618a03b878e01e5da1b4b0e5463c725c4cb2ed18f94888003c7d722` |
| ONNX Runtime | 官方 arm64 macOS `1.22.0` CPU build；没有 CUDA、Core ML 或 Neural Engine |
| session 选项 | `ORT_ENABLE_ALL`、intra-op `4`、inter-op `1`，与 pinned StemgenRT 的 CPU 选项一致 |
| 模型 I/O | `audio: [1, 2, 2560]`，`separated: [1, 4, 2, 2560]`；每次消费中央 512 samples |
| deadline | 512 / 44,100 = **11.610 ms** |

模型内嵌 metadata 标识输入 checkpoint 为 `hs-tasnet.ckpt.1673.pt`，其 SHA-256 为
`07d256c8b4823d863f86561032e56c10d5af47dd0a3596f7db4a59207d91a1a8`。这把 ONNX 文件
和一个 checkpoint 名称/hash 联系起来，但**不是** checkpoint 的下载来源、训练清单或
许可证。

### 可复跑的吞吐工具

以下命令仅在 `/tmp/kdj-stemgen-rt-evaluation` 产生可删除的 runtime、二进制和试听
文件。官方 ORT archive 的 SHA 应在引入正式测试资产前另行固定；本次模型 hash 已如上
固定。

```zsh
root=/tmp/kdj-stemgen-rt-evaluation
mkdir -p "$root/ort"
curl -fL -o "$root/ort/ort.tgz" \
  https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-osx-arm64-1.22.0.tgz
tar -xzf "$root/ort/ort.tgz" --strip-components=1 -C "$root/ort"
clang++ -std=c++20 -O3 -Wall -Wextra -Werror scripts/stemgen-rt-eval.cpp \
  -I"$root/ort/include" -L"$root/ort/lib" -lonnxruntime \
  -Wl,-rpath,"$root/ort/lib" -o "$root/stemgen-rt-eval"

model=/Users/kumo/Frameworks/stemgen-rt-artifacts/eaaba4f/model.onnx
"$root/stemgen-rt-eval" bench "$model" 1 1000
"$root/stemgen-rt-eval" bench "$model" 2 1000
```

`bench` 为每个 Deck 建立独立 ORT session，在单独 worker 中按 11.610 ms 的理想发布
时刻提交 1,000 个 chunk。延迟包含输入 tensor 创建、`OrtRun` 和输出 tensor 创建；不
包含音频设备、解码和 KDJ mixer。因此这是模型核心的有利测量，不是产品端到端最坏值。
`deadline_misses` 是该 chunk 没有在本周期结束前完成的次数，不等同于有 16-chunk
ring buffer 的实际 audible underrun 次数。

`bench-wav` 使用实际 44.1 kHz stereo PCM16 内容逐 hop 构建 2,560-sample input；它与
`bench` 使用同一 session/thread/deadline 计时，额外包含窗口复制：

```zsh
"$root/stemgen-rt-eval" bench-wav "$model" input.wav 200
```

20 个不同本地曲目 excerpt、每首 200 hop 的复测合计 4,000 hop：service mean 为
**9.975 ms**，每曲 P95 平均 **12.621 ms**（8.792–19.172），P99 平均 **23.305 ms**
（9.671–52.717），共 **1,516/4,000 deadline miss**。连续运行后半段出现明显长尾，不能
用前几首较快结果承诺稳定 P99。完整匿名数组保存在
[`../research/stems/results/m2-rt3s-stemgen-2026-08-18.json`](../research/stems/results/m2-rt3s-stemgen-2026-08-18.json)。

## M2 结果

### 首次与驻留初始化

第一次触及 211 MB 模型文件时，session 创建为 **1,141.235 ms**，首个 `Run` 为
**72.270 ms**，所以仅 ORT environment + session + 首输出约 **1.223 s**。随后 OS
page cache 已驻留时，独立进程的同一阶段为 environment **10.691 ms**、session
**275.711 ms**、首个 `Run` **12.277 ms**，合计 **298.748 ms**。

macOS 不允许非特权用户执行 `purge`，所以这里诚实地报告“首次文件触及”与“page-cache
驻留”两种观测，而不把任何一个包装成重启机器后的保证最坏值。它仍明显比当前 SCNet
约 4–5 秒的冷首块短，但不改变双 Deck 结论。

### 连续 1,000 chunk（约 11.6 秒 nominal input）

| 负载 | p50 | p95 | p99 | max | deadline misses | RSS | 进程 CPU | 判断 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 Deck | 9.134 ms | 11.838 ms | 15.627 ms | 52.736 ms | 187 / 1,000 | 674.625 MiB | 366.966% | 平均为 0.826× deadline，但 p95 已越线 |
| 2 Deck，Deck 1 | 22.864 ms | 36.545 ms | 48.105 ms | 78.554 ms | 1,000 / 1,000 | 1,012.562 MiB（两 session） | 587.932%（全进程） | 1.97× deadline，持续积压 |
| 2 Deck，Deck 2 | 22.918 ms | 39.270 ms | 55.875 ms | 83.088 ms | 1,000 / 1,000 | 同上 | 同上 | 1.97× deadline，持续积压 |

单 Deck 可以用 StemgenRT 的 16-chunk 队列吸收一部分尖峰（约 185.8 ms），但这不是双
Deck 的余量。两个 Deck 的中位服务时间已接近两个周期；无论 queue 多大都会耗尽。因此
“HS-TasNet 在 M2 CPU 上作为两个同时播放 Deck 的即时 Preview”是性能 **No-go**。

### 2026-08-18 播放事故复测

针对“只听到连续噗噗声、调低/静音单个 lane 也听不到有效内容”的实际故障，重新分开测了
模型核心和 KDJ 播放链，避免把实现错误误判为 checkpoint 本身：

1. 同一模型做 200-hop 独立复测，单 Deck `mean 8.732 / p50 8.396 / p95 10.921 /
   p99 12.517 / max 13.161 ms`，9/200 超过 11.610 ms deadline；冷 session + 首输出为
   1,332.885 ms。
2. 双 Deck 200-hop 复测仍为明确 No-go：两边 p50 为 23.010/24.250 ms，p95 为
   43.461/44.027 ms，均为 200/200 deadline miss。启动缓冲只能吸收尖峰，不能修复持续
   低于实时的总吞吐。
3. 故障现场的 KDJ 诊断为 `model load 1295 ms / first 14 ms / p95 12 ms /
   processed 3287 / late 1698 / output gaps 312`。原先只积累 24 ms 便把 STEM ring 交给
   callback，确实把模型尾延迟直接变成了周期性断粮。
4. 另一个独立实现错误发生在非 44.1 kHz 文件：Symphonia 解出一个大 packet 后，旧代码
   只拿当前窗口需要的样本并丢掉其余 PCM；下一 512-frame hop 从下一个 packet 继续，等于
   每 hop 跳过一段源音频。用户现场曲目是 48 kHz FLAC，因此模型收到的是一串不连续短块，
   输出自然接近静音，只剩 packet/hop 边缘爆点。

修复后，解码器保留 packet 余量并做连续 48→44.1 kHz resample；相邻模型估计按参考实现
做 256-frame equal-power handoff；重建增益只按真正发声的 512-frame core 计算；播放器在
安装/seek 前积累 250 ms，并在极端断粮时淡出、等 30 ms refill 后再淡入。端到端 fixture
结果（均跨过真实模型 hop seam）为：

| 输入 | 空批次 | 四轨和 / source RMS | 最差 lane seam delta / 普通 delta |
| --- | ---: | ---: | ---: |
| 44.1 kHz stereo WAV | 0 | 1.035× | 1.214× |
| 48 kHz FLAC（现场曲目 30 s 起的 20 s excerpt） | 0 | 1.029× | 1.180× |

这些结果说明这次“噗噗且无有效音频”的主因在播放链，并非模型只能输出爆点；但它们**不改变
模型质量结论**。修复的是 PCM 连续性、handoff、增益和调度，HS-TasNet raw SDR/cross-talk
仍明显落后 SCNet，双 Deck M2 CPU 吞吐也仍不合格。

## 临时试听与客观检查

所有下列文件只生成在 `/tmp/kdj-stemgen-rt-evaluation`，未写入 KDJ 数据目录，也没有
持久化歌曲缓存。`separate` 只接受 44.1 kHz stereo PCM16 WAV；它为每一个 512-sample
hop 反射补齐 1,024-sample 前/后上下文，写出 `drums`、`bass`、`vocals`、`other` 四个
临时 WAV：

```zsh
ffmpeg -i INPUT -t 45 -ar 44100 -ac 2 -c:a pcm_s16le "$root/input.wav"
"$root/stemgen-rt-eval" separate "$model" "$root/input.wav" "$root/audition"
# $root/audition-{drums,bass,vocals,other}.wav
```

### 私有试听 excerpt（45 s）

对一段本地含人声音乐，四轨相加相对于原 mix 的 RMS 为 **−0.716 dB**，重建残差为
**−18.355 dB RMS relative to source**。0–250 Hz 的四轨能量分布为 Drums 79.77%、Bass
14.59%、Other 5.44%、Vocals 0.20%。这只能说明 raw model 的低频主要进入 drums；它
不是“kick 归属正确”的真值证明。

对 30 秒本地 off-vocal 片段，raw vocals stem 的 RMS 为原 mix 的 **−31.564 dB**，但峰值
仍达到 −6.455 dBFS，必须试听瞬态而不能只看 RMS。10 秒数字静音的 raw model 输出也
不是零：各 stem RMS 为 −76.56 至 −85.10 dBFS，最大峰值为 −65.20 dBFS。

同一份既有 `dj-test-11s.wav` 也已生成可直接 A/B 的四轨：

- HS-TasNet raw：`/tmp/kdj-stemgen-rt-evaluation/dj-11s-hstasnet-{drums,bass,other,vocals}.wav`
- SCNet Small MPS：
  `/Users/kumo/Frameworks/kdj-scnet-eval/results/hot-cue-cache/scnet-small-official/mps/{drums,bass,other,vocals}.wav`

HS-TasNet 四轨在此片段的和相对于 source 的残差为 **−18.983 dB RMS**。试听文件已经
准备好，但本轮没有把机器生成的数字误报成主观听感；人耳需在相同 gain 下检查 vocals
串音、kick/bass 归属、边界和静音段后才能给出主观通过结论。

这些试听是**模型 raw output**，未复刻 StemgenRT plugin 的 HP/LP reinjection、输入归一
化、low-band stabilizer、vocals gate 和 soft gate。因此 plugin 声称的静音门限只能待它
自己的完整信号链验证，不能据此把 raw 静音噪声当作最终产品行为；反过来，也不能把 gate
未实测地当成质量已通过。

### 同一 MUSDB 7 excerpt 真值基线

为了避免只用无真值私有音乐作结论，使用既有 SCNet 调研中的相同 7 个 MUSDB test
excerpt。直接 ONNX 输出（仍未加 plugin post-processing）的均值如下；SDR 越高越好，
泄漏和误差越负越好。

| 模型 / 路径 | Drums SDR | Bass SDR | Other SDR | Vocals SDR | Vocal→Other bleed | Drums→Bass | Bass→Drums | 重建 SDR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pinned HS-TasNet raw ONNX | 3.078 | 2.560 | 0.262 | 0.955 | −7.622 dB | −11.979 dB | −10.510 dB | 18.911 dB |
| SCNet Small Core ML/MPS（既有评测） | 8.385 | 6.177 | 2.223 | 5.446 | −20.655 dB | −32.002 dB | −26.222 dB | 30.244 dB |

raw ONNX 的 quality 明显落后当前 SCNet 基线，尤其是 other/vocals 和 source cross-talk。
由于两者的 streaming post-processing 不完全相同，这张表不是可发表的最终模型排名；但
它足以否定“无需完整听感/链路验证便以该 raw 权重替代 SCNet”的主张。

## 权重来源与授权审计

确认的事实：

1. StemgenRT pinned commit 的源码许可证是 MIT（`LICENSE.md`，Copyright 2026 Axel
   Delafosse）。
2. ONNX metadata 指向的 HS-TasNet 源码仓库在
   `/Users/kumo/Frameworks/HS-TasNet`（本次新 clone，HEAD
   `fd8e33dc6f522f9ccf83b6bb7c7cd5d01ae87375`）的**源码**许可证是 MIT（Copyright
   2025 Phil Wang）。README 只展示训练后从本地 `./checkpoints/...` 加载 checkpoint；
   默认训练脚本可连接 MUSDB，亦允许 in-house dataset。
3. 该 HS-TasNet repository tree 没有 `.pt` checkpoint；GitHub Releases API 返回空数组。
   仓库没有为 `hs-tasnet.ckpt.1673.pt` 或它的 SHA 发布 artifact、训练 manifest、数据集
   组合、权重许可证或再分发许可。

所以 MIT 只覆盖这两个仓库的源码，**不证明**精确 checkpoint 的训练数据权利，也不授予
模型权重的再发布/商用权利。除非权重作者给出可归档的 checkpoint 下载来源、训练数据与
许可证清单，以及覆盖该 hash 的书面再发布许可，KDJ 不得把它列为可交付模型。

## 决策与下一步

| 选项 | 决策 | 原因 |
| --- | --- | --- |
| 只继续 SCNet | 已否决（作为唯一即时路径） | 7.8 s 窗口与冷首块不符合 DJ seek。 |
| HS-TasNet 低延迟 Preview（StemgenRT `eaaba4f` ONNX） | **仅保留单 Deck 实验路径** | 桌面 live hop 为 512 samples / 11.6 ms，但安装与 seek 先积累 250 ms；STEM 状态不经原曲桥接。双 Deck 在 M2 CPU 上持续低于实时，不能承诺可用。 |
| 自行训练/云端蒸馏 | Deferred | 产品实时路径已改用此 pinned checkpoint；授权/provenance 限制见上文，权重按需下载、不进 git。 |

这不是对 StemgenRT 架构的否定：其异步 worker、epoch cancellation、ring buffer 和 dry
fallback 值得作为调度参考。否定的是**这个固定权重 + M2 CPU + 双 Deck + 可交付授权**
的组合。
