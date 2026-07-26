# 04 · 平台优先级、手排顺序、视频入库、队列开关

日期：2026-07-26（当天第四轮，用户边用边提的 7 件事）。

## 1. 平台按钮拖动排序 = 下载来源优先级

- 前端：`SearchPlatforms` 四个平台按钮 `draggable`，拖动重排后存
  `Settings.platform_priority`（默认 `["wyy","qqm","soundcloud","bilibili"]`），
  按钮按这个顺序渲染。
- 后端：`aggregate.merge_results` / `interleave_sources` 加 `priority` 参数——
  请求里 `platforms` 的顺序生成分值表（`1.0 - 0.05*i`），盖过写死的
  `PLATFORM_PRIORITY`；决定交错遍历次序和 `best_source`（哪家优先当下载源）。
  `Workspace.submit` 发请求前把已启用平台按优先级排好序。

## 2. 本地列表拖动排序（手排 set 顺序）

- **sort=custom**：`service.list_tracks` 新分支——文件夹视图（非含子级）下
  全量取出该文件夹的行，按 `.kumodeck.json` 的 `order`（文件名列表）排序，
  清单外的按文件名排在后面，再切分页。文件夹最多几百首，Python 排序足够。
- **清单合并写**：`/library/folders/order` 不再整份覆盖。同一份清单里既有
  子目录名（树的顺序）也有文件名（曲目手排），规则：没被这次提交涉及的名字
  按原相对顺序放前面。目录和文件从不在同一列表渲染，两类间先后无所谓。
- 前端：`TrackTable` 行内拖动（上半=插前、下半=插后，3px 主题色插入线），
  drop 时先按当前排序取全量（`limit=2000`，分页外的也要参与），拼出新文件名
  序列 POST 回去，然后 `setFilter({sort:"custom"})`。
- 点文件夹默认 `sort:"custom"`（set 是按演出顺序排的）；回全库还原 added_at。

## 3. 视频入口重做：删掉音乐/视频切换

- `DownloadModeTabs` / `DownloadWorkspace.tsx` 删除。
- 平台行加哔哩哔哩按钮：粉 `#fb7299` + Clapperboard 小图标。
- `Workspace.submit` 用正则识别 B 站输入
  （`bilibili.com | b23.tv | ^BV[0-9A-Za-z]{10}$ | ^av\d+$`）→ 自动
  `setDownloadMode("video")`，VideoPanel 沿 busy 上升沿解析。贴链接即视频，
  不需要手动切模式。

## 4. 曲库支持视频格式

- `tagging.VIDEO_EXTENSIONS = {mp4, m4v, mov, webm, mkv}`，
  `MEDIA_EXTENSIONS = AUDIO | VIDEO`；扫描（scan.py）和文件夹计数（folders.py）
  都改用并集。分析/波形本来就走 ffmpeg 解码，不挑容器。
- **播放拆音轨**：`/library/audio/{id}` 见到视频后缀，先
  `ffmpeg -vn -c:a copy` remux 成 m4a（webm/mkv 里的 opus/vorbis 塞不进 m4a，
  copy 失败自动第二轮 `-c:a aac -b:a 192k` 转码），缓存在
  `data_dir/audio-cache/{track_id}-{mtime}.m4a`，再走原有 Range 响应。
  半成品写 `.partial` 名 + `os.replace`（V-11 写盘纪律）。mtime 进缓存键，
  文件替换后旧缓存自动失效。

## 5. 白天模式配色

- 已播遮罩从写死的 `rgba(0,0,0,0.55)` 换成 `--kd-wave-dim`：
  深色主题盖黑、浅色盖白 `rgba(255,255,255,0.62)`。
- 浅色下 QQ 绿提亮一档（`#43d693`）。
- 列表面板 `:root[data-theme="light"] .kd-table-wrap` 铺 `--kd-panel` 白底——
  之前透出的是 `--kd-bg` 灰底，整屏结果发灰发沉。

## 6. 下载队列：默认不自动开始

- `Settings.auto_start_downloads`（默认 **false**）。
- `DownloadManager._launch_or_hold`：开关关着时任务停在 `queued`、
  把"提交进线程池"的动作存进 `job.launch`；`release_pending()` 统一放行。
- PUT /settings 里开关拨开的那一刻调 `release_pending()`——开关本身就是
  "现在开始下"的动作。取消一个攒着的任务会把它的 launch 一并丢掉，
  防止之后放行时复活。
- 前端：队列头部「自动下载」勾选框。

