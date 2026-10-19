# 音视频合并

## 认得出

用户拖来一首歌和一个视频；或者说「合并」「对上」「把 MV 配上」「音画同步」。

## 你要意识到

- 对齐靠声音比对，不靠时长。`kdj_align` 的 evidence 是 verified 才算对上；对不上（matched 为 false）就告诉用户，不要硬拼。
- 视频常常比歌短（TV size、剪过的 MV），对上之后会有没画面的空档（`kdj_align` 每套方案的 gaps）。空档不是错误，是用户要做的决定。
- DJ 接歌时开头和结尾需要画面：哪怕中间全都对上，头尾也可能需要几小节冗余。
- 为了填满而拉无关素材，比黑屏更糟。
- 翻唱、remix 和原版 MV 的声音基本对不上：这时这种做法不合适，在方案里建议改成简洁剪辑或完整 VJ。

## 你会做的

1. 没给视频时，找这首歌的原 MV 或 NCED（不超过 8 次调用）；先用在线的 ref 对齐，对得上再下载。
2. `kdj_align`：完整对齐（whole）优先；只有部分对上就用裁切匹配段（sections）。
3. 读 gaps：成片里哪几段没画面、各多长。
4. 方案：没有空档就只确认比例和交付；有空档时问下面这几件事。
5. 按选择填空档（剪点落在小节线上），保存、预渲染、播放，交报告。

## 方案（例）

`body`：

```markdown
**音视频合并**：MV 0:00–1:31 对上歌 0:00–1:31（已核实）；**1:31–3:38 共 2:07 没有画面**。

<media ref="youtube:OiQo6YyJ_pM"/>

### 没画面的部分
<choice q="gap" value="black">保留黑屏</choice> <choice q="gap" value="fill">填</choice>

### 填多少
<choice q="amount" value="edges">开头结尾各留 8 小节冗余</choice> <choice q="amount" value="all">全部填满</choice>

### 用什么填
<choice q="fill" value="anime">原作动画随机剪辑</choice> <choice q="fill" value="visualizer">KDJ 可视化</choice> <choice q="fill" value="other">其他（写在补充里）</choice>

### 交付
<choice q="deliver" value="kdjv">先给 .kdjv 预览</choice> <choice q="deliver" value="mp4">直接导出 MP4</choice>
```

`questions`：`[{"id":"deliver","default":["kdjv"]}]`

## 报告（例）

```
1. 对上的段：歌 0:00–1:31 ← MV 0:00–1:31（verified）
2. 空档：1:31–3:38（2:07）→ 用 NCOP 随机剪辑填满，按小节切，没有重复
3. 头尾冗余：结尾多留 8 小节（约 11.6 秒）
4. 要导出 MP4 吗？
```
