# 缓动盘输入与实时走带

## 调研结论

本次实现对照了以下公开实现与设备资料（只参考控制语义，没有引入其代码）：

- Mixxx `6d6229c0dd222cc93eea453a9426c38bc7f5dc63`：
  - `engine.scratchEnable/Tick/Disable` 把控制器的每圈 tick 数与虚拟唱片 RPM 先换成速度，
    在固定 1 ms 观察周期内用 alpha-beta filter 估计速度；松手把速度缓动回播放速度。
  - `PositionScratchController` 不把鼠标坐标直接当播放头。它以固定 16 ms 观察窗口、PD/IIR
    控制器和 throw 阈值驱动走带，输入停止后才判定盘面停止。
  - `scratch2` 覆盖播放速度而不改 Play/Pause 意图；刮擦优先于同步和普通 tempo。
- Mixxx MIDI scripting 文档：推荐以 `intervalsPerRev + rpm` 归一化；常见初值为
  `alpha=1/8`、`beta=alpha/32`，触摸、转动与松手是三个明确阶段。
- Andy Fischer 的 Reloop Buddy Mixxx 映射：Buddy 是 **360 tick/rev、33⅓ RPM**；CC 6
  使用精确二补码相对值：`01h..3Fh = +1..+63`，`7Fh..40h = -1..-64`。因此 `41h`
  是 `-63`，绝不是居中协议的 `+1`。`pyReloopBuddy` 也按同一规则展开高速包。
- Algoriddim djay 的缓动盘说明把 Scratch、Pitch Bend 分开，并把手感明确建模为
  sensitivity/speed 与 reaction，而不是绝对 seek。
- Mixxx/xwax DVS 资料：音频引擎应消费方向和瞬时 pitch；UI 平滑值只供显示，不能反过来
  成为音频时钟。短暂信号间隙应保持连续估计，真正失去信号后才停车。

## KDJ 的统一单位

所有输入先转换成 **signed normalized media velocity**：

- `+1.0`：按 Deck 正常速度正放；
- `-1.0`：同速反放；
- `0.0`：盘面静止；
- 上限 `±8.0`：与实时流缓存读取能力一致，避免盘针跑出已准备 PCM 后读到数字零。

鼠标/触屏的一整个波形宽度等于一圈虚拟唱片（1.8 秒媒体距离）；MIDI 使用
`signedTicks / 360 * 1.8s`。两者都除以**输入设备自己的时间戳差**，而不是 IPC 到达时间。
所以相同物理速度得到相同走带速度，滑得越快自然加速，Tauri/WebView 抖动不会改手感。

## 唯一 API

前端、Tauri wire contract、协调器和实时队列都只有同一状态机：

```text
controlDeckPlatter(deck, { phase: start | move | end, velocity, validForMs, gestureId, sequence })
```

- `start`：电容/指针接触，立即接管 callback cursor，不修改 Play/Pause；
- `move`：最新速度控制。每个 Deck 最多一个 IPC 在途，排队值只保留最新；
- `end`：最终速度与 note-off 原子提交，直接开始 coast；旧 move 即使晚到也会被
  `gestureId/sequence` 丢弃；
- 内部 `cancel` 只供 Load、Play/Pause、显式 Seek 终止旧手势。

不再存在“鼠标一套绝对位置、MIDI 一套 delta、松手再 seek”的三套互相竞争逻辑。

## 音频与波形权威

输入侧用最近三个真实源时间戳区间估计速度，真实反向时立即清空旧方向；每个 move 还把
按近期设备包间隔计算的 validForMs 一起送进 callback。高速输入通常保持 24–40 ms，Buddy
极慢转动可扩展到 250 ms，之后才用 40 ms 摩擦停车；引擎不再用独立固定 100 ms 抢先刹车。
同一 WebKit coalesced batch 若只有一个时间戳，会先合并距离再计算一次速度，零位移则明确送出
一次静止。

流式 Deck 另有每侧两个预分配的 12 秒原始立体声窗口。后台 worker 根据绝对源帧和转动方向
准确 seek 本地文件或回环 HTTP Range，写完 inactive window 后只用一个原子索引发布；callback
用 reader pin 读取并做四点 Hermite 插值，全程不分配、不加锁、不解码。接近窗口边缘会提前
载入带重叠的下一窗；真正 cache miss 只冻结游标并保留目标速度，窗口到达后按原手速继续，
绝不再把反向速度永久清零。STEM 刮擦也使用原曲 raw PCM 作为低延迟唱片层，松手后再回到
当前 STEM/R3 transport。

松手 coast 达到播放速度后，协调器通过现有 StreamSeekControl 原位对齐同一个 decoder，
不是创建 replacement 或做 UI Seek。缓存继续发声，callback 有界丢弃旧 packet；matching
media-time PCM 到达后做 64 帧 crossfade 并释放 scratch owner。暂停 Deck 的移动也走同一路径，
但 handoff 保持静音。throw 的 60–900 ms 参数是到 handoff 阈值的实际 settle 时长；静止轻触
无需 seek，会立即释放。准备流从 Cue 才开始解码时，盘针仍可穿过缓存原点前的静音 lead-in，
并继续进入统一的负时间预卷。

未触摸盘面的边缘加减速走同一个 Rubber Band R3 tempo lane，保持音高且不写回 TEMPO 推子；
它不再使用 callback 线性重采样。盘面接触会清除任何残留的分数相位 reader，从最后实际发声
位置建立新手势，因此 nudge 后立即触摸不会先跳一个小范围。

波形只跟 callback/DAC 关联时钟。Tempo 不再改变 source-time zoom：PCM 与 beat lattice 固定，
只有 callback audibleRate 改变滚动速度。原生 Deck 的既有 WAAPI timeline 只允许 live clock
写 phase/rate，React 的 optimistic Tempo 只更新推子和 BPM 数字。Platter start 只在接管边界
校准一次；小于 80 ms 的普通误差由最大 ±0.5% 的视觉 PLL 收敛，真正相位债务才单次落点。
极短 Loop 继续按 callback 已生效的 generation/in/length 做 compositor modulo。

## 关键不变量

1. 缓动盘永远不隐式 Load、Seek、Play 或 Pause。
2. MIDI 原始相对值只按映射声明的编码解释，不猜协议。
3. 音频速度使用源时间戳；IPC 时间只负责送达。
4. `end` 自带最终速度；松手不能因遗漏最后一个 move 而归零。
5. 高频 move 不触发全量 React snapshot。
6. 波形位置来自音频 callback，不从输入事件累加第二条时间线。
7. Rubber Band 的源时间游标保留小数推进量；非整数 Tempo 不得积累时间戳或永久相位债务。
8. 反向缓存 miss 只能暂时冻结游标并请求源窗口，不能清除手的目标速度。
9. Tempo 只改变固定 source-time 波形的 audible velocity，不能同时改变 zoom。

## 参考链接

- <https://github.com/mixxxdj/mixxx/wiki/midi-scripting#scratching-and-jog-wheels>
- <https://github.com/mixxxdj/mixxx/blob/main/src/engine/positionscratchcontroller.cpp>
- <https://github.com/mixxxdj/mixxx/blob/main/src/controllers/scripting/legacy/controllerscriptinterfacelegacy.cpp>
- <https://github.com/Andymann/mixxx-controllers/blob/main/Reloop-Buddy_scripts.js>
- <https://github.com/Andymann/pyReloopBuddy>
- <https://help.algoriddim.com/user-manual/djay-pro-mac/midi/jog-wheels>
- <https://mixxx.org/news/2021-11-21-dvs-internals-pt1/>
