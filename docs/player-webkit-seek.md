# 自动接播首次 seek 卡顿：WebView 事件记录

## 当前状态

这个问题尚未解决。已撤回“macOS App 对接歌曲始终在当前媒体元素上 seek”的分流，因为它把原本只发生一次的卡顿扩大成了每次 seek 都卡。

当前目标是先恢复原行为：自动接播后的第一次 seek 可能卡，后续 seek 正常。不要再往 `djMix.ts` 叠加平台分支；最终解法是完成桌面原生播放器迁移。

## 最短复现

1. 在 macOS Tauri App 中开启自动接播。
2. 播放第一首，再触发第二首接歌。
3. 在第二首进场期间或接歌刚结束后点击波形。
4. 第一次 seek 短顿，后续通常正常。

同一份前端在 Chrome 中正常。关闭自动接播并直接播放第二首也正常。

## 为什么会有平台差异

“后端相同”不等于“播放引擎相同”。当前桌面链路是：

```text
PlayerBar
  -> src/lib/djMix.ts
  -> HTMLAudioElement + Web Audio
  -> WebView 自己的解码、preservesPitch、时钟和音频输出
```

Rust 服务端只提供文件、Range 响应、音频提取和元数据。它没有拥有桌面播放时钟，也没有生成最终送往声卡的 PCM。

因此：

- 浏览器调试使用 Chromium 的媒体实现；
- macOS Tauri App 使用 WKWebView 的媒体实现；
- Windows Tauri 使用 WebView2；
- 只要桌面声音仍由 `HTMLAudioElement` / Web Audio 输出，解码、seek、变速和双 Deck 换手就会受到 WebView 实现差异影响。

仓库虽然已有 `UnifiedPlayer` 和 `crates/kdj-player`，但迁移还没有完成：

- `src/lib/unifiedPlayer.ts` 目前只封装 Android/iOS 原生播放器；
- 桌面 `PlayerBar` 仍直接调用 `djEngine`；
- `crates/kdj-player` 已有 Symphonia 解码、CPAL 输出、双 Deck、sample-clock seek/handoff 和实时命令队列，但尚未接入 `src-tauri`，也不能动态替换运行中的 Deck 资源；
- Rust 播放器当前 `SetRate` 是采样步进，尚未实现“变速不变调”。

## 这次确认无效或有害的方案

- UI seek 防抖只能消除重复命令，不能解决媒体内核冷启动。
- 延迟返回 `frontElement` 会让控制显得迟钝；`seekBusy` 原本已保护交接。
- 接歌时整轨预解下一首会增加网络、内存和解码竞争；带 `playbackRate` 的曲目又无法使用现有 PCM 路径。
- 静音播放 shadow Deck 几十毫秒不能保证 WKWebView 的目标 seek 管线已准备好。
- seek 前把声音倒回第一首会产生明显回抽。
- 强制 WKWebView 永远在当前热元素上 seek 会让每次 seek 都发生压缩媒体重新缓冲，实际表现比原问题更差。该方案已撤回。

## 结论

这不是继续调整几条 Web Audio 时序就能可靠收敛的问题。桌面播放的唯一权威应迁移到 Rust 原生音频线程：

```text
React / PlayerBar（只发命令、渲染状态）
  -> DesktopNativePlayer adapter
  -> Tauri command/event contract
  -> Rust PlayerRuntime（唯一状态 owner）
  -> decode workers + prepared deck bank
  -> kdj-player realtime mixer
  -> CPAL / CoreAudio / WASAPI / ALSA
```

浏览器只保留开发/预览 adapter，不再作为正式桌面 DJ 输出实现。具体迁移阶段见 `docs/player-migration-plan.md`。

## 原生迁移必须补齐的能力

1. `src-tauri` 中增加单一 `PlayerRuntime`，拥有控制线程、解码任务、CPAL stream、状态广播和关闭流程。
2. 给 `kdj-player` 增加可动态替换的 prepared Deck bank。资源分配和释放在控制线程完成，音频 callback 只消费固定大小命令；旧 PCM 也必须回控制线程释放。
3. Tauri 暴露 typed commands：load/prepare/play/pause/seek/handoff/rate/gain/EQ/dispose，并用 revision fencing 丢弃过期 decode/seek 回调。
4. 将 `UnifiedPlayer` 扩展为 desktop-native、mobile-native、browser-preview 三个 adapter；`PlayerBar` 不再直接引用 `djEngine`。
5. 在切走 Web Audio 前补齐变速不变调、DJ 包络和当前启用的效果。不能用会改变音高的简单 resampling 冒充 parity。
6. 用音频 callback 时钟验证 seek 和 handoff；React 更新时间不能作为音频成功标准。

## 回归基线

- 普通播放和自动接播使用同一个 Rust 输出 owner。
- prepared seek/handoff 在 callback 边界提交，不重建平台媒体元素。
- macOS、Windows 和 Linux 执行同一套解码、DSP、时钟和双 Deck 状态机。
- 浏览器差异只影响 UI/预览，不影响正式桌面声音。
- warm play/pause 和 prepared seek 的 command-to-audible 目标不超过 20 ms。
- 快速连续 seek 只采用最后一个 revision。
