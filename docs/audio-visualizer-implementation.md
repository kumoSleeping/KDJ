# 音频可视化视频：第一批实施记录

日期：2026-09-21。依据 `audio-visualizer-feasibility.md` 实施。

## 当前交付边界

已实现第一步的导出内核，并在本机 Mac M2 完成真实 MP4、硬件编码、软件编码、失败回退及 Canvas 对照验证。这不是完整首版：歌曲右键入口、右侧面板、工程保存/撤销、歌词文字和分层律动仍属后续步骤。当前功能未接入正式 UI 或 HTTP/IPC 路由，开发验证通过 Rust example 进入。

Windows 编码器目前复用已有选择与探测逻辑，参数改写测试覆盖 NVENC/QSV/AMF；未在 Windows 真机运行。Chrome 独立测试页面不等于 Tauri/WKWebView 壳验收，后者也仍待完成。

## 已落地代码

- `crates/kdj-core/src/audio_visualizer.rs`：版本化场景、1–2 张图片、独立焦点/缩放/旋转/镜像/柔化、弧线、唱片与频谱参数，以及输入上限检查。
- `crates/kdj-analysis/src/visualizer.rs`：复用流式解码和 FFT，输出 30 Hz 紧凑频带、低频、RMS、起音序列。FFT 窗中心位于源音频时间，首尾补零，不保存整轨 PCM。
- `crates/kdj-server/src/compositions/audio_visualizer/`：静态几何蒙版、原始 alpha 保留、弧形双向频谱、圆盘及封面遮挡、FFmpeg 混合导出、源签名复核、成品校验和不覆盖式原子提交。
- `compositions/frame_pipe.rs`：单帧缓冲与管道背压。绘制任务逐帧等待，不堆积整曲图片，不传逐帧 JSON/Base64。
- `compositions/acceleration.rs`：原硬编模块的可重建输入适配；不是第二套编码器后端。正常文件输入的安全检查及已有测试保留。
- `src/lib/audioVisualizer*.ts`、`src/types/audioVisualizer.ts`：Canvas 预览、相同场景/时间索引、缓存图片变换与可复用透明条带。频谱使用与 Rust 相同的像素算法。

尚未添加小频谱样式、星点、分层音频律动或歌词；频带/低频/起音数据为后续效果提供基础，并不代表这些效果已经完成。

## 已验证结果

相关测试共 31 项去重用例通过：core 3、analysis 3、server 20、TypeScript 5。server 包括真实 FFmpeg 集成测试和真实 VideoToolbox 失败回退测试。`npm run typecheck` 通过；受影响既有文件的 `git diff --check` 通过。

真实编码集成测试覆盖单图、双图、横/竖图、透明图片、隐藏/圆盘/封面三种状态、旋转/镜像/柔化、重复输出拒绝覆盖、取消、导出期间素材变化和正常退出时的临时文件清理。

失败回退测试在真实 VideoToolbox 尝试写入第一帧后注入绘制故障，确认软件重试再次从第 0 帧开始；最终视频和音轨均为完整 2 秒，进度不倒退。它验证的是管道/编码尝试失败后的重建，不代表所有显卡驱动故障都已覆盖。

前后端频谱像素共享一份固定输入校验值：FNV-1a 32 位值 `3595654391`，两端均断言通过。Canvas 曾出现弧线边缘回跳像素差异，改用同算法栅格后，回跳重绘差异为零。

独立 Chrome 对照实际解码的 MP4 第 0、120、239 帧：

| 场景 | RGB 平均绝对差，0–255 | 回跳重绘差异 |
| --- | --- | --- |
| 1920×1080，封面遮挡唱片，镜像/缩放 | 1.215 / 1.371 / 1.259 | 0 |
| 2560×1080，双图/竖图，25°旋转、柔化、反向唱片、反弯弧线 | 0.677 / 0.798 / 0.699 | 0 |

此为容差内的构图/像素对照，不是声称有损 H.264 和 Canvas 完全逐像素相同。

## 样片及性能

交付目录：`/Users/kumo/Movies/KDJ-Visualizer/`。

- `phase1-1080p30-auto-20260921.mp4`：实际 `h264_videotoolbox`，8 秒、240 帧；分析 17 ms，编码合成 2858 ms，文件 5,512,649 字节。
- `phase1-1080p30-software-20260921.mp4`：`libx264`，相同源和场景；分析 16 ms，编码合成 2450 ms，文件 1,151,967 字节。

样片使用自行生成的测试音频和诊断图案，不是参考图最终美术，也不是歌曲成品。FFprobe 确认硬编样片 H.264/yuv420p、BT.709、AAC，视频/音频起点均为 0，时长均为 8.000 秒，视频确实含 240 帧。

这是 debug 构建、短合成信号、简单画面的单次测量，硬编首轮包含探测开销，不能推算所有歌曲的速度或认定硬编必然更快。FFmpeg 本机版本 7.1.1。

默认频谱条带为 565×1080 RGBA：每帧 2,440,800 字节，30 fps 为 73,224,000 字节/秒，8 秒一次尝试传输 585,792,000 字节。相比整张 1080p RGBA 帧减少约 70.6%，但这项传输和合成成本并没有消失；失败重试会重新传输。每帧只保留有界工作缓冲，FFmpeg 自己仍有解码、滤镜和编码缓存。

## 开发入口与复验

```sh
cargo run -p kdj-server --example audio_visualizer -- request.json
cargo run -p kdj-server --example audio_visualizer -- --demo /绝对路径/新样片.mp4
cargo run -p kdj-server --example audio_visualizer -- --demo /绝对路径/新样片.mp4 software
```

`request.json` 包含 `scene`、完整本地 `audio_path`、尚不存在的绝对 `output_path` 和 `acceleration`。不接受在线试听地址；目标已存在就拒绝覆盖；Ctrl+C 会取消。

```sh
cargo test -p kdj-core audio_visualizer --lib
cargo test -p kdj-analysis visualizer --lib
cargo test -p kdj-server visualizer --lib -- --include-ignored
cargo test -p kdj-server compositions::acceleration::tests --lib
cargo test -p kdj-server compositions::frame_pipe::tests --lib
node --import tsx --test tests/audioVisualizer.test.ts
npm run typecheck
```

真实硬件回退用例需要可用的 VideoToolbox。没有该能力时不要把测试失败解释为软件路径不可用。

浏览器验收：先构建 example；用 `--prepare-demo /尚不存在的临时目录` 创建测试素材/请求/频带数据，再传该目录中的 `request.json` 导出，最后运行 `node scripts/test-audio-visualizer-preview.mjs /该临时目录`。脚本仅用独立浏览器配置与本机临时 HTTP 服务，退出清理浏览器临时目录；素材目录由调用方清理。可用 `KDJ_TEST_BROWSER` 指定测试浏览器可执行路径。

## 后续门槛

下一步接入单曲右键、独立面板、固定歌曲工程、素材恢复和撤销。其后再完成分层律动、歌词及正式任务生命周期。异常进程终止后的持久化恢复、磁盘空间不足、整曲多格式兼容、Windows 真机、Tauri 双平台壳和安装包体积门禁尚未验收。

首批没有新增运行时依赖、字体或模型，没有修改包体预算，没有提交或推送既有工作区。临时测试素材均放在系统临时目录，不进入仓库；交付样片单独保留在 Movies 目录。
