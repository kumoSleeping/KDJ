<div align="center">
  <p>
    <img src="src-tauri/icons/128x128.png" width="88" height="88" alt="KDJ">
  </p>

  <h1>
    Kumo's<br>
    <em>Download &amp; Jockey</em>
  </h1>

  <p>
    <img src="https://img.shields.io/badge/license-GPL--3.0--or--later-lightgrey?style=flat-square" alt="License">
    <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/github/v/release/kumoSleeping/KDJ?style=flat-square&label=release&color=orange" alt="Release"></a>
    <img src="https://img.shields.io/badge/Rust-dea584?style=flat-square&logo=rust&logoColor=black" alt="Rust">
    <img src="https://img.shields.io/badge/Tauri-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri">
    <img src="https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React">
  </p>

  <br>

  <img src="docs/readme-assets/01-library.png" alt="KDJ 曲库界面" width="920">
</div>

---

**中文** · [English](README.en.md)

KDJ 是一款面向音乐收集、整理、分析、播放和可视化的跨平台应用。它将多个音乐平台的搜索、试听与下载，以及本地曲库、BPM / 调性分析、波形、歌词、播放控制和歌曲可视化导出整合在同一个工作区，让准备音乐成为一条连续的工作流。

## 下载 & 安装 & 更新

