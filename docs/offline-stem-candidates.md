# DTTNet 与 SCNet Small 实测

两者都能显著快于音频时长完成推理，但都是离线、非因果模型，不能替换 RT3S 的 512-hop
callback producer。当前最有价值的用途是后台生成播放位置和 Hot Cue 邻域缓存。

机器可读结果：
[`research/stems/results/m2-optimization-offline-candidates-2026-08-18.json`](../research/stems/results/m2-optimization-offline-candidates-2026-08-18.json)。

## 资产

DTTNet 官方仓库锁定在 `890a25ea4b8e0433d5e1fe5acf92a4eab781de61`，源码为
Apache-2.0。官方 Mega 目录当前实际只有 Bass/Vocals；需要百度网盘的 Drums/Other 路线
已经关闭，不再登录、转存、下载，也不再把“补齐 DTT 四模型”列为后续验收项。已有
Bass/Vocals 数据仅保留为历史性能对照。

| Stem | 文件 | 字节 | SHA-256 | 状态 |
| --- | --- | ---: | --- | --- |
| Bass | `bassg32_ep2935.ckpt` | 50,686,772 | `ac30d7ae072a94f2b878ce53c52a6d583455378e10896af7a4681ee4c2d93d07` | 已下载、运行 |
| Vocals | `vocalsg32_ep4082.ckpt` | 59,956,788 | `7bd9654cdda816152ea09dec1a6aa2bdb216c9b3bb11984199e95590a665eff5` | 已下载、运行 |

仓库没有独立 checkpoint license；“官方 README 提供下载链接”是来源证据，不能把源码的
Apache-2.0 自动写成权重许可。

SCNet Small 的首选下载源是 ZFTurbo
[Music-Source-Separation-Training Release `v.1.0.6`](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v.1.0.6)，
release 页面明确同时列出：

- [`config_musdb18_scnet.yaml`](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v.1.0.6/config_musdb18_scnet.yaml)，1,739 bytes；
- [`scnet_checkpoint_musdb18.ckpt`](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v.1.0.6/scnet_checkpoint_musdb18.ckpt)，42,434,986 bytes。

实测实现锁定 ZFTurbo MSST `2ba884c2083070c4061fb2d5e3afc41e32420b8a`。checkpoint SHA-256
`1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa`，config SHA-256
`19103def86d549701f824804fc5f3d244e8e8ccd4032da6ee9d5b4f2a5f2da16`。源码/权重
按 MIT 发布，作者 issue 另有 checkpoint/转换件许可澄清。

## 20 首、5.92 秒 chunk

输入是 RT3S 20 首 corpus 的同一批 44.1 kHz stereo excerpt；不足 5.92 秒的 fixture 循环
填满固定 shape。每个模型驻留后逐曲推理，再以 batch=2 测相邻两首模拟双 Deck。P95/P99
是 **整块离线推理时间**，不是 512-hop latency。

### MPS

| 模型 | 输出 | 单 Deck mean / P99 | 双 Deck batch mean / P99 | 单 Deck RTF |
| --- | --- | ---: | ---: | ---: |
| DTTNet Bass | 1 stem | 0.251 / 0.259 s | 0.480 / 0.554 s | 0.042 |
| DTTNet Vocals | 1 stem | 0.540 / 0.549 s | 1.112 / 1.569 s | 0.091 |
| SCNet Small | 四轨 | 0.287 / 0.297 s | 0.598 / 0.691 s | 0.049 |

四轨 DTTNet 需要四个不同模型。按当前实际 Bass 和 Vocals 的速度，Drums/Other 若接近
Vocals，单 Deck四轨约需 1.87 秒/5.92 秒；SCNet 一次 0.287 秒就产生四轨。因此
**SCNet Small 明显更适合作为完整四轨缓存器**。DTTNet 的“小参数/单 stem”不能与
SCNet 的“一次四轨”直接比较。

MPS driver peak 同样不理想：SCNet 固定 shape 约 5.92 GiB，DTT Bass 约 5.35 GB，
DTT Vocals 在 single/batch shape 连续运行后升到 12.14 GB。产品必须固定 shape、复用
buffer 并限制同时驻留的模型。

### CPU

| 模型 | 单 Deck mean / P99 | 双 Deck batch mean / P99 |
| --- | ---: | ---: |
| DTTNet Bass | 1.503 / 1.602 s | 2.695 / 2.762 s |
| DTTNet Vocals | 3.851 / 4.008 s | 7.502 / 7.981 s |
| SCNet Small | 1.844 / 1.945 s | 3.485 / 3.682 s |

SCNet CPU 也比预计的完整四模型 DTTNet 更合适，但 CPU RSS peak 约 2.77 GiB；DTT
Vocals batch 路径约 4.52 GB。

## Seek 与边界

DTTNet 固定训练 chunk 为 261,120 samples（5.92 s），STFT 6144/hop 1024，官方 OLA
为 50%，并在 bottleneck 使用多层双向 LSTM。它没有跨请求 recurrent state，但一个位置
的结果依赖前后完整 context。SCNet Small 同样是非因果整块网络。

把同一连续输入的窗口起点平移一秒，再比较共同内部区域：

| 输出 | 两个 context 的重叠 SDR |
| --- | ---: |
| DTTNet Bass | 17.96 dB |
| DTTNet Vocals | 7.31 dB |
| SCNet 四轨 | 19.11 dB |

这说明随机切片不能仅按目标 sample 裁一块后无条件拼接；必须固定 context、裁掉边缘并做
OLA/crossfade。`generationId` 仍可在 job publish 前做到 latest-request-wins，但不能把
250–540 ms 的驻留推理或 5.92 秒算法 context 包装成 `<30 ms` Hot Cue。

建议路径：Hot Cue 已缓存时直接读 PCM；miss 时继续播原 mix，由 SCNet Small 在后台生成
固定 5.92/11 秒邻域，完成后在 block 边界 crossfade。DTTNet 保留作单目标质量/速度研究，
不作为当前四轨默认候选。

## 复跑

```zsh
PY=~/Frameworks/kdj-stem-eval/.venv/bin/python

PYTORCH_ENABLE_MPS_FALLBACK=0 "$PY" scripts/scnet-small-corpus-bench.py \
  --evaluator ~/Frameworks/kdj-scnet-eval \
  --corpus /path/to/20-wavs --device mps \
  --output /tmp/scnet-small-mps.json

PYTORCH_ENABLE_MPS_FALLBACK=0 "$PY" scripts/dttnet-bench.py \
  --repository ~/Frameworks/DTTNet-Pytorch \
  --commit 890a25ea4b8e0433d5e1fe5acf92a4eab781de61 \
  --stem bass --checkpoint /path/to/bassg32_ep2935.ckpt \
  --corpus /path/to/20-wavs --device mps \
  --output /tmp/dttnet-bass-mps.json
```
