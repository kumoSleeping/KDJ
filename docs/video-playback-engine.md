# 共享视频播放调度

本地播放、在线播放、YouTube 和混合编辑（原 VJ 工坊）共用视频调度层。优先验收 macOS、Windows，同时保留 Android 路径。

## 当前实现

- `src/lib/videoPlaybackEngine.ts`：音频设备时钟跟随、WebKit 稳定速率策略、后台双槽校时、每个视频元素的跳转队列。
- `src/lib/videoFrames.ts`：以提交给合成器的帧时间确认画面准备情况。播放中需要连续三个时间递增的帧；暂停预览只需要目标帧。超时是失败，取消后释放帧回调、事件监听和计时器。
- `src/lib/videoSeekQueue.ts`：每个解码器/平台会话只保留一个正在执行的跳转和最后一个等待目标。销毁会话时取消等待目标。它不把 IPC 命令完成当成已出画证明。
- `src/lib/useLocalVideoSwap.ts`：本地双槽切换。Rust 音频落点确认后，备用槽准备画面；播放中持续运行备用槽直到换手，不再播放后暂停、换手后再次播放。拖动预览仍暂停备用槽以避免空转。

| 入口 | 接入方式 |
| --- | --- |
| 本地详情、浮窗、系统 PiP | 共享设备时钟策略；应用内双槽出帧确认；系统 PiP 保持绑定的视频元素 |
| 在线代理视频、YouTube HLS 浮窗 | 同一 `VideoPlaybackEngine.seek` 队列；保留当前源加载、错误和会话释放逻辑 |
| 下载区视频预览及协同播放 | 同一跳转队列；音量、音频焦点仍由已有协同播放逻辑处理 |
| 旧合成/叠加预览 | 同一时钟和跳转调度；保留已有画布合成 |
| 本地视频画面 | 见下节 WebCodecs；不经过 `<video>`，也不经过这里的调度层 |

## 体积、资源与边界

没有新增播放器、解码器或运行时依赖，也没有新增整段视频缓存或逐帧像素复制。保留现有视频元素数量；调度只保存少量状态和至多一个等待目标。系统解码器的缓冲内存仍由平台管理，不能据此宣称固定内存上限或零内存占用。

这是复用系统媒体解码器的共享调度实现，不是新增 Rust 原生视频解码/渲染后端。没有帧回调能力的旧系统保留媒体事件路径；不宣称该降级路径具备逐帧出画证明。YouTube 原生 HLS 的系统可用性沿用现有约束，本次没有新增 Windows/Android HLS 解码能力。

网络缓冲、源文件关键帧间隔、系统解码延迟仍会影响随机跳转；不能承诺任意位置零延迟。后续如果增加 macOS/Windows/Android 原生后端，需要维持上述统一入口和取消规则，再通过实测比较解码启动延迟、显示帧连续性、音画误差、峰值内存和发行包增量。

## WebCodecs 画面（本地视频）

跟着 KDJ 原生音频走的画面（库里的本地视频）由 WebView 自己的 WebCodecs `VideoDecoder` 解码，画在页面里的一个 canvas 上。解码器是系统的：macOS 是 VideoToolbox，Windows（WebView2）是 Media Foundation，Android WebView 是 MediaCodec。解封装用 [mediabunny](https://mediabunny.dev/)（MPL-2.0，纯 TypeScript，只引入 MP4/MOV/WebM/MKV 四种读取格式），从 KDJ 本机服务按 Range 读文件。

- `src/lib/codecClip.ts`：一个素材一个解码器。切点前 `prime`：从入点解出前几帧等着，切点一到就是动着的画面；播放中 `play`：从连续解码里取当前时钟该显示的帧，只有跳出已解码范围才重新开始解码（同一次跳转只重启一次，150 ms 内目标相近不重来）；暂停 `still`：精确解出目标帧，后到的目标替换排队的目标。帧用完立即 `close()`，系统解码器的帧池很小。
- `src/components/player/KdjvCodecPicture.tsx`：按片段的位置、裁切、淡入淡出和轨道顺序把帧画到一个 canvas 上（`kdjvLive.ts` 的 `clipBox`/`clipAlpha`；名字沿用 1.1.0-rc19 之前的 `.kdjv` 工程，剪辑已移出 KDJ）。新片段第一帧没到时保留上一幅画面（最多 0.5 秒）或停在前一片段末帧（`heldClips`），不闪黑。
- `src/lib/codecVideo.ts`：本地视频当成“只有一个片段的工程”交给同一个画面。先读一次文件头拿到画面尺寸和时长；没有视频、容器不认识或系统解码器不支持的文件记为 refused，这个视频退回原来的 `<video>` 双槽路径（含兼容格式转换）。
- 画面是页面的一部分：拖动、滚动、圆角、遮挡都和普通元素一样，没有原生视图和挖洞。
- 在线预览（B站代理流、YouTube HLS）仍用 `<video>`，它自带声音和缓冲；没有 WebCodecs 的 WebView 上，本地视频用 `<video>` 双槽路径。
- WebCodecs 画面没有对应的 `<video>` 元素，系统画中画按钮在这类画面上不显示。
- 回放日志里的 `codec-open / codec-first / codec-seek / codec-still / codec-late / codec-error / codec-video(-refused)` 记录打开、首帧、跳转出帧、暂停出帧、落后和失败，带 `waitMs` 和重启原因 `why`。

2026-10-30 在 M2 上实测（Playwright WebKit）：720p 代理文件打开 109 ms、首帧 134 ms、90 帧 204 ms；暂停精确跳转多数 11–20 ms；带 B 帧的 1080p 文件帧序正确。mediabunny 只读四种格式，压缩后约 60 KB。

此前（2026-10-27 至 10-30）macOS 上曾用自编 libmpv（13.3 MB）在页面下方的原生视图里出画，拖动错位、闪烁、加载卡顿无法在那种结构里消除，已整体移除。

## 验证

`npm test -- localVideoDeviceClock` 验证设备时钟、连续跳转、合成预览、真实帧回调判定、取消资源释放。`npm run typecheck` 验证前端调用约束。

实机验收需要在 Tauri 壳内分别覆盖本地和网络视频的普通播放、暂停跳转、播放中连续跳转、详情/浮窗/系统 PiP 切换，以及混合编辑的多轨、片段边界和速度变化。记录实测数据后才能判断卡顿是否消除；模拟测试不能替代跨平台解码性能验收。

帧时间与回调含义参见 [MDN requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)。
