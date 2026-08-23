# SeekLab：实时 Stem + 类 Neural Mix 调度 — 实验报告与接入建议（交接版）

日期：2026-08-20 · 机器：MacBook Air M2 (4P+4E) / 16GB / macOS 26.5 · 性质：本地技术验证（非商业、不发布）
数据附件：`results/m2-seeklab-2026-08-20.json`（36 组 trial，camelCase 字段）
面向读者：下一位接入工作者。读完本文档应能：复现实验 → 理解数据 → 按第 9 节流程接入生产。

---

## 1. 摘要（TL;DR）

在 Apple M2 上验证了"流式小模型即时输出 + 大窗模型后台精修 + 未播放部分替换"的类 Neural Mix 分层架构：

- **随机跳转后 9.8ms 即可输出 Stem**（HS-TasNet 系流式模型，ORT CPU），比 Algoriddim 专利的"无感"阈值 100ms 低一个数量级；
- **精修层（Spleeter4 完整 12s 窗）615–671ms 落地**，比 3.92s 的可播放区域结束早 **~3.3s**，可无感替换未播放部分；
- 架构收益是数量级的：不改任何模型，跳转后首输出从 ≥615ms 降到 9.8ms（**~65×**）；
- 主要风险在**双 Deck 并发算力**（流式单实例约占 2.9 核），解法在调度层而非模型层；
- **没有更优的开放权重即时层可替换**（详见第 7 节）；论文最强候选 RT-STT（5.17 cSDR / 383K 参数）未发布权重。

## 2. 测试环境与方法

| 项 | 值 |
|---|---|
| 机型 | MacBook Air M2 (4P+4E), 16 GB, macOS 26.5 (25F71) |
| 推理运行时 | ONNX Runtime 1.22（`ort` 2.0.0-rc.13，与生产 Deck 同构建） |
| 对照后端 | ORT CPU（4 intra-op 线程）/ CoreML CPU+GPU / CoreML All（含 ANE） |
| 实验实现 | `crates/kdj-stems/src/seeklab.rs`（引擎）、`crates/kdj-stems/examples/seeklab_bench.rs`（批量基准）、`crates/kdj-stems/examples/coreml_probe.rs`（EP 探针）、应用内"Stem 跳转实验台"窗口 |
| 计时 | `Instant` 墙钟 + `getrusage` 进程 CPU；稳态值取同形状多次推理最小值 |

测试语料（本地全时长曲目 4 首，覆盖 4 类型；`/Users/kumo/Music/网易云音乐/`）：

| 类型 | 曲目 | 时长 |
|---|---|---|
| 流行 | 自分REST@RT (M@STER VERSION) — 765PRO ALLSTARS | 346s |
| EDM | dream myself! — fripSide | 278s |
| 人声明显 | Light Colors — Lia | 398s |
| 鼓组复杂 | 六兆年と一夜物語 — Leoneed/初音ミク/堀江晶太 | 215s |

矩阵：4 曲 × 3 跳转点（30s / 60s / 50%）× 3 后端 = **36 组 trial**。注意 `/Users/kumo/Music/test/` 下的文件是 30s 预览片段，不可用作跳转实验语料。

## 3. 模型盘点（本地 + 公开渠道）

### 3.1 本机可用

| 模型 | 位置 | 许可 | 本实验角色 |
|---|---|---|---|
| **HS-TasNet 系（StemgenRT 导出）** | `~/Library/Application Support/com.kdj.app/data/stems/models/eaaba4f/model.onnx`(+210MB data)；SHA256 `3e6432f8…` 与 `reference-lock.json` 锁定一致 | MIT | **即时层**（流式：512 采样/步=11.61ms，双侧各 1024 采样上下文；动态输入长度，512 对齐；输出平面序 [鼓,贝斯,人声,其他]，已经 SNR 校准验证） |
| **Spleeter 4-stem FP16** | 同上目录 `Best-Practice-87c5b6d/spleeter4-fp16-onnx/` | MIT（社区转换） | **精修层 + 质量基准**（4×U-Net，固定 tile 527,360 采样 ≈11.96s，布局 [4.02s 前导上下文 \| 3.92s core \| 4.02s 尾部]） |
| Spleeter 2-lite FP16/INT8 | 同上目录 `sherpa-onnx-93ba771+f315b4e/` | MIT | 备选中间层（未启用） |
| SCNet-Tran / BS-PolarFormer / UVR-MDX-NET-3 | `~/Frameworks/kdj-stem-model-eval/` | 见各模型 | 离线质量层候选（本实验范围外） |
| GPU Audio RT3S | `~/Frameworks/RT3SLib` 等 | CC BY-NC-SA | 已排除（见 §8） |

