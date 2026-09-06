# 05 · 常驻三标签、登录入口与 Git 仓库

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

`git@github.com:kumoSleeping/KDJ.git`（public），main 分支首次提交
85 个文件并推送；`.gitignore` 覆盖依赖目录、构建产物、缓存和日志。
