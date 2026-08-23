# DJ 工作调度中间件

## 1. 目标与边界

KDJ 的实时路径不是一条普通线程池：CoreAudio callback、Rubber Band、每 Deck 解码器、
Spleeter/HS-TasNet 原生 session、整轨波形和曲库分析都有不同的线程亲和、内存与取消
语义。把这些 closure 全塞进一个“通用 executor”会破坏 ORT session 所有权，也可能让
音频 callback 等锁。

因此 `kdj_core::work_scheduler` 是一个**进程级准入与状态中间件**，不是替代 Tokio/Cargo
线程的 executor：

- 专用 owner 继续执行任务；
- 中间件统一任务类别、优先级、重型预算、排队公平性、deadline、取消和观测；
- 两个物理 Deck 的 BPM/TEMPO 使用 latest-value lane；
- callback 永远不调用阻塞准入接口；
- coordinator 根据 callback-facing ring 水位发布 `Normal / Low / Critical` 音频压力；
- native 推理和整首分析一旦进入不可抢占区，只能在它们公开的边界协作取消。

这使“该干什么、不该干什么”只有一个策略源，同时不假装底层 native 调用可被安全
抢占。

## 2. 代码位置与所有权

| 层 | 位置 | 责任 |
| --- | --- | --- |
| 公共策略/状态 | `crates/kdj-core/src/work_scheduler.rs` | `WorkClass`、重型准入、状态快照、TEMPO lane |
| TEMPO 执行 | `crates/kdj-player/src/time_stretch.rs` | 读取 Deck lane，在专用 worker 驱动 Rubber Band |
| 播放状态 | `crates/kdj-playback/src/coordinator.rs` | 创建 Deck lane、发布 SYNC/TEMPO 最新目标 |
| STEM 模型队列 | `crates/kdj-stems/src/live.rs` | Audio/LookAhead/Viewport 本地严格优先队列；向核心发布 queued/active |
| 即时 STEM | `crates/kdj-stems/src/instant.rs` | HS-TasNet session 线程；推理时发布 `StemInstant` activity |
| 曲库/波形分析 | `crates/kdj-server/src/jobs.rs`、`waveform.rs`、`stream_waveform.rs` | 通过统一重型准入后才开始整轨 CPU/IO 工作 |

`kdj-core` 不依赖 player、stems、server，所以上述依赖方向不会形成环。全局实例由
`work_scheduler()` 的 `OnceLock<Arc<WorkScheduler>>` 创建。

## 3. 任务等级

数字越小越优先；同等级先比较 deadline，再按提交顺序 FIFO。

| 顺序 | `WorkClass` | 示例 | 是否占重型 permit |
| ---: | --- | --- | --- |
| 0 | `TempoStretch` | 已进入非 1.0 的 Rubber Band Deck | 否，发布实时压力 |
| 1 | `StemInstant` | HS-TasNet seek hop | 否，专用 session |
| 2 | `StemAudible` | Spleeter 可听 tile/refinement | 否，STEM pool 自有 worker |
| 3 | `StemLookAhead` | 下一块/下两块可听预取 | 否 |
| 4 | `StemViewport` | 30 秒可见 STEM rail | 否 |
| 5 | `InteractiveWaveform` | 用户正在等待的完整波形 | 是 |
| 6 | `NowPlayingAnalysis` | 当前曲 BPM/Key 插队 | 是 |
| 7 | `LibraryAnalysis` | 批量 BPM/Key、完整流分析 | 是 |
| 8 | `Maintenance` | 波形预热/补齐 | 是 |

音频 callback 不在表中，因为它从不排队：只消费预渲染 ring、读原子控制并报告 underrun。

### 3.1 准入策略

- macOS/Android/Linux 默认最多 2 个重型任务，Windows 为 1；这个限制跨批次、波形和
  流分析生效，不再是每个调用方各自的局部 semaphore。
