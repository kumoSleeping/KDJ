# 可视化

## 认得出

「可视化一下」「出个可视化」「频谱」「就要个动的背景」；或者这首歌在网上确实找不到能用的画面（这时在方案里建议它）。

## 你要意识到

- 这种做法不需要搜、不需要下载，最快；不要顺手去找素材。
- `kdj_visualizer_render` 出的是 KDJ 可视化的默认样式：歌曲封面加频谱。它不是用户在可视化编辑器里调过的样子；
  用户要那个样子，请他在 KDJ 的可视化编辑器里导出。
- 歌曲要有内嵌封面；没有就告诉用户。
- 渲染整首要花时间：用户只要一段时，在 .kdjv 里用 in/out 取那一段。

## 你会做的

1. 方案：比例、整首还是哪一段、直接导出 MP4 还是放进 .kdjv 先预览。用户已经说清楚的就不问。
2. `kdj_visualizer_render`：直接导出就给 `to`（曲库文件夹）；放进工程就不给 `to`，用 renders/ 里的文件作为片段，歌放在音轨上。
3. 保存或导出、播放，用一句话报告：文件在哪、多长、什么尺寸。

## 方案（例）

`body`：

```markdown
**可视化**：给《$・¥・€》出 KDJ 可视化（封面 + 频谱），不下载任何东西。

<media ref="library:13196"/>

### 比例
<choice q="ratio" value="1920x1080">16:9（1920×1080）</choice> <choice q="ratio" value="810x1440">9:16（810×1440）</choice> <choice q="ratio" value="1080x1080">1:1（1080×1080）</choice>

### 交付
<choice q="deliver" value="kdjv">放进 .kdjv 先预览</choice> <choice q="deliver" value="mp4">直接导出 MP4</choice>
```

`questions`：`[{"id":"ratio","default":["1920x1080"]},{"id":"deliver","default":["kdjv"]}]`
