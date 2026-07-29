<div align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="KDJ 图标">
  <h1>KDJ</h1>
  <p><strong>下载 / 管理 / 播放 / 混合</strong></p>

  <p>
    <a href="https://github.com/kumoSleeping/KDJ/releases/latest">
      <img src="https://img.shields.io/github/v/release/kumoSleeping/KDJ?style=flat-square&label=Release" alt="最新版本">
    </a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-222?style=flat-square" alt="支持 macOS、Windows 和 Linux">
    <img src="https://img.shields.io/badge/license-MIT-222?style=flat-square" alt="MIT License">
  </p>

</div>

![KDJ 曲库界面](docs/readme-assets/01-library.png)

KDJ 把跨平台搜歌、下载、本地曲库和音乐分析放进一个桌面应用。无需在多个网站、下载器和标签工具之间来回切换，准备音乐可以是一条连续的工作流。

## 核心功能

- **一次搜索多个平台** — 聚合网易云音乐、QQ 音乐、SoundCloud 与哔哩哔哩结果，并自动合并重复曲目。
- **整理自己的曲库** — 直接管理电脑中的常见音频和视频文件，按文件夹组织，不改变原有的存放习惯。
- **看懂每一首歌** — 自动分析 BPM、调性、Camelot 编号、响度与能量，快速找到适合衔接的下一首。
- **获取音乐与画面** — 支持关键词、分享链接和歌单；可下载 B 站视频，也可只保留音轨。
- **在应用内试听与编排** — 波形预览、和声推荐、自动接播与交叉渐变，让选曲到排 Set 更顺手。

## 开始使用

1. 前往 [Releases](https://github.com/kumoSleeping/KDJ/releases/latest)，下载适合系统的安装包。
2. 打开 KDJ，添加已有的音乐文件夹，或先搜索并下载曲目。
3. 等待自动分析完成，即可按 BPM、调性、能量和文件夹筛选曲库。

KDJ 支持 macOS、Windows 和 Linux。部分来源允许扫码登录，以访问你账号本身有权播放或下载的内容。

> [!NOTE]
> 常规曲库管理和音乐分析不依赖 FFmpeg。视频混流、抽取视频音轨及 VJ 导出等功能需要系统已安装 [FFmpeg](https://ffmpeg.org/download.html)。

## 为开发者构建

需要 Node.js 20+、Rust 1.85+，以及对应平台的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/kumoSleeping/KDJ.git
cd KDJ
npm install
npm run dev
```

常用命令：

```bash
npm run typecheck        # 前端类型检查
npm run tauri:web:build # 构建前端
npm run build            # 构建桌面安装包
```

KDJ 使用 React 19 构建界面，Rust 负责曲库、分析、下载与播放能力，并通过 Tauri 2 提供原生桌面体验。

## 使用说明

KDJ 只提供媒体管理与技术工具。使用搜索、试听和下载功能时，请遵守所在地区的法律法规、内容平台条款及版权要求。

## 许可证

KDJ 以 [MIT](https://opensource.org/license/mit) 许可证发布。