- `LibraryAnalysis`/`Maintenance` 在 live STEM Deck、TEMPO stretch、可听/即时模型压力、
  交互波形或当前曲分析存在时不再启动下一项。已经进入 native/整曲分析的一项跑到下个
  协作边界。
- `NowPlayingAnalysis` 仍让位于 TEMPO 与可听模型 deadline。
- `InteractiveWaveform` 是用户可见请求，可以取得一个有界重型 slot；它只避让正在执行
  或排队的可听/即时模型任务。
- `StemViewport` 不走重型 gate。两个 audio lease 只是“可能很快需要音频”，不是排队的
  推理；Audio 队列空时 viewport 必须继续。
- 输出 ring 进入 `Low` 时不再启动 `StemViewport`、交互/当前曲/曲库波形分析和维护任务；
  `Critical` 时连 look-ahead 也让路，只保留 TEMPO、即时和当前可听 STEM。恢复阈值高于
  进入阈值，避免水位在边缘反复启动完整分析。该状态由 coordinator 发布，callback 本身
  仍只访问 ring 和 atomics。

最后一条是双 Deck 锁死修复的核心约束。不要再把 `live_decks == recommended_workers`
写成 viewport 的硬禁令。

## 4. 公共 API

### 4.1 专用 worker 发布活动

```rust
use kdj_core::work_scheduler::{work_scheduler, WorkClass};

let guard = work_scheduler().activity(WorkClass::StemInstant);
run_native_hop()?;
drop(guard); // active 计数归还并唤醒等待者
```

`WorkActivityGuard` 是 RAII；panic/`?`/提前返回都不会泄漏状态。它不分配执行线程。

### 4.2 专用优先队列发布 queued → active

```rust
let queued = work_scheduler().queued(WorkClass::StemViewport);
local_priority_queue.send((job, queued))?;

// 专用 worker 真正取到它时
let active = queued.start();
run_model()?;
```

queued job 被取消、queue 被销毁或 runtime 切换时，`Drop` 自动减 queued。

### 4.3 重型工作准入

```rust
use kdj_core::work_scheduler::{WorkClass, WorkRequest};

let permit = work_scheduler().acquire(
    WorkRequest::new(WorkClass::LibraryAnalysis),
    || cancel.is_cancelled(),
)?;
analyze_one_track()?;
```

`WorkRequest::with_timeout` 只限制**排队时间**。返回值区分 `Cancelled` 和
`DeadlineExceeded`。permit drop 后归还全局 heavy slot。

### 4.4 Deck TEMPO lane

```rust
let tempo = TempoControl::for_deck(deck_index, initial_rate);
tempo.set(sync_rate); // 覆盖旧值，不排一串过期 MIDI/React 命令
```

同一物理 Deck 的 live stream、shadow stream 都由 coordinator 更新，核心保留最新的
`TempoLane { rate_bits, revision }` 状态。每个 worker generation 仍有独立 local atomic：
shadow 可以先按未来 rate 准备，而不会在 promotion 前改变仍可听的旧 stream。Deck A/B
状态独立；`TempoControl::new` 只用于离线转换和独立测试。

### 4.5 观测

```rust
let snapshot = work_scheduler().snapshot();
```

`WorkSchedulerSnapshot` 可序列化，包含：

- `heavyLimit` / `heavyInUse`；
- `liveStemDecks`；
- `audioPressure`；
- 每个 `WorkClass` 的 `queued` / `active`；
- Deck A/B 的 TEMPO `rate` / `revision`。

准入日志使用 tracing target `kdj_work_scheduler`；STEM 生命周期仍使用
`kdj_stem_lifecycle`。后续若增加 diagnostics HTTP/Tauri 面板，应直接序列化这个快照，
不要再抄一份计数器。

## 5. SYNC/TEMPO 连续性

SYNC 的执行顺序是：

```text
PerformanceWorkspace 计算 rate
  -> PlaybackCoordinator::set_deck_rate
  -> 物理 Deck TempoLane（latest value）
  -> Deck preparation worker 在下个输入块读取
  -> Rubber Band 输出带 media_advance 的 PCM
  -> callback ring
```

