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
| 混合编辑多轨预览 | 同一设备时钟策略、跳转队列、备用槽出帧确认；素材时间映射留在编辑器 |
| 旧合成/叠加预览 | 同一时钟和跳转调度；保留已有画布合成 |
| 视频小窗（mpv，macOS） | 见下节；不经过 `<video>`，也不经过这里的调度层 |

## 体积、资源与边界

没有新增播放器、解码器或运行时依赖，也没有新增整段视频缓存或逐帧像素复制。保留现有视频元素数量；调度只保存少量状态和至多一个等待目标。系统解码器的缓冲内存仍由平台管理，不能据此宣称固定内存上限或零内存占用。

这是复用系统媒体解码器的共享调度实现，不是新增 Rust 原生视频解码/渲染后端。没有帧回调能力的旧系统保留媒体事件路径；不宣称该降级路径具备逐帧出画证明。YouTube 原生 HLS 的系统可用性沿用现有约束，本次没有新增 Windows/Android HLS 解码能力。

网络缓冲、源文件关键帧间隔、系统解码延迟仍会影响随机跳转；不能承诺任意位置零延迟。后续如果增加 macOS/Windows/Android 原生后端，需要维持上述统一入口和取消规则，再通过实测比较解码启动延迟、显示帧连续性、音画误差、峰值内存和发行包增量。

## mpv 视频小窗（可选，macOS）

B站、YouTube 官方嵌入播放器已移除。本地视频和在线视频预览的浮窗可以改由 libmpv 解码和出画：

- `scripts/build-libmpv-macos.sh` 编一个只保留播放的 `libmpv.2.dylib`（FFmpeg 只留解码器、容器解析和 file/http 协议，VideoToolbox 硬解，dav1d 软解 AV1，OpenGL 渲染接口，Core Audio；没有编码器、TLS、脚本、Vulkan）。所有依赖静态链接，运行时只依赖系统框架。2026-10-27 在 M2 上实测：解压 13.3 MB，gzip -9 后 6.5 MB。
- `npm run tauri:build:mpv` 用 `src-tauri/tauri.mpv.conf.json` 把它放进 `.app` 的 `Contents/Frameworks`。普通 `npm run tauri:build` 不带它，安装包大小不变。开发版从 `src-tauri/vendor/libmpv/macos/` 读取，也可以用 `KDJ_LIBMPV` 指定。
- `src-tauri/src/mpv_player.rs`：dlopen 加载 libmpv，找不到时 `mpv_status` 报不可用，前端继续用 `<video>`。画面是叠在主 WebView 上的原生 NSView（鼠标事件穿透给网页），渲染线程用 mpv 的 OpenGL 渲染接口绘制。mpv 只读取 KDJ 本机服务（127.0.0.1）的地址。
- 在线预览：mpv 自己走带、出声（音量跟随预览音量）。本地视频：只出画，跟随 KDJ 原生音频的设备时钟（`mpv_follow`）：暂停和跳转用精确跳转，播放中的误差用 ±10% 以内的变速追平；跳转出帧所需时间会作为下一次播放中跳转的提前量。工程（`.kdjv`）仍走实时合成画面。
- `src/lib/mpvPlayer.ts` + `VideoPipHost.tsx`：mpv 画面占用原先官方播放器的槽位，HTML 不能画在它上面，所以标题行在画面上方、进度条在画面下方。设置里的“视频播放器”可切回系统 WebView（只在带 libmpv 的安装包里显示）；mpv 打不开某个视频时，这一次自动退回 WebView。

## 验证

`node scripts/test-local-video-device-clock.mjs` 验证设备时钟、连续跳转、合成预览、真实帧回调判定、取消资源释放。`npm run typecheck` 验证前端调用约束。

实机验收需要在 Tauri 壳内分别覆盖本地和网络视频的普通播放、暂停跳转、播放中连续跳转、详情/浮窗/系统 PiP 切换，以及混合编辑的多轨、片段边界和速度变化。记录实测数据后才能判断卡顿是否消除；模拟测试不能替代跨平台解码性能验收。

帧时间与回调含义参见 [MDN requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)。
