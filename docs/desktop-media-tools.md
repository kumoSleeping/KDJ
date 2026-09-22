# 桌面媒体工具

Mac（Apple Silicon / Intel）及 Windows x64 在“设置 → 媒体工具”提供一键安装、导入 ZIP / 7Z、导入文件夹、下载来源和重新检测。混音编辑器检测到工具未就绪时，也提供同一面板入口。

已存在的系统 / Homebrew 安装会自动识别；工具就绪后仍可导入另一套或重新安装。Windows 其他架构暂不支持一键安装，但可导入兼容架构的工具；Linux 沿用系统包安装。

## 安装与恢复

一键安装自动完成下载、校验、解压和运行验证。下载失败时可重试，也可导入已有的 ZIP、7Z 或已解压文件夹；压缩格式按文件内容识别，分开的 FFmpeg / ffprobe 包可同时选择。加密压缩包不支持。文件夹可选择 bin、工具包根目录或最多四层的外层目录。界面完整显示失败步骤、请求地址及错误详情，并可复制。成功后当次会话立即可用，无需重启。

工具保存到当前 KDJ 数据目录的 `tools/ffmpeg/install-*/package`，不需要管理员权限，不安装 Homebrew，也不修改系统 Path。重启后恢复选择。

桌面下载读取系统 HTTP / HTTPS 代理配置；应用内部服务通信不走代理。下载使用 HTTPS，先解析到具体版本的地址，再对照该版本的 `.sha256` 校验完整性，避免最新版更新时混用包与校验值。每个包的请求 URL、解析后 URL、来源和校验值记录到 `download-*.origin.json`。此校验用于确认包与发布方公布的内容一致，不是独立的签名认证。Mac 自动下载还通过系统 `codesign --verify --strict` 检查代码签名。

解压限制路径、文件数量和展开大小，拒绝符号链接、路径穿越及 Windows 设备文件名。7Z 使用 Rust 库解压，不要求另装 7-Zip；也拒绝删除标记和重解析点。在独立暂存目录中解压后，Windows 检查 PE 可执行文件头及兼容架构，Mac 检查 Mach-O 架构并设置执行权限。分别运行 `ffmpeg -version` 和 `ffprobe -version`，检查退出状态、名称及版本一致性，并保存 `ffmpeg -L` 输出。

两个工具都通过才原子更新 `current.json`。失败清理暂存内容并保留原工具；旧版本到下次启动才删除，避免影响正在进行的导出。退出应用中断的安装在下次启动清理。检测到文件缺失或无法运行时可重新安装；检测使用当前选定的一套工具，不以系统里的另一份 ffprobe 掩盖私有安装损坏。

## 来源和许可

- Windows：直接从 [Gyan Doshi 的 FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/) 下载 `ffmpeg-release-essentials.zip`；[FFmpeg 官方下载页](https://ffmpeg.org/download.html) 提供该 Windows 构建来源。Gyan 标明这些构建采用 GPLv3，构建页提供对应 FFmpeg 源码链接。
- Mac：直接从 [Martin Riedl 的构建服务](https://ffmpeg.martin-riedl.de/) 下载对应 `macos/arm64` 或 `macos/amd64` 的 release ZIP。来源提供 SHA256、代码签名，以及版本 / 构建参数信息；[构建脚本](https://git.martin-riedl.de/ffmpeg/build-script) 为 Apache-2.0，这不是 FFmpeg 二进制的许可证。核对的 release 构建启用 `--enable-gpl --enable-version3`，实际二进制许可由每次安装保存的 `ffmpeg -L` 输出记录。

保留发行包内的许可证、README 和文档；两个压缩包的同名文档分目录保存，不互相覆盖。Windows 的 Gyan Full、Full Shared 和 Git 构建提供 7Z，可从下载来源页面获取后直接导入。KDJ 安装包不携带这些二进制，不代理或重新分发下载。

用户自行安装的构建可能含不同组件和条款，不能从自动下载来源的声明推断任意构建的许可。未来若随 KDJ 安装包分发或托管镜像，需要重新核对对应构建、依赖的署名、许可证和完整对应源码义务。KDJ 当前为非商业项目。

Windows 的原生安装和实际导出仍需 Windows 实机验收。
