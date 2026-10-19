# 完整 VJ

## 认得出

「做个 VJ」「剪个视频」「配画面」，没有说简洁、可视化或合并时，默认是它。

## 你要意识到

- 这是最重的做法：下得最多、渲染最久，所以方案要最清楚，确认前什么都不做。
- 效果服务于歌的段落（副歌进来时的切换、间奏的转场、drop 的冲击），不是为了显得复杂。
- **VJ 的节奏感来自叠在上层的切换和效果，不是把对上的素材拆碎重排。** 底下那条轨按 `kdj_align` 的方案原样走
  （SKILL.md「对齐」），画面里的动作才落在它自己的音乐上。曾经有一次 AI 没用对齐方案、按能量把 NCOP 拆成二十几个镜头重排，
  还给单个镜头调到 0.6 倍速，结果整片的动作都和歌错开，用户一眼就看出来了。
- 素材方向一旦定下，中途换方向要回来问。曾经有一次 YouTube 下载失败后，AI 自己换成了金色粒子和隧道素材，
  做出来的东西和歌毫无关系，整个作品报废。
- 有几种画面（动画 MV / 真人 MV / PV / Live）时让用户选，不要自己混用风格。
- 翻唱和 remix 要不要按新结构重剪、要不要更强的效果，在方案里问（见 SKILL.md）。

## 你会做的

1. 探索：作品和候选素材，曲库里有没有这首歌的 VJ。
2. 方案：素材方向（列出找到的具体候选，可多选）、画面比例、整首还是 short、字幕还是裁切、只有 short 时中间怎么补
   （原作剪辑 / 现成的长版 MAD / KDJ 可视化 / 其他）、效果多少（只剪拼 / 段落处转场 / 配合 drop 的强效果）、素材下到哪、交付方式。
3. 下载后每个素材都 `kdj_align`，按 SKILL.md「对齐」把对上的区间原样铺在底下一条轨道；只有 `gaps` 按段落和小节剪；
   效果叠在上层。剪辑表做不了的效果用 `kdj_ffmpeg` 或 `kdj_remotion_render` 渲染一小段。
4. 保存、预渲染、播放，交报告（同简洁剪辑，再加上用了哪些效果、放在哪里）。

## 方案（例）

`body`：

```markdown
**完整 VJ**：用《FX战士久留美》的原作画面按段落剪整首 3:38，副歌进入处做切换；按 1080p 下载（没有就 720p），约 1 GB，先给 .kdjv 预览。

### 素材（可多选）
<media q="source" ref="bilibili:BV14ga666EPu"/>
<shot src="/var/folders/…/kdj-peek/…/frame-01.jpg">无字 ED，画面干净</shot>
<media q="source" ref="bilibili:BV16Par6YE7b"/>
<shot src="/var/folders/…/kdj-peek/…/frame-04.jpg">无字 OP，右上角有台标</shot>
<media q="source" ref="bilibili:BV1mUa66CE5h"/>
<shot src="/var/folders/…/kdj-peek/…/frame-07.jpg">正片剪辑，带中日字幕</shot>

真人 MV 也有，但风格不同（YouTube，下载前看不到画面，只看了封面）：
<media q="source" ref="youtube:WJ_gcQl1QL0"/>

### 效果
<choice q="effects" value="cut">只剪拼</choice> <choice q="effects" value="transitions">段落处转场</choice> <choice q="effects" value="drop">配合 drop 的强效果</choice>

### 比例和交付
<choice q="ratio" value="16:9">16:9</choice> <choice q="ratio" value="9:16">9:16</choice>
<choice q="deliver" value="kdjv">先给 .kdjv 预览</choice> <choice q="deliver" value="mp4">做完直接导出 MP4</choice>
```

`questions`：`[{"id":"source","multiple":true},{"id":"ratio","default":["16:9"]},{"id":"deliver","default":["kdjv"]}]`
