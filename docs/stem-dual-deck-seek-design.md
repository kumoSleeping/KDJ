# 双 Deck STEM 实时跳转分层接入设计

状态：实施基线  
依据：`research/stems/seeklab-report-2026-08-20.md`、
`research/stems/results/m2-seeklab-2026-08-20.json`、现有 Rust 播放链

## 1. 目标与“保证”的边界

本次接入解决的是：本地曲目已经进入 STEM 模式后，Seek、Hot Cue 或 SYNC 改变播放位置
时，不再等待 Spleeter4 的固定大窗推理才恢复目标位置的声音。

M2 上可以作出的产品保证分为两层：

1. **正常准入**：HS-TasNet 模型已就绪、整轨 44.1 kHz PCM 已预载，而且同一时刻只有
   一个 Deck 处于即时分轨阶段时，目标位置的第一块分轨以 512 samples 为单位产生；模型
   服务目标为 `p95 <= 11.61 ms`。目标位置先建立 250 ms dry cushion；单 hop 超过 12 ms
   音频 deadline 就保留 dry bridge，不再让模型尾延迟消耗可听缓冲。
2. **双跳过载**：两台 Deck 同时跳转时，声音仍须立即恢复，但不能承诺两路 HS-TasNet
   都持续实时。2026-08-18 的 1,000-hop 隔离数据已经证明 M2 上两 session 的 p50 为
   22.9 ms、两路全部错过 11.61 ms deadline。调度器只向一个 Deck 发放即时分轨准入；
   另一 Deck 用原曲 PCM 作短期桥接并等待精修。该降级是显式、可计数且不会进入音频回调
   推理，不把不可能的双路吞吐包装成“保证”。

因此，硬保证是**跳转后音频连续、最新请求优先、音频回调不阻塞**；即时 STEM 的保证受
上述单路准入条件约束。双 Deck 同时操作时，优先保证可听性和走带正确性。

## 2. 现状调用链

```text
PlaybackCommand::SeekDeck
  -> coordinator.rs::seek_deck_when_ready
  -> DeckRuntime.seek (StreamSeekControl)
  -> stream.rs::run_pitch_preserving_pipeline     清空旧 output generation
  -> stream.rs::decode_live_stem_streaming        清空旧 raw generation
  -> live.rs::StemInferencePool                   Spleeter4 后台 worker
  -> StreamWriter<StemFrame>
  -> kdj-player realtime renderer                 仅消费已准备 PCM
```

当前活动 STEM Deck 的跳转仍可能建立 shadow Spleeter stream，或在原 worker 中等待约
615–671 ms 的完整 tile。本设计保留现有 ring、Rubber Band、lane gain 与 Spleeter tile
cache，只在 `StreamSeekControl` 后增加即时层和精修换手。

## 3. 不可破坏的约束

- 音频 callback 只读无锁 ring 和原子控制；不得解码、分配、加锁、等待 channel 或推理。
- Deck A/B 的 seek generation、即时任务、解码 cursor 和输出 generation 独立。
- 所有异步结果发布前再次检查 worker epoch 和 seek generation；旧 Hot Cue 结果不得进入
  新 ring。
- HS-TasNet 强制 ORT CPU；不得注册 CoreML EP。Spleeter4 在 M2 的 `auto` 策略另行评估，
  本接入不以 ANE 加速为前提。
- 固定 lane 顺序为 `Drums / Bass / Other / Vocals`。StemgenRT 模型平面
  `Drums / Bass / Vocals / Other` 必须在模型边界完成映射。
- 整轨 PCM 只在工作线程解码为 44.1 kHz stereo；同曲两 Deck 共享 immutable cache。

## 4. 每 Deck 状态机

```text
RefinedStable
  -- seek generation++ --> InvalidateOldRings
  -- PCM/model ready + admission --> InstantSeparating
  -- no admission/model failure --> DryBridge

InstantSeparating | DryBridge
  -- Spleeter ticket ready --> RefinementHandoff(256 samples)
  -- newer seek --> InvalidateOldRings
  -- source end/cancel --> Stopped

RefinementHandoff
  -- handoff complete --> RefinedStable
  -- newer seek --> InvalidateOldRings
```

