# 桌面媒体工具

Mac（Apple Silicon / Intel）及 Windows x64 在“设置 → 媒体工具”提供一键安装。混音编辑器检测到工具未就绪时，也提供同一安装面板入口。Windows 其他架构可导入兼容的工具包，Linux 沿用系统包安装。已存在的系统 / Homebrew 安装会自动识别。

Mac 和 Windows 都可通过系统文件选择窗口导入 ZIP 或解压文件夹；FFmpeg 和 ffprobe 分别打包时支持同时选择两个 ZIP。取消选择不启动安装。Mac 根据 KDJ 运行架构选择原生构建，导入时在启动工具前检查 Mach-O 架构，接受包含对应架构的通用二进制。

## 安装与恢复

安装到当前 KDJ 数据目录的 `tools/ffmpeg/install-*/package`，不需要管理员权限，不安装 Homebrew，也不改系统 Path。选择文件夹接受 `bin`、包含 `bin` 的发行包目录，或发行包的直接上级目录；多套发行包需要选择具体一套。选中 `bin` 时复制其上级完整发行包，保留相邻 DLL、文档和许可证。直接选中散放工具的目录时只复制工具、相邻 DLL / dylib 及许可证和文档，不复制无关下载。Homebrew 的符号链接不作为独立发行包复制。成功后原 ZIP / 文件夹可移走。

导入限制路径、文件数量和展开大小，拒绝符号链接、ZIP 路径穿越及 Windows 设备文件名。自动下载使用 HTTPS，对照发布方 `.sha256` 校验完整性；每个包的请求 URL、解析后 URL、来源和校验值记录到 `download-*.origin.json`。此校验用于确认包与发布方公布的内容一致，不是独立的签名认证。Mac 自动下载还通过系统 `codesign --verify --strict` 检查代码签名。

在独立暂存目录中导入后，Mac 为两个工具设置执行权限；分别运行 `ffmpeg -version` 和 `ffprobe -version`，检查退出状态、名称及版本一致性，并保存 `ffmpeg -L` 输出。两个工具都通过才原子更新 `current.json`，当次会话立即生效，重启后恢复选择。失败清理暂存内容并保留原工具；旧版本到下次启动才删除，避免影响正在进行的导出。退出应用中断的安装在下次启动清理。检测到文件缺失或无法运行时可重新安装。

## 来源和许可

- Windows：直接从 [Gyan Doshi 的 FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/) 下载 `ffmpeg-release-essentials.zip`；[FFmpeg 官方下载页](https://ffmpeg.org/download.html) 提供该 Windows 构建来源。Gyan 标明这些构建采用 GPLv3，构建页提供对应 FFmpeg 源码链接。
- Mac：直接从 [Martin Riedl 的构建服务](https://ffmpeg.martin-riedl.de/) 下载对应 `macos/arm64` 或 `macos/amd64` 的 release ZIP。来源提供 SHA256、代码签名，以及版本 / 构建参数信息；[构建脚本](https://git.martin-riedl.de/ffmpeg/build-script) 为 Apache-2.0，这不是 FFmpeg 二进制的许可证。核对的 release 构建启用 `--enable-gpl --enable-version3`，实际二进制许可由每次安装保存的 `ffmpeg -L` 输出记录。

保留发行包内的许可证、README 和文档；两个 ZIP 的同名文档分目录保存，不互相覆盖。设置页提供对应来源与许可链接。KDJ 安装包不携带这些二进制，不代理或重新分发下载。

用户导入的构建可能含不同组件和条款，保留其原包文档，不能从自动下载来源的声明推断任意导入包的许可。未来若随 KDJ 安装包分发或托管镜像，需要重新核对对应构建、依赖的署名、许可证和完整对应源码义务。KDJ 当前为非商业项目。

## 验证

Rust 定向测试覆盖原生架构选择、Mach-O 识别、压缩 ZIP、双 ZIP 合并、目录识别、DLL / 许可证保留、无关下载隔离、危险路径、损坏包、失败回退、持久化和清理；前端测试覆盖进度恢复、完成检测、取消选择和重复点击。这些测试已接入现有 CI。

`mac_download_install_and_export_smoke` 为显式运行的网络测试，在自动清理的临时目录中完成真实 Mac 下载、签名检查、安装及 H.264 / AAC 导出，不切换用户配置。Windows 的原生安装和实际导出仍需 Windows 实机验收。
