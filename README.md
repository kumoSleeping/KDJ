<div align="center">
  <p>
    <img src="src-tauri/icons/128x128.png" width="88" height="88" alt="KDJ">
  </p>

  <h1>
    Kumo's<br>
    <em>Download &amp; Jockey</em>
  </h1>

  <p>
    <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="License">
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

KDJ 把跨平台搜歌、下载、本地曲库和音乐分析放进一个桌面应用。无需在多个网站、下载器和标签工具之间来回切换，将准备音乐构筑为一条连续的工作流。

## 下载 & 安装 & 更新

按系统选择下方入口，打开最新 [Releases](https://github.com/kumoSleeping/KDJ/releases/latest) 获取安装包。

<p>
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/macOS-black?style=for-the-badge&logo=apple&logoColor=white" alt="macOS"></a>
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows"></a>
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux"></a>
  <a href="https://github.com/kumoSleeping/KDJ/releases/latest"><img src="https://img.shields.io/badge/Android-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Android"></a>
</p>

安装时需要在系统中允许安装来自未知来源的应用。MacOS 需要在“系统偏好设置 → 安全性与隐私 → 通用”中允许打开。

当软件所在环境可以联通 GitHub 时，KDJ 会在启动时自动检查更新。也可以在“设置”中手动检查。

> [!NOTE]
> 常规曲库管理和音乐分析不依赖 FFmpeg。视频混流、抽取视频音轨及 VJ 导出等功能需要系统已安装 [FFmpeg](https://ffmpeg.org/download.html)。

## 核心功能
- 下载
  - 跨平台聚合搜索
  - 扫码登录与来源优先级
  - 结果合并去重；单曲 / 歌单链接与批量投喂
  - 在线试听与音质降级（FLAC / 320 / 128）
  - 歌单一键下载与可配置下载队列
  - 自动搜索匹配 VJ
- 曲库管理
  - 自由拖动设计理念
  - 本地曲库 / 文件夹扫描与标签编辑
  - Camelot 色轮与 BPM / 能量筛选
  - 自动分析 BPM、调性、Camelot / Open Key、响度与能量
  - 和声相似推荐（全库 / 文件夹 / 临时列表）
  - 波形起止点、星级评分与封面
  - 自动 VJ 导出（依赖 [FFmpeg](https://ffmpeg.org/download.html)）
- 播放
  - 系统级音频输出与音量控制
  - rkb 风格波形预览
  - 多种切歌效果（交叉 / 低频交接 / 滤波 / FX）
  - 视频浮窗与系统画中画；视频混流与抽取音轨
  - VJ 导出（视频混流 + 音频混音）
  - 歌词索引与系统级悬窗显示
- 其他
  - 浅色 / 深色 / 跟随系统；精心设计的交互逻辑
  - 基于 Tauri 的轻量桌面应用；支持 Android
  - 启动自动检查更新

## 使用说明

KDJ 只提供媒体管理与技术工具。使用搜索、试听和下载功能时，请遵守所在地区的法律法规、内容平台条款及版权要求。

## 许可证

KDJ 以 [MIT](https://opensource.org/license/mit) 许可证发布。