按系统选择下方入口获取最新版安装包。macOS 按钮默认下载 Apple Silicon（M 系列）版本；Intel Mac 请在最新 [Releases](https://github.com/kumoSleeping/KDJ/releases/latest) 中选择 x64 DMG。

<!-- release-package-size-badges:start -->
<p>
  <a href="https://github.com/kumoSleeping/KDJ/releases/download/v1.1.0-rc17/KDJ_1.1.0-rc17_aarch64.dmg"><img src="https://img.shields.io/badge/macOS-8.5_MB-black?style=for-the-badge&logo=apple&logoColor=white" alt="macOS 8.5 MB"></a>
  <a href="https://github.com/kumoSleeping/KDJ/releases/download/v1.1.0-rc17/KDJ_1.1.0-rc17_x64-setup.exe"><img src="https://img.shields.io/badge/Windows-7.1_MB-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows 7.1 MB"></a>
  <a href="https://github.com/kumoSleeping/KDJ/releases/download/v1.1.0-rc17/KDJ_1.1.0-rc17_amd64.deb"><img src="https://img.shields.io/badge/Linux-10.1_MB-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux 10.1 MB"></a>
  <a href="https://github.com/kumoSleeping/KDJ/releases/download/v1.1.0-rc17/app-arm64-release.apk"><img src="https://img.shields.io/badge/Android-23.5_MB-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Android 23.5 MB"></a>
  <a href="https://github.com/kumoSleeping/KDJ/releases"><img src="https://img.shields.io/badge/More-Releases-555555?style=for-the-badge&logo=github&logoColor=white" alt="More releases"></a>
</p>
<!-- release-package-size-badges:end -->

安装时可能需要在系统中允许安装来自未知来源的应用。macOS 可在“系统设置 → 隐私与安全性”中允许打开。

桌面版在可以联通 GitHub 时会自动检查更新，也可以在“设置”中手动检查。Android 下载 arm64 APK 安装，更新时覆盖安装即可保留数据。

## 核心功能

### 搜索与下载

- 聚合搜索网易云音乐、QQ 音乐、SoundCloud、YouTube Music、YouTube 和哔哩哔哩，可切换单曲、歌单、艺术家、专辑和播客，并进入相关内容。
- 拖动平台图标调整来源优先级，在设置里可以关闭不用的平台。
- 支持账号登录、结果合并去重，以及单曲、歌单和合集链接解析；多行粘贴链接可批量识别。
- 支持在线试听与音质自动降级，可从播放器直接下载当前在线歌曲。
- 右键「加入下载队列」，或直接把歌曲拖进下载队列；队列支持批量开始、失败重试，并可单独调整音质或视频清晰度与保存位置，历史页保留已完成的记录。
- 歌曲可右键分享，分享内容附带歌曲信息和小尺寸封面。

### 曲库与分析

- 支持本地文件夹扫描、标签编辑、星级评分和封面管理；本地歌曲可以像文件一样拖出软件。
- 自动分析 BPM、调性和响度，调性记谱方式可在设置中切换；分析提供轻量、全力和暂停三种模式，播放时优先保证音频流畅。
- 曲库优化分析可以找出重复歌曲。
- 多选后可复制到其他文件夹，并支持撤回。
- 播放栏的彩色波形呈现歌曲的强弱与频段变化，在线歌曲也可随播放逐步生成。

### 歌曲可视化

- 为任意本地歌曲生成动态可视化：封面、歌名与艺术家、频谱和波形在一个画面里随音乐变化。
- 可视化在可移动、可缩放的浮动小窗中实时预览，小窗右下角可直接导出。
- 可视化配置抽屉提供「画面」「图片」「文字」「输出」四页，可调整参数并实时看到效果。
- 右键歌曲选择「导出可视化」，或把本地歌曲拖进导出队列；队列显示分辨率与帧率，完成后在「成品」中查看。
- 导出需要 FFmpeg，可在“设置 → 媒体工具”安装。

### 播放与控制

- 本地歌曲和在线歌曲使用统一的播放流程，并支持可开关的自动切歌。
- 底部是标准播放器，可以收成迷你播放器，放在桌面角落并浮在其他窗口之上。
- 视频和可视化都可以在浮动小窗中观看，自由移动、放大缩小；播放歌曲时小窗展示你调整好的可视化。
- 播放栏提供 Tempo、增益和三段 EQ 调节，时间可切换为已播放或剩余时间。
- 方向键可自定义为进度跳转、上下曲切换、列表选择或音量调整，也可使用系统媒体控制。
- 播放栏的波形上按住 Shift 拖动，标出一段循环播放；标出的这段可以连同歌曲一起拖给 AI。
- 视频交给 AI 剪：搜索栏的 Agent Mode 里说要怎么剪、拖进歌曲和视频，AI 做成 `.kdjv` 视频工程放进曲库，像普通视频一样播放。

### 歌词与平台体验

- 支持普通歌词与逐字歌词，并可同时显示翻译和罗马音。
- 当前歌曲和下一首歌曲的歌词会提前获取并缓存，间奏期间不会停留显示上一句歌词。
- 桌面歌词与 Android 歌词浮窗共享逐字进度，并提供外观与显示方式设置。
- 提供浅色、深色和跟随系统主题，并可从顶部快捷切换日间与夜间外观。
- 顶部的小灯泡提供使用教学：搜索、侧栏、下载、可视化和播放器，由小动画演示。
- KDJ 基于 Rust 与 Tauri 构建，支持 macOS、Windows、Linux 和 Android。

### Android

- Android 8 及以上的 arm64 设备；YouTube 播放需要 Android 9 及以上及新版 Android System WebView。
- 保留音乐搜索下载、本地曲库、分析、波形、歌词、主题和系统媒体控制；支持歌词浮窗及视频画中画。
- 不包含可视化制作、剪辑、视频工程、FFmpeg 和本地 AI；视频按系统支持的格式播放。
- 详细适配范围与设备验收见 [Android](docs/android.md)。

## 使用说明

KDJ 只提供媒体管理与技术工具。使用搜索、试听和下载功能时，请遵守所在地区的法律法规、内容平台条款及版权要求。

## 许可证

KDJ 以 [GNU GPL 3.0 或更高版本](LICENSE)发布。发行包静态链接 GPL-2.0-or-later
的 Rubber Band Library；对应源码和许可文本保存在
[`crates/kdj-player/vendor/rubberband`](crates/kdj-player/vendor/rubberband)，其他说明见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
