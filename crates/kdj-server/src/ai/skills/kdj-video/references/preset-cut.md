# 简洁剪辑

## 认得出

「简单剪一下」「剪个动画的」「不要特效」「干净点」「快点出一个」；或者用户只要一个能放的画面，没提效果。

## 你要意识到

- 用户要的是快和干净，不是创意。每多一个转场、滤镜、字卡都是噪音。
- 「简洁」不是「随便」：剪点仍然落在小节线上，画面仍然必须是这首歌自己的。
- 标准裁切会切掉边缘：素材比例和画布不同、人物又靠边时，切到脸比留黑边更糟——在方案里问。
- 字幕条是这种做法最常见的坑：只有带字幕的版本时一定问；用户没提字幕也问一句。
- 素材往往只有 TV size（约 90 秒），整首歌更长：用户没说做多长，就问整首还是 short。
- 翻唱和 remix 也先 `kdj_align`：只是整体变速的 remix 常常对得上，按 SKILL.md「对齐」铺；`matched` 为 false 才只能按小节剪，要在方案里说明。

## 你会做的

1. 探索：作品名 → NCOP/NCED、PV、MV、正片；记下时长、有没有字幕、整首还是 short、是哪一种画面。
2. 方案（见下例）。
3. 下载选中的 1–3 个素材。
4. 能对上声音的素材先 `kdj_align`，按 SKILL.md「对齐」把对上的区间原样放（不拆、不另调速）；只有 `gaps` 按小节从素材里取，不重复同一段。
5. 只写剪辑表：切、拼、0.2 秒以内的淡入淡出；等比放大铺满画布、居中裁切（选了裁字幕就只裁掉字幕那一条）。
6. 保存、预渲染、播放，交报告。

## 方案（例）

`body`：

```markdown
**简洁剪辑**：用《FX战士久留美》的无字 ED 和 OP 按小节剪成整首 3:38，不加效果；下载约 300 MB，先给 .kdjv 预览。

### 素材
<media q="source" ref="bilibili:BV14ga666EPu"/>
<shot src="/var/folders/…/kdj-peek/…/frame-01.jpg">无字 ED</shot>
<media q="source" ref="bilibili:BV16Par6YE7b"/>
<shot src="/var/folders/…/kdj-peek/…/frame-02.jpg">无字 OP</shot>

### 字幕
官方 MV 带歌词字幕：
<shot src="/var/folders/…/kdj-peek/…/frame-03.jpg">0:26 画面下方是歌词字幕</shot>
<choice q="subtitle" value="crop">裁掉字幕区</choice> <choice q="subtitle" value="keep">接受字幕</choice> <choice q="subtitle" value="skip">不用带字幕的</choice>

### 比例和长度
<choice q="ratio" value="16:9">16:9</choice> <choice q="ratio" value="9:16">9:16</choice> <choice q="ratio" value="1:1">1:1</choice>
<choice q="length" value="full">整首</choice> <choice q="length" value="first">到第一次副歌后的间奏</choice>

### 交付
<choice q="deliver" value="kdjv">先给 .kdjv 预览</choice> <choice q="deliver" value="mp4">做完直接导出 MP4</choice>
```

`questions`：`[{"id":"source","multiple":true,"default":["bilibili:BV14ga666EPu"]},{"id":"ratio","default":["16:9"]},{"id":"deliver","default":["kdjv"]}]`

## 报告（例）

```
1. 0:00–1:31  NCED 0:00–1:31（声音对齐，已核实）
   1:31–2:14  NCOP 0:12–0:55（按小节取）……
2. 空档：没有（或：2:14–2:20 黑屏 6 秒，按你的选择保留）
3. 裁切：1920×1080 居中，没有裁字幕；副歌位置是按小节线估的
4. 要导出 MP4 吗？
```