## 7. 接下一首去重

同一首歌在多个 set 文件夹各有一份（硬链接/拷贝），推荐里连着四行 EMOTION。
`harmonic_matches` 排序后按 `(标题或文件名, 艺人)` 归一去重，留分数最高的。

## 验证

tsc / `npm run build` / pytest 80 / smoke 19/19 全过。重启 dev 后 API 实测：
settings 出现两个新字段（auto_start=False）；`sort=custom` 返回按文件名兜底的
顺序（127 首）；harmonic 60 条 0 重复；order 路由合并写成功；DOM 上四个平台
按钮全部可拖、哔哩哔哩带视频图标、音乐/视频切换已消失、浅色主题下
`--kd-wave-dim` 正确解析为白色遮罩。

## 8.（追加）B 站关键词搜索 + 平台梯队排序

- `BilibiliProvider.search(keyword, limit)`：`bilibili_api.search.search_by_type`
  搜视频，剥掉 `<em>` 高亮、解析 "1:02:03" 钟面时长、封面归一 https
  （B 站接口回协议相对 `//i2.hdslb.com/...`，CSP 只放行 https——和网易云同一个坑，
  `resolve_video` 的封面也顺手归一了，视频面板的封面因此修好）。
- `BilibiliProvider.download(source, quality, cancel, on_progress)`：音乐管线
  统一签名，B 站来源**永远下完整视频**（1080p 落视频目录，一样入库）。
  用户原则：视频就是视频，画面不在下载环节丢掉；"只用音轨"是播放环节的事
  （/library/audio 的抽轨缓存）。想要纯 m4a 走视频面板的「只要音轨」。
  ——第一版曾做成"搜索结果默认抽音轨 + 开关"，被用户纠正后撤掉。
- **平台梯队排序**（用户的关键反馈）：B 站视频标题天然含关键词，纯按相关度
  排序会霸榜。merge_results 现在按拖动顺序分**梯队**：网易云和 QQ 永远共用
  更靠前那家的位置（两家之间只按相关度混排，不会上下半截分家）；
  B 站 / SoundCloud 按自己的拖动位置自成梯队，排最后就整块沉底、拖最前就整块
  上浮。排序键 = (梯队, -score, 原始名次)。实测：B 站排最后时从第 23 组才出现，
  拖第一时前 8 组全是 B 站。
- 平台行不再随视频模式隐藏（搜完视频接着搜音乐是常见动作，头部不能跳）。
- thumbUrl 补 hdslb 缩略：`@96w_96h_1c.jpg` 后缀；来源小方块 B 站色从蓝改成
  和按钮一致的 B 站粉 #fb7299。
- 曲目表选中行的红色描边（左侧红条 + 焦点红下划线）删除：选中只靠底色，
  焦点行改中性灰下划线。

## 9.（追加）设置页删除 + 又一轮去线

- **设置页整页删除**（SettingsView.tsx、appStore 的 view/setView、相关 CSS）。
  理由：除登录外每一项都有就地入口。左下角齿轮改为呼出**右侧详情栏**里的
  「平台登录」面板（AccountsPanel，复用 AccountRow + QrLoginDialog）——
  先做了弹窗版被否（"弹窗不符合"），详情栏本来就是"当前关注对象"的位置。
  登录共三个：网易云 / QQ / B 站；SoundCloud 无账号体系不占行。
  文件名模板、并发数等专家参数留在 settings.json 手改。
- **去线第二轮**（全部用户点名）：曲目焦点行的下边线（黑/灰都不要）、
  文件夹选中的红侧条、面板标题的红竖条（Markdown 引用式 `>` 观感）、
  `+N` 待入库徽章的底色描边（改纯红字）、以及**输入框聚焦的红框**
  （改中性灰边框 + 底色轻微抬亮）。
- 坑：一次改动横跨 store 结构（删 view 字段）+ 多个组件时，HMR 的中间态
  会把页面打成白屏（旧组件引用新 store 里已删除的字段）。`Page.reload` 一次
  即恢复，不是真错误；但验证前记得先刷。

## 注意 / 已知边界

- 手排取全量用的是 `limit=2000`：单个文件夹超过 2000 首时拖动排序会漏（现库
  最大文件夹 475 首）。
- mkv/webm 没有 mutagen 标签支持，入库时标题=文件名、时长空，分析后补齐 BPM。
- 抽音轨是首次播放时同步做的（最长 300s 超时），大视频第一次点播会等几秒。