### 3.2 论文原版 HS-TasNet 无权重

L-Acoustics 未发布权重；lucidrains 复现无 checkpoint（`reference-lock.json` 已记录）。StemgenRT 的导出是当前唯一可用的 HS-TasNet 系开放权重。

## 4. 架构与实验设计

思想来源（仅用于理解，不作商业发布）：

- **US10887033B1（Algoriddim "Live decomposition"）**：chunk 到达即分解——固定大缓冲 + 未填部分补零（参考数据），部分填充也立刻出结果；上下文随时间增长→质量递增；专利目标 <100ms 无感 / <500ms DJ 可用。
- **US11740862B1（Algoriddim "intermediate data"）**：按（歌曲,位置）缓存中间掩码数据，二次处理仅需 STFT→乘掩码→iSTFT。对应 KDJ 已有的 stem cache（`cache.rs`）：分析过的区域再跳转 ≈ 0ms。
- **HS-TasNet 论文（L-Acoustics ICASSP 2024）**：23ms 算法延迟（1024 窗/512 步）、因果 LSTM、4 核 CPU 每 23ms 音频 4.26ms。

实验管线（对应任务书 5 条）：

1. 随机跳转直接读附近 PCM：`StereoRegionDecoder` 随机访问 + 整轨 PCM 预载（`LabPcm`），不从头分析；
2. 第一时间低上下文输出：HS-TasNet 最小窗 2560 采样（58ms）立即推理；
3. 后台算更完整上下文：Spleeter4 完整 tile 精修同一 core 区域（3.92s）；
4. 替换未来未播放部分：指标"替换余量" = 首输出时间 + core 时长 − 精修耗时；
5. 状态/缓存：Spleeter4 U-Net 无循环状态，等价物是 stem/mask 位置缓存（KDJ 已有）；HS-TasNet 的 LSTM 状态在 ONNX 导出中未外露，**无法 checkpoint 恢复**（已记录）。

窗口矩阵（小/中/大）：
- HS-TasNet 过去上下文：0 / 0.5s / 2s / 12s（自参考上限）；
- Spleeter4 前导上下文（其余补零，专利"部分填充"场景）：0 / 0.5s / 2s / 4.02s（完整）。
质量指标：自我收敛 SNR（vs 各自最大上下文输出）+ 跨模型 SNR（vs Spleeter4 完整窗）。**跨模型 SNR 只反映两个模型的一致程度，不是绝对质量分**。

## 5. 实测数据（36 组 trial 聚合；最终 JSON 为准）

### 5.1 延迟与吞吐

| 指标 | ORT CPU | CoreML CPU+GPU | CoreML All(ANE) |
|---|---|---|---|
| **跳转后首个 Stem 输出** | **9.8ms**（min 8.9 / max 12.6） | 9.5ms | 9.5ms |
| HS-TasNet 流式跟随 mean / p95（hop 预算 11.61ms） | 10.2 / 11.5ms（max 17.6） | 9.8 / 10.5ms | 9.7 / 10.4ms |
| Spleeter4 精修 tile（稳态 / 冷启动） | **671 / 762ms** | 1027 / 1161ms | 1028 / 1142ms |
| **替换余量**（>0 = 精修可无感替换未播放区） | **+3263ms** | +2906ms | +2905ms |

解读：
- HS-TasNet 流式跟随在 CPU 上 p95 恰好卡在 hop 预算边缘（mean 11.5ms vs 预算 11.61ms，个别 hop 到 17.6ms）——**单实例可行但没有余量**，这是双 Deck 风险的主要来源（见 §5.4）。
- **CoreML（含 ANE）对 Spleeter4 FP16 比纯 CPU 慢 ~55%**（1027ms vs 671ms 稳态）。ANE 选项无额外收益。本机 M2 + 该模型 + ORT 1.22 的实测事实。
- **HS-TasNet + CoreML 创建 session 时段错误**（1D 卷积 + LSTM + 动态形状；FP16 转换后依旧），强制 CPU。与 StemgenRT 作者"该模型不适合 GPU"的说明一致。

