---
name: kdj
description: >-
  Operates the installed KDJ desktop app over its CLI (same binary as the GUI).
  Use when searching/downloading music, managing the local DJ library, picking
  download folders, mixing by Camelot/BPM, or the user mentions KDJ / kdj /
  曲库 / 歌单下载.
---

# KDJ CLI

- 手册版本：`{{VERSION}}`
- 核对：先跑 `kdj spec`，`data.version` 必须等于上面的版本。对不上就让用户打开 KDJ → 设置 → CLI，再导出一次。
- 导出会**整目录覆盖** `kdj/`。不要手工改这份文件，也不要保留旧的 `OLD.md`。

## 调用

手册里的 `kdj` 就是正在跑 / 已安装的 KDJ **同一份二进制**，可执行文件名通常是 `kdj-app`，**不在 PATH**。不要另装 CLI。

按顺序找路径，后面所有 `kdj …` 都换成它：

1. `command -v kdj` 或 `command -v kdj-app`
2. 正在运行的进程：`ps -o args= -p "$(pgrep -n kdj-app)"` 的第一个字段
3. macOS：`/Applications/KDJ.app/Contents/MacOS/kdj-app`

`spec` 不需要驻留进程；其余命令会连上已开的 APP，没开则拉起 `--no-gui`。不要 `kdj quit`，除非用户明确要退出。

## 更新要点（{{VERSION}}）

Agent 先读这一节。当前版本相对旧手册，必须按这些做：

1. 同一份已安装的 `KDJ` 二进制：有子命令当客户端，没有则驻留；未就绪会拉起 `KDJ --no-gui`。
2. 关窗不等于退出。`kdj ui` 唤回主窗，`kdj quit` 才真退出。
3. 下载 `--to` = 侧栏拖进文件夹；先 `kdj download dests` 再下。不要发明第二套落点。
4. 曲库写操作只有 `move` / `forget` / `delete --yes`。`forget` 不删磁盘文件。
5. 搜索 `--kind song|playlist|album|artist|radio`；歌单/专辑 key 不能直接 `download enqueue`，先 `collection get` / `collection download`。

## 约定

- 默认 JSON：`{"ok":true,"data":...}` 或 `{"ok":false,"error":{"code","message","hint"}}`
- 退出码：0 成功；1 业务失败；2 用法；3 未就绪；4 选择不唯一
- 曲目默认 brief：`id title artist bpm camelot energy rating path folder analyzed`
- 选择器 `--id` / `--path` / `--q`：0 或 >1 首要失败，并列候选
- 长任务默认等到结束；`--detach` 只回 job_id
- `delete` 必须 `--yes`；可加 `--dry-run`

未就绪时客户端会拉起 `KDJ --no-gui`。扫码登录仍要 `kdj ui`。

## 底座

```bash
kdj spec
kdj status
kdj ui
kdj quit
kdj skill export --to cursor|claude|codex|pi|<文件夹>
```

## 曲库

```bash
kdj library list [--q] [--key 8A] [--bpm 124..130] [--energy 6] [--folder] [--analyzed]
kdj library get --id|--path|--q
kdj library stats
kdj library move --id … --to <folder> [--dry-run]
kdj library forget --id … | --folder <path> [--dry-run]
kdj library delete --id … --yes [--dry-run]
kdj library undo
kdj library scan <paths...> [--analyze]
kdj library analyze [--id ...] [--pending] [--force]
```

- `move`：真搬文件，目标必须在曲库根内（等同拖到文件夹）。
- `forget`：只从本软件移除，磁盘不动。
- `delete --yes`：库记录和文件一起删。

## 搜索 / 歌单 / 下载落点

```bash
kdj search "keyword" [--kind song|playlist|album|artist|radio] [--platform wyy,qqm,ytm] [--no-merge]
kdj search capabilities
kdj collection get --platform wyy --kind playlist --key <id>
kdj collection download --platform wyy --kind playlist --key <id> [--to <folder>|default]
kdj resolve <url> [--to <folder>|default]
kdj download dests
kdj download enqueue --platform wyy --key <id> [--to <folder>|default]
kdj download ls|start|cancel|retry
kdj account ls
kdj account playlists --platform wyy
kdj account playlist download --platform wyy --key <id> [--to <folder>|default]
```

`--kind song` 默认，结果是合并后的单曲 `groups`。`--kind playlist` 等返回 `collections`；**集合 key 不能直接入队**，先 `collection get/download`。

`--to` 等同把搜索结果拖进侧栏文件夹：

| `--to` | 含义 |
|---|---|
| 省略 | 默认下载目录 |
| `default` | 设置里的 `download_dir` |
| 绝对路径或侧栏唯一名字 | 该曲库文件夹；必须先出现在 `kdj download dests` |

先 `kdj folder mkdir` 再 `--to`。不要发明第二套歌单下载配置。

## 混音 / 文件夹 / 设置

```bash
kdj mix next --id 42 [--bpm-tolerance 12] [--limit 12] [--folder]
kdj mix query --bpm 128 --key 8A
kdj folder tree
kdj folder mkdir --parent <path> --name <name>
kdj folder rename|mv|rmdir
kdj settings get
kdj settings set --download-dir <path>
```

## 工作流

1. `kdj status` → 需要界面就 `kdj ui`
2. `kdj search --kind playlist "…"` → `collection download --to <夹>`
3. `kdj library analyze --pending` → `kdj mix next --id …`
4. 整理：`library move` / `forget` / `delete --yes`

不要：自己改 `kumodeck.db`；把 playlist key 当歌曲下载；对曲库根外 `--to`；播放/Deck（无 CLI）。