`InstantSeparating` 每次读取目标 hop 两侧各 1,024 samples，推理 2,560-sample 输入，只发布
中心 512 samples。Spleeter ticket 在进入该状态前已经提交；即时层不是单独的长期播放
模式，只覆盖大窗精修落地前的区间。

`DryBridge` 从同一个 PCM cache 发布原曲帧，并把原曲等分折入四个临时 lane，使它在
非 1.0 TEMPO 的八通道 Rubber Band 中仍可听。它只在即时层未准入或不可用时出现；此时
单 lane EQ 只是近似降级，不伪装成真实分轨。精修落地后用 256 samples（5.8 ms）平滑转
为四个真实 lane。

## 5. 进程级调度

优先级从高到低：

1. 音频 callback（从不参与模型调度）；
2. 一个已准入 Deck 的 HS-TasNet seek hop；
3. 一项 Spleeter audible refinement；
4. 普通 Spleeter audible tile；
5. look-ahead。

调度规则：

- `InstantOwner` 是进程级单许可证，值为 `None / DeckA / DeckB`；latest seek 只更新该
  Deck 的 generation，不为同一 Deck 叠加即时任务。
- 本地 HS 分层路径可用时固定一个 Spleeter refinement worker；它仍快于两台 Deck 消费
  3.92 秒 core 的总速率。预算约为一条 HS-TasNet（约 2.9 核）加一条 Spleeter tile
  （约 1.9 核），为 callback、解码和系统保留余量。
- 两台 Deck 同时 seek 时，先取得许可证者走 HS-TasNet，另一台走 `DryBridge`。两项
  refinement 保持 FIFO；第一项换手后释放即时许可证，队列继续推进。
- 非 macOS 加速器路径可保留两个 worker；macOS 安全 ORT CPU 路径固定一个 worker，避免
  后台模型的原生 session 与 arena 内存按 worker 数翻倍。
- look-ahead 在任一即时阶段完全让路。

## 6. PCM、模型和缓存生命周期

### PCM

- `PcmRandomAccessCache` 增加整轨 decode 和任意带零填充窗口读取。
- pool 内持有最多两首曲目的 LRU；相同规范化路径共享 `Arc`。
- 首次启用 STEM 时，PCM preload 与首个 Spleeter tile 并行。只有首个 refined stream、
  PCM cache 和对应 Deck 的 HS session 都就绪后才从 ORG 提升到 STEM。代价是首次启用
  可能多等 0.7–2 s，但提升后任意 seek 不再支付整轨 decode。

### 模型

- 两个 HS-TasNet CPU session 常驻于 STEM pool 生命周期内，每个物理 Deck 一个 worker，
  避免 session 内状态和 channel 排队串扰。
- 本地解析顺序：`KDJ_HSTASNET_MODEL_DIR`、兼容实验变量
  `KDJ_SEEKLAB_HSTASNET_DIR`、Spleeter 模型根旁的 `models/eaaba4f`。
- 精确 checkpoint 的训练清单和权重再发布授权仍未归档，因此本次不把 210 MB 权重打包
  或加入公开下载器；缺失时保留 Spleeter + ORG 桥接路径，并在 diagnostics 报告。

### 分轨结果

- Spleeter 内存 tile cache 继续按 `path + core_start` 精确命中；重跳已完成区域直接使用
  refined chunk，不启动即时层。
- 精修只从尚未写入新 generation 的位置开始。已经听过或已经作废的旧 generation 不回写。
- 持久化整曲 `.kdstem` 不在跳转热路径内；后续可复用现有 `cache.rs` 做离线落盘，但不得
  让磁盘写入成为本次实时保证的依赖。

## 7. 换手和走带一致性

- Seek 请求先发布位置，再递增 generation。
- raw producer 与 Rubber Band worker 分别确认同一 generation。producer 必须等 stretch
  worker 确认已清空旧 raw/output generation 后，才发布第一块目标 PCM，防止 10 ms
  即时结果被后到的 drain 丢弃。