### 5.2 CPU 占用（单 Deck 单实例）

| 阶段 | 占用 |
|---|---|
| HS-TasNet 流式跟随 | ≈ 2.9 核（8 核的 ~36%） |
| Spleeter4 tile 精修 | ≈ 1.9 核 |

### 5.3 质量收敛（SNR/dB，CPU trials n=12；格式 鼓/贝斯/其他/人声）

Spleeter4 前导上下文 → vs 完整上下文（自我收敛）：

| 上下文 | 鼓 | 贝斯 | 其他 | 人声 |
|---|---|---|---|---|
| 0s（纯零填充） | 17.1 | 15.8 | 12.6 | 14.4 |
| 0.5s | 19.5 | 18.6 | 16.1 | 17.6 |
| 2s | 25.7 | 25.1 | 22.0 | 24.2 |

→ 零上下文输出已达可用级别（12–17dB）；2s 上下文接近最终质量（22–26dB）。**"部分填充立刻分解"在真实模型上成立。**

HS-TasNet 过去上下文 → vs 自身 12s 窗（自我收敛）：

| 上下文 | 鼓 | 贝斯 | 其他 | 人声 |
|---|---|---|---|---|
| 0s | 12.6 | 8.8 | 5.4 | 10.3 |
| 0.5s | 13.8 | 10.1 | 6.0 | 10.3 |
| 2s | 14.4 | 11.1 | 7.2 | 11.9 |

→ 流式模型的收敛梯度平缓（为 23ms 上下文设计）；其即时输出质量即其稳态质量的 ~85–90%。

### 5.4 分曲目稳健性

四种类型曲目延迟差异很小（首输出 8.9–10.4ms；精修 596–667ms），架构行为对内容类型稳健。

## 6. 任务书五问

**Q1：HS-TasNet 是否明显比 Spleeter 更适合实时？**
对即时层是决定性的（唯一能 <10ms 出首帧）；但质量弱于大窗 Spleeter4，且 CoreML 路径崩溃。**结论：不是二选一，而是分层——HS-TasNet 负责"立刻有"，Spleeter4 负责"稍后好"。**

**Q2：随机跳转后最快多久能听到 Stem？**
实测 **~9.8ms**（PCM 已驻留；区域解码增量也是 ms 级）。整轨解码（0.7–2s/首）是一次性后台成本，不在跳转关键路径。

**Q3：不改模型只改架构，提升是否明显？**
数量级提升：同机同模型，首输出 ≥615ms → 9.8ms（~65×）；精修在区域播完前 3.3s 落地，可无感替换；零上下文 Spleeter4 已有 12–17dB SNR 可用。

**Q4：有机会做到类似 DJ 软件的体验吗？**
单 Deck 已达标。风险是双 Deck 并发：流式 ~2.9 核/实例 × 2 + 精修 ~1.9 核 × 2 会压满 M2 的 4 个性能核（8/18 研究的双 Deck P99 no-go 互证）。解法在调度层（见 §9），不是原理障碍。

**Q5：下一步优化调度还是找新模型？**
先调度（确定性收益），模型侧盯住 RT-STT（见 §7）。不建议：让 Spleeter4 承担即时层（固定窗原理限制）、指望 ANE 加速现有 FP16 U-Net（实测更慢）。

## 7. 即时层候选盘点（开放权重 + 实时 + 音乐 Stem）

