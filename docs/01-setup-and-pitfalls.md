# 步骤 1：环境搭建与踩到的坑

日期：2026-07-26 · 平台：macOS (darwin 25.5.0, Apple Silicon) · Node v25.8.0 / npm 11.11.0 / Python 3.12.9

## 做了什么

1. 建骨架 `kumodeck/`：`electron/`（主进程）、`src/`（渲染层）、`sidecar/`（Python 服务）、`docs/`。
2. 先写死契约再写代码：`docs/00-architecture.md` + `sidecar/kumodeck/models.py` + `src/types.ts` + `src/design.css` + `src/lib/api.ts`。
   —— 后面所有并行实现都以这五份为准，避免多人（多 agent）并行时接口漂移。
3. `npm install`、`npm run sidecar:setup` 打通。

## 坑 1：pyncm 已从 PyPI 索引下架

**现象**

```
× No solution found when resolving dependencies:
╰─▶ Because pyncm was not found in the package registry and kumodeck==0.1.0
    depends on pyncm>=1.8 ...
```

**原因**：`pyncm` 这个包在 PyPI 上仍有文件，但**不在索引里**（被 yank / 隐藏），
`uv pip install pyncm>=1.8` 这种版本区间的写法解析不到。

**解法**：照抄 `kumocode_v2/pyproject.toml` 的做法，钉死 wheel 直链：

```toml
"pyncm @ https://files.pythonhosted.org/packages/58/f4/05d7a0116bd70dcef0f7214c0e9ee6a50a124525eaefc5c2bb0c5085f0b7/pyncm-1.8.1-py3-none-any.whl",
```

**排查提示**：这类"上游包消失"的问题，先去已经跑通的老项目的 `pyproject.toml` / `uv.lock` 里抄，
不要自己猜包名。

## 坑 2：`set -euo pipefail` 被管道吞掉退出码

`scripts/setup-sidecar.sh` 里有 `set -euo pipefail`，但我在外面调用时写成
`bash scripts/setup-sidecar.sh 2>&1 | tail -25`。管道的退出码取的是 `tail` 的，
所以**依赖装失败了，命令仍然返回 exit 0**，差点当成装好了。

**排查方式**：装完一定要用"能不能 import"来验收，不要信退出码：

```bash
sidecar/.venv/bin/python -c "import fastapi, numpy, pyncm, qqmusic_api, bilibili_api, mutagen"
```

## 坑 3：三方库版本漂移（已确认无碍，但要长期盯）

机器人那边跑的是 `qqmusic_api 0.4.1`，这边 uv 解出来是 **0.7.0**。
跨了 3 个 minor 版本，`service.py` 里用到的四个入口全都还在：

| 入口 | 0.7.0 是否存在 |
| --- | --- |
| `qqmusic_api.core.Client` | ✅ |
| `qqmusic_api.models.request.Credential` | ✅ |
| `qqmusic_api.modules.search.SearchType` | ✅ |
| `qqmusic_api.modules.song.SongFileInfo / SongFileType` | ✅ |
| `qqmusic_api.modules.login.QRCodeLoginEvents / QRLoginType` | ✅ |

`bilibili-api-python` 钉在 `17.4.2`（和机器人一致），`video.VideoDownloadURLDataDetecter`、
`login_v2.QrCodeLogin` 都在。

**长期风险**：这两个库都在跟平台接口赛跑，破坏性变更是常态。
升级前先跑这段探针脚本，不要直接升。

## 坑 4：Electron preload 必须是 CJS

`vite.config.ts` 里把 main / preload 的 rollup 输出**强制成 `format: "cjs"` + `entryFileNames: "[name].js"`**。

原因：`contextIsolation: true` 下的 preload，只有 CJS 是无条件可用的；
ESM preload 需要 `sandbox: false` 才能加载。我们已经因为要用 `fetch` 之外的能力设了 `sandbox: false`，
但仍然选 CJS —— 少一个变量，出问题时好排查。

## 坑 5：`<audio>` / `<img>` 发不了自定义请求头

sidecar 用 `X-KumoDeck-Token` 头鉴权，但试听用的 `<audio src>` 和封面 `<img src>` 是浏览器直接发的请求，
**加不了自定义头**。所以 `/api/library/audio/{id}` 和 `/api/library/cover/{id}` 这两条必须额外接受
`?token=` 查询参数。已写进契约（`docs/00-architecture.md` 2.2 节）和 `src/lib/api.ts` 的
`audioUrl()` / `coverUrl()`。

## 验证清单

```bash
node -v                                    # v25.8.0
sidecar/.venv/bin/python -c "import fastapi, uvicorn, numpy, mutagen, pyncm, qqmusic_api, bilibili_api, yt_dlp, segno, PIL"
which ffmpeg                               # /opt/homebrew/bin/ffmpeg
npx electron --version                     # v33.4.11
```

全绿才进入下一步。
