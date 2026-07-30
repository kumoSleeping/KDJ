# 自动接播首次 seek 卡顿：事故记录

## 结论

问题来自错误的播放所有权，而不是波形点击本身。

当时本地桌面音频由 `HTMLAudioElement + Web Audio` 输出。Chrome 使用 Chromium 媒体栈，macOS Tauri App 使用 WKWebView；即使两边加载同一个 Rust HTTP 服务、运行同一份 React 代码，压缩解码、`preservesPitch`、seek 和第二个媒体元素的首次启动仍由不同 WebView 实现。

继续修改 Web Audio 时序无法给正式桌面平台提供同一个行为。最终处理是把本地桌面播放迁移到 `kdj-player`：Symphonia 解码、Rust DSP、双 Deck 状态机、callback 时钟和 CPAL 输出均在 WebView 外运行。

## 原始复现

1. 在 macOS Tauri App 中开启自动接播。
2. 播放第一首，再触发第二首接歌。
3. 在第二首进场期间或接歌刚结束后点击波形。
4. 第一次 seek 短顿，后续通常正常。

同一份前端在 Chrome 中正常。关闭自动接播并直接播放第二首也正常。这个对照排除了波形坐标、Range API 和 React 点击次数，指向了桌面媒体运行时。

## 为什么“Rust 后端一致”仍然不够

事故发生时的实际链路是：

```text
PlayerBar
  -> src/lib/djMix.ts
  -> HTMLAudioElement + Web Audio
  -> WKWebView / Chromium 自己的媒体线程
  -> 声卡
```

Rust 服务只提供文件、Range、音频提取和元数据。它没有拥有最终 PCM、播放时钟或声卡输出。

仓库已有的名称容易造成误解：

- 当时的 `UnifiedPlayer` 只接通 Android/iOS 原生播放器；
- `crates/kdj-player` 已有实时 mixer 原语，但没有接入 `src-tauri`；
- 桌面 `PlayerBar` 仍直接调用 `djEngine`。

所以“新组件已经存在”和“正式桌面正在使用新引擎”不是一回事。

## 造成回归的尝试

以下方案不得恢复：

- **UI seek 防抖**：只能消除重复命令，不能解决媒体内核的冷启动。
- **延迟返回 `frontElement`**：让控制变迟钝，未改变最终媒体管线。
- **接歌时整轨预解下一首，再继续使用 Web Audio 变速**：增加内存和解码竞争，预解 PCM 又无法自动获得 `preservesPitch` 语义。
- **静音播放 shadow Deck 数十毫秒**：不能证明目标位置的解码和时间拉伸状态已经可用，还增加 `play/pause` 竞态。
- **seek 前恢复第一首到满幅**：制造明显回抽。
- **WKWebView 永远在当前热媒体元素上 seek**：把“第一次切到冷 shadow Deck 卡”变成“每次在当前压缩流里重建缓冲都卡”。用户确认该版本更差后立即撤回。
- **按 UA 继续堆平台分支**：Chromium UA 本身也带 `AppleWebKit` 字段；更重要的是，这仍然保留多套正式音频行为。

## 当前链路

```text
PlayerBar
  -> UnifiedPlayer / DesktopNativePlayer
  -> Tauri typed command
  -> src-tauri/src/desktop_player.rs（单一控制 actor）
  -> decode / WSOLA workers
  -> crates/kdj-player prepared Deck bank
  -> realtime Rust DSP
  -> CPAL / CoreAudio、WASAPI、Linux host
```

关键性质：

- seek 是 O(1) prepared frame cursor 更新，不触发压缩媒体重新缓冲；
- 连续 seek 在下一音频 callback 前按顺序消费，最后一个目标生效；
- handoff、包络、EQ/filter、人声削弱和效果按 callback frame 推进；
- BPM 同步先在 worker 上做 WSOLA，不靠简单重采样改变音高；
- PCM 的创建、替换和释放都在控制侧；callback 不锁、不分配、不做 IO；
- 每台 Deck 有 revision fence，旧 decode/seek 结果不能覆盖新操作；
- 本地视频仍由 WebView 显示，但正式声音来自 Rust；视频按 Rust 状态校时。

浏览器开发和临时在线流仍有 Web Audio preview adapter。它不是本地桌面播放的权威实现，也不能再用“Chrome 正常”证明 App 音频正常。

## 代码位置

- `crates/kdj-player/src/command.rs`：固定大小 realtime 命令和 transition plan。
- `crates/kdj-player/src/decode.rs`：有内存上限、可取消的 Symphonia 解码。
- `crates/kdj-player/src/stretch.rs`：离线 WSOLA 变速不变调。
- `crates/kdj-player/src/engine.rs`：Deck cursor、seek、handoff 和 callback 状态机。
- `crates/kdj-player/src/dsp.rs`：EQ、filter、vocal cut、echo/alarm/hydrant。
- `crates/kdj-player/src/output.rs`：动态 PCM 生命周期和 CPAL 输出。
- `src-tauri/src/desktop_player.rs`：actor、revision、Tauri commands/events、状态映射。
- `src/lib/unifiedPlayer.ts`：desktop-native、mobile-native、browser-preview adapters。
- `src/components/player/PlayerBar.tsx`：UI 编排和自动选歌策略；本地桌面 transport 走 UnifiedPlayer。

## 回归清单

在 macOS Tauri App 中：

- 普通播放第一次和后续 seek 听感一致；
- 自动接播进行中，第一次 seek 直接落在第二首；
- 自动接播完成后，第一次和连续 seek 不出现 WebKit 冷启动卡顿；
- 播放/暂停在按下后一个设备 buffer 内生效；
- 过渡中暂停不会漏出另一台 Deck；
- 快速连续点击波形只采用最后目标；
- BPM 同步不改变人声/乐器音高；
- cross、EQ、filter、vocal cut 和三个效果均正常收尾；
- 本地视频画面继续跟随 Rust 音频时钟，PiP 不产生第二条声音；
- 音频设备中断会显示错误，重新初始化可打开新的默认设备。

跨平台：

- Windows 在本机 CI/机器验证 WASAPI 设备运行；
- Linux 在目标发行版验证 CPAL host 和打包依赖；
- 浏览器只验证 preview adapter，不作为正式桌面音频回归结论。