| 候选 | 权重 | 许可 | 延迟 | MusDB 质量 | 判定 |
|---|---|---|---|---|---|
| HS-TasNet（StemgenRT 导出） | ✅ 本机 | MIT | 23ms 窗 | 论文 4.65（同类权重） | **当前即时层，唯一可直接使用** |
| **RT-STT**（arXiv 2511.13146，南京大学，2025-11） | ❌ 未发布 | — | 23ms 窗 | **cSDR 5.17** | 论文最强：383K 参数（1/100）、FP16 后 GPU 1.01ms/帧；作者公开仓库仅有 DTTNet；无社区复现（GitHub 已查） |
| HS-TasNet-Small | ❌ | — | 23ms | 4.48 / 5.01（加数据） | L-Acoustics 与 sweetspotsoundsystem 均无 release |
| BSRNN（crlandsc 预训练） | ⚠️ 仅 vocals/bass 单源 | MIT | 非流式（整句双向 RNN） | 高（离线） | 因果化需重训 |
| 因果 X-UMX / TasNet-frugal | ❌ | — | 23ms | 3.93 / 4.40 | 比现有层差 |
| Moises-Light（WASPAA 2025） | ❌（论文不发代码，复现无权重） | MIT(代码) | 6s 窗非流式 | 离线级 | 定位不符 |
| GPU Audio RT3S | ✅ 本机 | CC BY-NC-SA | 512 采样步 | 未公开 | 8/18 实测排除：双 Deck P99 越界 + **跳转状态 ≤1000ms 预滚不收敛** |
| htdemucs-onnx / Mini-BS-RoFormer 46.8M / SCNet 等 | ✅ HF | 各异 | 秒级上下文 | 离线 SOTA | 只能竞争精修层 |

检索覆盖：HF 全站（"hs-tasnet"/"music separation streaming"/"causal music separation"/"real-time music demix" 均无其他结果）、GitHub、arXiv 2024–2026。

**结论：今天没有可即插即用的更优开放权重即时层。** 最短突破路径：
1. **RT-STT**：给作者发邮件求权重（Nanjing University，junyuchen-cjy），同时备手复现（论文结构完整：因果 TFC-TDF + 单路径 LSTM，1024 窗/512 步/384 频 bin，L=3，g=16；MusDB-HQ 研究用途可训）。383K 参数意味着 M2 推理成本可能低一个数量级，双 Deck 即时层立刻宽松。
2. 监控 sweetspotsoundsystem/HS-TasNet 是否放出 HS-TasNet-Small 权重（16M，论文 1.83ms/4核）。

## 8. 已否决路径（留下证据，不要重复踩坑）

| 路径 | 结果 | 证据 |
|---|---|---|
| HS-TasNet → CoreML EP | session 创建即段错误（FP32/FP16 均然） | `examples/coreml_probe.rs`；exit 139 |
| StemgenRT FP16 量化 | ORT CPU 无 FP16 加速路径：首输出 9.0→10.4ms 更慢，质量无改善 | `~/Frameworks/stemgen-rt-artifacts/fp16/README.md` |
| Spleeter4 → CoreML GPU/ANE | 比 CPU 慢 ~55%（1027 vs 671ms）；生产"自动"档当前走 CoreML GPU，值得复核 | §5.1 |
| RT3S 作即时层 | 双 Deck P99 越界；跳转状态不收敛 | `results/m2-rt3s-stemgen-2026-08-18.json` |
| 缩短 Spleeter4 输入窗 | 模型输入形状固定 [2,1,512,1024]，仅 num_splits 动态（多 tile 批维） | onnx 图检查 |

## 9. 推荐接入流程（给下一位工作者）

### Phase 0：复现（半小时）

```bash
cd /Users/kumo/git/kdj
# 批量基准（约 10 分钟）
cargo run -p kdj-stems --release --example seeklab_bench -- \
  --track "流行:<全时长曲目>.mp3" --seeks 30,60,50% \
  --backends cpu,coreml-gpu,coreml-all \
  --out research/stems/results/<date>.json
# 应用内交互实验
CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER="$PWD/scripts/tauri-dev-gui-runner.sh" npm run tauri:dev
# 设置 → STEM → 跳转实验台；GUI 自动化目标：com.kdj.dev / /tmp/KDJ Dev.app（不要碰 com.kdj.app）
```

### Phase 1：双 Deck 并发验证（接入前置，1–2 天）

当前最大未知量是并发。扩展 `seeklab_bench`（或加 `--dual`）模拟：2 条 HS-TasNet 流式 + 2 个 Spleeter4 精修并发，在 M2 上测 hop 准时率与精修落地余量。
- 若 p95 越界：实现**优先级调度**——即时层（流式跟随）永远优先，精修层让路/降频；精修本来就是后台任务，延迟 200–500ms 落地不影响体验（替换余量有 ~3.3s 缓冲）。
- 预期工作量集中在 `crates/kdj-stems/src/live.rs`（推理池/ticket 调度）加一个优先级维度。

