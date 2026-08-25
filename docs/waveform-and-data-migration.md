# 波形就绪与旧数据迁移

这条改造有两个硬约束：播放不能等波形，升级不能丢现有曲库数据。波形正文仍是磁盘缓存；SQLite 只负责曲目和以后要补的就绪状态。

## 已落地：第一阶段

### 文件夹元数据

每个受管目录现在使用：

```text
音乐文件夹/
└── .kdj/
    ├── manifest.json
    └── legacy-manifest-v1.json   # 只在迁移旧清单时出现
```

读取顺序是新清单、旧 `.kdj.json`、迁移备份。旧清单先备份，再原子写入并校验新清单，最后才删除旧文件。坏清单保持原样，不拿空顺序覆盖。

启动后的递归迁移通过 `maintenance.progress` 进入曲库活动栏。单个只读目录失败不会拖停其他目录，错误留在活动栏，不弹窗。

### 数据库别名修复

运行期规范数据库仍是 `kumodeck.db`。曾有版本把旧库迁成 `kdj.db`，造成同一数据目录两份库分叉。启动时会执行一次只增不改的合并：

- 当前库已有路径不覆盖；
- 旧库独有曲目补入；
- 标签和歌单按歌曲路径重新映射；
- 旧 `kdj.db` 保留；
- 合并成功后写 `.kdj-db-alias-merged-v1`，重复启动不重复改库。

### 波形可靠性

不再在启动、数据升级或全库分析结束后逐首预热波形。完整解码上千首歌只为概览会运行数小时，还会和当前 Deck 争磁盘与 CPU。现在只请求当前曲和预测下一首。release overview 固定保存 4096 列；current detail 仍先复用 640 列快速档，再升级到高密度 master。

canonical 波形是 `.kdwave` 小端二进制，带魔数、格式版本、track、时长和列数。读取前会校验总长度和四个通道；写入仍走临时文件加原子提交。HTTP 另用 36-byte 自描述 wire header，显式携带 current/release profile 与算法 revision，避免前端把同形数组放进错误缓存。旧算法文件不迁移成新波形，避免把 31.25 列/秒的数据伪装成高密度 master。

current detail 不跑整轨 sinc resample 或 STFT：源采样率 PCM 经过 600 Hz / 4 kHz 互补 IIR crossover，一遍生成 200 列/秒峰值 master，Performance 保存 100 列/秒。release overview 独立保留 v0.2.41 的 16 kHz STFT、幅度归一化和三频段颜色，只把输出从 640 列提高到 4096 列。前端把整曲切成互不重叠的一 CSS 像素时间区间，每个区间独立取振幅中位值，再以 backing-store 密度绘制。短于可见区间的离群瞬态不会撑满一列，相邻高低值也不会被滑动平均拟合成圆形或菱形。整数采样率比的 Blackman-sinc 权重按相位预计算；44.1 kHz 转 16 kHz 只有 160 组权重。热循环用整数相位累加器推进，不再逐样本计算三角函数或执行 `u128` 乘除取模。

交互冷命中只解码一次 native-rate mono PCM，再从同一份 PCM 生成 release overview 和 current detail；先请求哪一种都顺带原子写好另一种，挂载 Performance 不再重新解压整首歌。请求中的 profile 写入失败仍会报错，顺带生成的 profile 只做尽力缓存，不能反过来拖垮可用波形。全库维护任务不走这条双 profile 快路径，避免为未装入过 Deck 的歌曲批量生成 24,000 列资产。Release profile 使用 `opt-level=2`；继续使用体积优先的 `z` 会让 M2 上的 Symphonia 解码和波形 DSP 慢一倍以上。

DJ detail 与 release overview 共用低频红、中频绿、高频蓝的视觉语言和低频红色压制规则，但不共用职责。overview 继续按屏幕时间区间取中位值，拒绝不足一个宏观像素的离群瞬态；detail 继续按屏幕列取 peak、保持 600 Hz / 4 kHz 分频、100 列/秒、Beat Grid 和实时 GAIN 高度，因此 kick、cue 和拍点不能被 overview 的降噪规则抹掉。detail 只在显示 palette 中进一步抬起副通道，减少高密度视图的 RGB 彩屑感。进入 DJ 模式时若内存里已有 640 列预览，只保留 120 ms 给首帧提交；没有预览则直接请求已经被 release 冷命中写好的 detail，不再多走一次 640 列 HTTP 和固定 750 ms 等待。

SQLite 的 `waveform_assets` 仍保存 track、profile、revision、源文件 mtime、生成时间和错误，但启动不再据此发起整库补齐。v6 detail 新缓存原子写入成功后，才删除同曲 v2/v3/v4/v5 文件；没有装入过 Deck 的曲目不为迁移而解码。

播放器会提前请求当前曲和预测下一曲。前端使用 24 首 LRU 与单飞请求；切到已经预取的 Deck 时只需要画 canvas。

## 必须保持的行为

- 波形失败不能阻止音频播放。
- 播放器请求的波形优先于后台分析。
- 文件修改后，缓存键中的 mtime 让旧波形自动失效。
- 新旧清单同时存在时优先新文件；新文件损坏时仍能读旧文件。
- 删除“空文件夹”时允许清理 KDJ 自己的 `.kdj`，但 `.kdj` 中有未知内容就拒绝删除。
- 文件夹移动和跨卷复制必须连 `.kdj` 一起移动。

## 下一阶段

1. 解码器增加真正的流式输入，让长 Mix 的 native-rate samples 也不必全部常驻内存。
2. 增加 Set 预检：主分析、波形和文件可读性全部通过后才标记“演出就绪”。

## 回归检查

```bash
npm run typecheck
npm run tauri:web:build
cargo test --workspace --all-targets
cargo check -p kdj-app
```

后端、Tauri 配置或启动迁移发生变化时，还必须完整停止并重新启动 `npm run tauri:dev`。