- HS→Spleeter：对同一 source samples 在 256 samples 内作 smoothstep lane crossfade。
- ORG→Spleeter：`StemFrame.original` 与 refined lanes 通过 `blend` 在 256 samples 内换手。
- tempo 1.0 继续 passthrough；非 1.0 使用已预热的八 lane Rubber Band，不在换手时重新
  创建 engine。

## 8. 失败与降级矩阵

| 条件 | 行为 |
| --- | --- |
| refined tile 已缓存 | 直接 refined，跳过 HS |
| HS + PCM ready，许可证空闲 | 即时分轨 → refined |
| 另一 Deck 占用即时许可证 | ORG bridge → FIFO refined |
| HS 模型缺失/加载失败 | ORG bridge → refined，记录错误 |
| PCM preload 失败 | 不提升首次 STEM；保留 ORG 并返回可见错误 |
| HS 单 hop >12 ms 或 worker 退出 | 保留许可证至该次 bridge 结束，ORG bridge，继续等待 refined |
| 新 seek 到达 | 作废当前 instant/refined ticket，只处理最新 generation |
| Spleeter 失败 | 保持即时层至硬超时；随后 ORG bridge，不发布坏 tile |

## 9. 代码所有权与实施顺序

1. `crates/kdj-stems/src/instant.rs`：HS session、双 Deck worker、PCM LRU、模型边界映射、
   admission guard、即时 diagnostics。
2. `crates/kdj-stems/src/dj.rs`：immutable PCM 整轨 decode/随机窗口。
3. `crates/kdj-stems/src/live.rs`：pool 组合、即时阶段对 Spleeter worker 数量的门控、诊断。
4. `crates/kdj-player/src/stream.rs`：seek 分层状态、512-hop 发布、256-sample 换手、双端
   generation acknowledgement。
5. `crates/kdj-playback/src/coordinator.rs`：活动 STEM Deck 原地 retarget，不再为普通 Hot
   Cue 建立 Spleeter shadow。
6. `docs/stem-runtime.md` 与第三方说明：更新实际行为和模型交付边界。

## 10. 验收门槛

### 自动测试

- lane remap、2,560-sample 零填充窗口、PCM cache 共享/容量；
- latest-generation-wins，stretch acknowledgement 先于首块发布；
- 单即时许可证和 Spleeter constrained concurrency；
- HS→refined、ORG→refined 的 256-sample 端点连续；
- Deck A seek 不作废 Deck B；两 Deck 同 seek 时一条 instant、一条 dry；
- callback 路径无新增锁、分配、channel 或推理调用。

### M2 实机

| 场景 | 门槛 |
| --- | --- |
| 单 Deck、PCM/model warm、未缓存位置 | HS 首块模型时间 p95 <= 11.61 ms；端到端目标 <=20 ms |
| 单 Deck连续 Hot Cue 100 次 | 只听最新位置；0 callback gap；无旧 generation 泄漏 |
| 双 Deck 稳定播放 + A seek | B 0 gap；A 走 instant；refine margin >0 |
| A/B 同时 seek | 仅一个 instant owner；另一 Deck dry bridge；两 Deck 0 callback gap |
| 已缓存位置重跳 | 不提交 HS；直接 refined |
| HS 缺失/故障注入 | STEM 不崩溃；ORG bridge 可听；diagnostics 可定位 |

首次生产路径探针记录在
`research/stems/results/m2-layered-seek-admission-2026-08-20.json`：整轨 PCM preload
1,057.6 ms；单准入 Deck 100 hops 的 first/mean/p95/max 为
8.59/9.40/10.59/11.15 ms，0/100 超过 11.61 ms；第二 Deck 的即时许可证按设计被拒绝。

生产验收不能只看 `cargo test`。Rust/Tauri 后端改动必须完全停止并重启
`npm run tauri:dev`，确认目标进程是 `/tmp/KDJ Dev.app`（`com.kdj.dev`），再在两台物理
Deck 上完成 Hot Cue、SYNC、TEMPO 和同时 seek 试听。
