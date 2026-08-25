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
controlDeckPlatter(deck, { phase: start | move | end, velocity, gestureId, sequence })
```

- `start`：电容/指针接触，立即接管 callback cursor，不修改 Play/Pause；
- `move`：最新速度控制。每个 Deck 最多一个 IPC 在途，排队值只保留最新；
- `end`：最终速度与 note-off 原子提交，直接开始 coast；旧 move 即使晚到也会被
  `gestureId/sequence` 丢弃；
- 内部 `cancel` 只供 Load、Play/Pause、显式 Seek 终止旧手势。

不再存在“鼠标一套绝对位置、MIDI 一套 delta、松手再 seek”的三套互相竞争逻辑。

## 音频与波形权威

输入侧用最近三个真实源时间戳区间估计速度，真实反向时立即清空旧方向；速度有效期按近期
设备包间隔自适应为 24–100 ms。同一 WebKit coalesced batch 若只有一个时间戳，会先合并距离再
计算一次速度，不再为每个点虚构 8 ms。零位移会明确送出一次静止。实时 callback 做 10 ms
响应，并以 100 ms 为输入失联的最终安全网；过期后用 40 ms 摩擦停车。流式音频只在必要时
使用双向 ScratchTape；缓动回 transport 后，缓存读针追上 producer head 就原位交还正常流，
不会重建 decoder，也不会永久留在 scratch voice。暂停 Deck 的 throw 会自然减速到零，但保持
逻辑暂停。只有电容触摸可建立 platter gesture：未触摸的边缘转动只 nudge 正在运行的 transport，
暂停时直接丢弃，因此挪动机器不会让停播 Deck 发声。throw 的 60–900 ms 参数是到 handoff
阈值的实际 settle 时长，不再是可能拖到数秒的一阶时间常数；轻微接触抖动与真实 throw 连续
分级。准备流从 Cue 才开始解码时，盘针仍可穿过
该缓存原点前的静音 lead-in，并继续进入统一的负时间预卷。

未触摸盘面的边缘加减速走同一个 Rubber Band R3 tempo lane，保持音高且不写回 TEMPO 推子；
它不再使用 callback 线性重采样。盘面接触会清除任何残留的分数相位 reader，从最后实际发声
位置建立新手势，因此 nudge 后立即触摸不会先跳一个小范围。

波形只跟 callback/DAC 关联时钟。Platter start 只在接管边界校准一次 PCM bake 与 beat-grid rail；
后续 30 Hz 样本主要更新 compositor 速度，不反复写 currentTime；小于 80 ms 的普通误差由
最大 ±0.5% 的视觉 PLL 缓慢收敛，真正的相位债务才单次落点。极短 Loop 由同一个 compositor
按 callback 已经生效的 generation/in/length 做无限 modulo 动画，不使用 coordinator 的提前状态。

## 关键不变量

1. 缓动盘永远不隐式 Load、Seek、Play 或 Pause。
2. MIDI 原始相对值只按映射声明的编码解释，不猜协议。
3. 音频速度使用源时间戳；IPC 时间只负责送达。
4. `end` 自带最终速度；松手不能因遗漏最后一个 move 而归零。
5. 高频 move 不触发全量 React snapshot。
6. 波形位置来自音频 callback，不从输入事件累加第二条时间线。
7. Rubber Band 的源时间游标保留小数推进量；非整数 Tempo 不得积累时间戳或永久相位债务。

## 参考链接

- <https://github.com/mixxxdj/mixxx/wiki/midi-scripting#scratching-and-jog-wheels>
- <https://github.com/mixxxdj/mixxx/blob/main/src/engine/positionscratchcontroller.cpp>
- <https://github.com/mixxxdj/mixxx/blob/main/src/controllers/scripting/legacy/controllerscriptinterfacelegacy.cpp>
- <https://github.com/Andymann/mixxx-controllers/blob/main/Reloop-Buddy_scripts.js>
- <https://github.com/Andymann/pyReloopBuddy>
- <https://help.algoriddim.com/user-manual/djay-pro-mac/midi/jog-wheels>
- <https://mixxx.org/news/2021-11-21-dvs-internals-pt1/>