### Phase 2：生产接入（2–4 天）

接入点（均已存在基建）：
1. `crates/kdj-stems/src/live.rs`：加"即时层通道"——HS-TasNet 会话常驻（参照 `seeklab.rs::SeekLab` 的 session 构建与 `hstasnet_infer`），512 采样步进，写 `StemChunk`；保持铁律：**音频回调里绝不做推理**。
2. 跳转路径：`dj.rs` 已有 `DeckStemSeekControl`/`PcmRandomAccessCache`——seek 时即时层从 `seek_frame` 直接起流，不等任何分析。
3. 精修替换：Spleeter4 tile 完成后只替换播放头之后的帧（替换余量指标已在 seeklab 验证 ~3.3s）。衔接处做 5–10ms 交叉淡化（参照 StemgenRT 的 `kCrossfadeSamples=256` 做法）。
4. 缓存：`cache.rs` 落盘精修结果（专利 2 路线）——同一区域再次跳转 ≈ 0ms；这也是重跳频繁的 DJ 场景的最大体验杠杆。
5. StemgenRT 的产品级 DSP 可选移植：LR4 250Hz 低分频 + LP 回注（稳低频）、人声门、软门——裸模型听感有底噪，这些在其 `plugin/include/StemgenRT/Constants.h` 有完整参数。
6. UI 规则遵守：空态不放提示文案，动作以 `+` 类控件呈现（见 AGENTS.md）。

### Phase 3：模型升级（并行跟踪）

- RT-STT 权重（邮件/复现）→ 到手后导出 ONNX，drop-in 替换即时层（seeklab 的模型目录约定已支持 env 切换：`KDJ_SEEKLAB_HSTASNET_DIR`）；
- HS-TasNet-Small 权重监控；
- 精修层如需升级，评 SCNet-Tran / BS-RoFormer 家族（`kdj-stem-model-eval` 已有候选与基建），但与即时层解耦、独立演进。

### 验收标准建议

- 单 Deck：首输出 ≤ 20ms；流式 p95 ≤ 11.6ms；精修替换余量 > 0；
- 双 Deck：两路流式 p95 ≤ 11.6ms（精修允许让路）；无音频回调推理（现有测试已守门）；
- 重跳已分析区域：首输出 ≤ 5ms（缓存命中）。

## 10. 边界与已知限制

- 即时层试听为裸模型 + 输入归一化，未含 StemgenRT 的产品级 DSP（低分频回注/人声门/软门）；实际接入后听感会更好。
- instant 阶段 RTF 均值含会话首次推理预热（~90–240ms）；持续成本以 stream 阶段（48 步）为准。
- 质量指标为自我收敛/跨模型一致性 SNR，非 MUSDB ground-truth SDR；需要客观榜单分可用 `~/Frameworks/kdj-stem-eval` 基建另测。
- 许可：StemgenRT 权重 MIT；Spleeter 为 MIT 社区转换版；RT3S 为 CC BY-NC-SA（KDJ 非商业可用，但已因技术原因排除）。全实验本地运行，未再分发任何权重。

## 11. 文件清单

| 内容 | 位置 |
|---|---|
| 实验引擎 | `crates/kdj-stems/src/seeklab.rs` |
| 批量基准 / EP 探针 | `crates/kdj-stems/examples/seeklab_bench.rs`、`coreml_probe.rs` |
| 服务端点 | `crates/kdj-server/src/stems.rs`（`/api/stems/lab/*`，平台门控） |
| 实验窗口 | `src/components/stem-lab/StemSeekLab.tsx`（设置 → STEM → 跳转实验台） |
| 基准数据 | `research/stems/results/m2-seeklab-2026-08-20.json` |
| 双 Deck 既有研究 | `research/stems/results/m2-rt3s-stemgen-2026-08-18.json`、`reference-lock.json` |
| FP16 负结果证据 | `~/Frameworks/stemgen-rt-artifacts/fp16/README.md` |
