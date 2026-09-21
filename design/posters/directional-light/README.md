# KDJ · 斜向光影修订

2:3 竖版海报，2400 × 3600 像素。米白纸底、手绘字形和分区赛璐璐光影。

## 文件

- exports/KDJ-directional-light-2400x3600.png：高清海报。
- exports/KDJ-directional-light-preview.png：1200 × 1800 预览。
- exports/KDJ-directional-light-layered.psd：9 个独立海报栅格图层，人物光影层使用正片叠底。
- assets/directional-shading.svg：手工绘制的可编辑光影路径，分为发束、皮肤、衣服、领结投影、裙褶五组。
- character/chihaya-directional-light.kra：本机 Krita 手绘底稿，已去除上一版横向整体暗带；不包含本轮另行合成的 SVG 光影。
- assets/chihaya-directional-light.png：Krita 底稿保存时的透明合成图。
- poster.html / poster.css / poster.js：海报文字、字形、背景和光影合成源文件。
- exports/layers/ 与 exports/layer-index.json：分层图像和顺序索引。

## 修订方法

旧横向暗带在 Krita 中移除并另存。继续操作时，Computer Use 可以读取图层控件，但所有画布坐标点击和拖动均持续返回 noWindowsAvailable；重建窗口及独立画布未解决。因此本轮后续采用用户早先允许的 CSS 设计方式：保留已有 Krita 手绘底色和黑线，手工编写独立 SVG 路径，按左上前方来光分别设计发束背光面、脸侧与下颌、手腕、衣领投影、袖筒转折和裙褶凹面。SVG 作为独立正片叠底层合成，未使用 AI 生成上色或海报。

取消背后的蓝色几何底形与双轮廓，保留完整米白纸底与轻微纸纹。人物不使用底部渐隐。字体层级及独立侧排 GitHub 链接保留。

这是人工设计的二维光影，并非三维几何计算或物理渲染。PSD 中的文字和路径为栅格图层；编辑文字和路径请使用对应 HTML/CSS/SVG 文件。原 ink-light 与 hand-painted 交付文件均保留。

## 参考资料

- [Proko: How to Shade a Drawing](https://www.proko.com/course-lesson/how-to-shade-a-drawing/)：比较光源方向与形体表面朝向，并根据承影表面绘制投影。
- [CLIP STUDIO: Simple Anime-style Coloring Techniques](https://www.clipstudio.net/how-to-draw/archives/162911)：动画风格的分区上色方法。
- [マイナビ出版：YURIKO 式影指定ワークブック](https://prtimes.jp/main/html/rd/p/000000037.000016440.html)：斜上方来光等常用方向的影指定范例。

## 项目与角色来源

文案基于 [KDJ 项目](https://github.com/kumoSleeping/KDJ)。角色原线稿按用户选择参考 THE IDOLM@STER 如月千早，原始线稿文件为 ../blue-flow-layered/character-study/chihaya-jk-lineart.png；[官方角色参考](https://millionlive-theaterdays.idolmaster-official.jp/idol/chihaya/)。

©窪岡俊之 THE IDOLM@STER™ & ©Bandai Namco Entertainment Inc. 此为来源记录，并非原创角色、官方合作或取得授权的声明；KDJ 当前为非商业项目，后续分发需遵守相关权利人的条款，商业用途前重新核实许可。
