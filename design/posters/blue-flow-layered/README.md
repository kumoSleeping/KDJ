# KDJ · 让音乐自由流动

竖版海报，画布比例 2:3。蓝色、米白与珊瑚色构成主配色。

## 交付文件

- `exports/KDJ-blue-flow-2400x3600.png`：高清成图。
- `exports/KDJ-blue-flow-preview.png`：1200 × 1800 预览。
- `exports/KDJ-blue-flow-layered.psd`：15 个独立、可开关的栅格图层，包含人物、字形、标题、流线、光场和产品说明。
- `exports/layers/`：15 张保留透明度的单层 PNG，编号与 `layer-index.json` 对应。
- `poster.html`、`poster.css`、`poster.js`：可编辑文字、SVG 字形与图形、位置和颜色的版式源文件。浏览器打开 HTML 可逐层预览。
- `character-study/chihaya-painted.kra`：Krita 角色源文件，保留原线稿、手工平涂、手工亮面与阴影层。
- `assets/chihaya-painted.png`：从 Krita 保存结果导出的透明人物素材。

PSD 的文字与图形是栅格图层；修改文案或矢量字形请使用 HTML/CSS/SVG 源文件。`export-poster.cjs` 可在本机重新导出全部文件。

## 制作过程

仅角色线稿使用 AI 图像生成，采用用户确认的 `chihaya-jk-lineart.png`。所有上色均在本机 Krita 通过 Computer Use 操作完成，使用油漆桶分区填色与手绘多边形亮面、衣褶阴影；未使用 AI 上色。最终为克制的平涂色块风格。

海报的 KDJ 字形、中文竖排、英文艺术字、圆环、流线、波形、细节与布局均使用 HTML/CSS/SVG 独立设计与叠加，未使用整张 AI 海报。

文案依据 [KDJ 项目](https://github.com/kumoSleeping/KDJ) 的音乐发现、整理、分析与播放功能。先前的其他人物稿为留存草稿，最终海报仅引用 `assets/chihaya-painted.png`。

## 角色参考与署名

角色按用户选择参考 THE IDOLM@STER 的如月千早，非原创角色，也非官方合作物料。官方参考：[如月千早角色页](https://millionlive-theaterdays.idolmaster-official.jp/idol/chihaya/)。

角色相关权利：©窪岡俊之 THE IDOLM@STER™ & ©Bandai Namco Entertainment Inc. 此处记录角色来源，不代表已获得授权。KDJ 当前为非商业项目；任何后续分发仍应遵守相关权利人的条款，商业用途前需重新核实许可。
