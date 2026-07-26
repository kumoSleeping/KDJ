# 05 · 常驻三标签、登录入口、Git 仓库与多平台打包 CI

日期：2026-07-26（当天第五轮）。

## 1. 列表面板重构：三标签常驻 + 筛选内置

用户指出两点：切换曲库/视频有**高度差**（曲库筛选条在面板外面，一出一没
整个中间区域跳）；标签**等搜索了才出现**，用户不明白结构。

- `ListMode` 扩成三态：`library | search | video`，`DownloadMode` 删除。
  「曲库 / 搜索 / 视频」三个标签常驻在列表面板顶边，随时可切、切走不丢内容。
  搜索自动切 search、贴 B 站链接自动切 video、点文件夹自动切回 library。
- `LibraryToolbar`（调号/BPM/能量筛选 + 扫描/分析）挪进 `kd-table-wrap`
  **内部**、眉目条之下——外层布局在三个标签间完全不动（CDP 实测
  splitTop 恒 134px）。
- 右栏配对：library→曲目详情，search/video→下载队列。

## 2. 登录入口 = 标签行最右的「登录」

设置页（删）→ 弹窗（否）→ 右栏面板（齿轮呼出）→ 最终形态：
眉目条最右一个「登录」标签，切右栏的 AccountsPanel；左下角齿轮删除。
登录三家：网易云 / QQ / B 站（SoundCloud 无账号体系）。

## 3. Git 仓库

`git@github.com:kumoSleeping/KumoDeck.git`（public），main 分支首次提交
85 个文件并推送；`.gitignore` 盖住 node_modules / dist* / release /
sidecar 的 venv、PyInstaller 产物、egg-info、日志。

## 4. 多平台打包 CI（.github/workflows/build.yml）

- **sidecar 不带 venv 发行**——venv 不可搬迁（解释器符号链接、shebang
  绝对路径都钉在构建机上）。改用 **PyInstaller onedir** 把 sidecar 连解释器
  冻结成独立可执行；`--collect-all yt_dlp/bilibili_api/qqmusic_api/pyncm/segno
  --collect-submodules uvicorn --hidden-import websockets`（这几家全是动态
  import，漏了运行时才炸）。在 sidecar/ 里跑，避免 PyInstaller 的 dist/
  撞 vite 的 dist/。
- `electron/main.ts` 新增 `sidecarCommand()`：优先 `resources/sidecar-bin/`
  的冻结可执行，退回开发用 venv 的 `python -m kumodeck`，CLI 参数两边一致。
  入口脚本 `sidecar/pyinstaller_entry.py`（带 `multiprocessing.freeze_support`，
  Windows 冻结包不加会无限自我复制）。
- electron-builder（electron-builder.yml）：mac DMG（arm64+x64，
  `identity: null` 不签名，用户右键打开绕 Gatekeeper）、Windows NSIS EXE、
  Linux AppImage；`extraResources: sidecar-dist → sidecar-bin`。
- 触发：`v*` tag 构建 + 发 GitHub Release；`workflow_dispatch` 只出 artifact。
  矩阵三平台，先跑 pytest 再冻结再打包，冻结完拿 `--version` 冒烟。
- 已推 `v0.1.0` tag 触发首跑。

## 已知边界

- mac 未签名：首次打开要右键 → 打开；要去掉这一步得买开发者证书配公证。
- 冻结包没带 ffmpeg：分析/波形/视频抽音轨要求用户机器上有 ffmpeg
 （`shutil.which`）。后续可以考虑把 ffmpeg 也塞进 extraResources。
- PyInstaller 首跑大概率要按缺失模块补 hidden-import，属正常迭代。