修复包含三条约束：

1. R3 显式 `OptionThreadingNever`，所有 native 调用留在已经受管理的 preparation worker，
   不再让库内部另开不可观测线程。
2. 高频 slider/MIDI 目标每 4,096 个 source frames 最多应用一次；中间值由 latest-value
   lane 合并。48 kHz 下最坏约 85 ms，不会产生无界命令积压。
3. 一个 stream 第一次离开 unity 后，跨过 0% detent 仍继续使用同一个已 prime R3 state；
   只有 seek/loop discontinuity 才 reset。旧逻辑每次回到 1.0 都旁路、再次离开又 reset，
   连续控制时会丢掉大量 R3 输出，callback 听起来就是断续。初始 1.0 仍零成本直通。

STEM 八通道始终共享一个 R3 state，不能把 lane 拆开变速。

## 6. 取消、deadline 与不可抢占区

- STEM job 同时有 scan/stream epoch 和 ticket-local cancel。queued ticket 超时/drop 后不会在
  将来占模型 slot；若已进入 ORT，只在 `predict()` 返回后的 fence 丢弃结果。
- viewport ticket 每 20 ms 检查 generation，最长等待 10 秒；unmount/runtime switch 不再
  阻塞在无限 `recv()`。
- 批量分析按“每首歌”取得 permit，取消至少在下一首前生效。当前 `analyze_file` 是整首
  不可抢占块；不要在线程外强杀它并留下部分数据库写入。
- Rubber Band/ORT 的 native 调用不允许 holding scheduler mutex；guard 只保存计数。

## 7. 锁顺序与 callback 禁区

1. callback：只访问 ring/atomics，不访问 `WorkScheduler` mutex/condvar。
2. 专用 queue：先释放本地 receiver/cache lock，再开始 native work。
3. scheduler permit：不能在持有数据库事务、ORT session registry 或 waveform inflight map 时
   阻塞获取。
4. runtime switch：先取消 generation，再清队列/释放 guard，最后 join native worker。

## 8. 已接入与后续迁移边界

本轮已接入：

- Deck TEMPO latest-value state；
- Rubber Band realtime activity；
- Spleeter Audio/LookAhead/Viewport queued/active；
- HS-TasNet active；
- 批量、当前曲、交互波形、波形预热和流分析的统一 heavy admission；
- live STEM Deck 压力；
- 可序列化快照。

保留专用 owner 是最终架构，不是未完成项。后续可增量增加：

- `kdj-analysis` 在 decode/FFT 阶段的更细 checkpoint，使已开始的整首分析也可暂停；
- 依据 ring fill/refine margin 发布短期 deadline，而不是只用 class 优先级；
- 把 scheduler snapshot 接到 diagnostics UI；
- 按实测 P-core/E-core、能耗与设备能力动态调整 heavy limit。

不应迁移进核心 executor 的内容：audio callback、CPAL device ownership、ORT session、
Rubber Band state、数据库事务和文件 decoder。

## 9. 验收矩阵

### 调度

- heavy 并发不超过平台 limit；
- cancellation/deadline 在 bounded poll 内退出；
- 两个 live STEM Deck 不阻塞 `StemViewport`；
- Audio > LookAhead > Viewport；
- ticket unmount/timeout 不无限等待。

### SYNC

- 普通 stereo 和八通道 STEM 从 1.0 离开、穿过 1.0、连续变更时都输出 finite PCM；
- 输出长度保持在输入速率积分的合理范围；
- 最大静音段 <20 ms；
- media advance 覆盖完整 source clock；
- `r3_continuous_slider_updates_stay_finite` 稳定通过。

### 双 Deck STEM

- callback underrun = 0；
- 实际单 worker + 两个 audio lease 时，缓存未命中的 viewport fill 仍有限完成；
- 可听 job 已排队时，viewport 不能越过它；
- 双 Deck rail 公平轮换，不先扫完整个 A 再开始 B。
