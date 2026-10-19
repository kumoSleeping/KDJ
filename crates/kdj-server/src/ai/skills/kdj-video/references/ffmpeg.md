# 用 kdj_ffmpeg 渲染片段

`kdj_ffmpeg({ args, output })`：`args` 是输出文件之前的全部参数，`output` 是输出文件（相对路径放进工作目录的 `renders/`）。
KDJ 自己加 `-hide_banner -nostdin -y`。只渲染需要的那一小段：用 `-ss`（放在 `-i` 前面）和 `-t` 截取。

成片要进 .kdjv 的，统一编码，免得拼接时出问题：

```
-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r <fps> -c:a aac -b:a 256k
```

需要透明（只有画面、盖在别的轨道上）时用 `-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le`，输出 `.mov`。

## 截取与拼接

- 截一段：`["-ss","83.2","-i",SRC,"-t","15","-c:v","libx264",...]`
- 缩放到画布：`-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"`
- 铺满裁切：`-vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080"`

## 转场（xfade，两段 → 一段过渡）

```
-ss A_END-1 -t 1 -i A.mp4  -ss B_START -t 1 -i B.mp4
-filter_complex "[0:v]settb=AVTB,fps=30[a];[1:v]settb=AVTB,fps=30[b];[a][b]xfade=transition=fade:duration=1:offset=0[v]" -map "[v]"
```

`transition` 可选：fade、fadeblack、fadewhite、dissolve、wipeleft/right/up/down、slideleft/right/up/down、circleopen、circleclose、
radial、smoothleft、pixelize、hblur、zoomin、squeezeh、diagtl 等。声音用 `acrossfade=d=1`。
做法：渲染出 1 秒过渡片段，放进 .kdjv 盖在两段交界处（`at` = 交界 − 0.5）。

## 遮罩与合成

- 形状遮罩：用 Remotion 或 `geq` 画一张黑白遮罩视频，再 `[0:v][mask]alphamerge` → 透明 `.mov`，在 .kdjv 里叠在上层。
- 两段按遮罩混合：`[a][b][mask]maskedmerge`（三路同尺寸）。
- 抠绿幕：`chromakey=0x00FF00:0.12:0.08`（或 `colorkey`），输出透明 `.mov`。
- 叠加：`[bg][fg]overlay=x=W-w-40:y=H-h-40:enable='between(t,2,8)'`

## 画面效果

- 调色：`eq=contrast=1.15:saturation=1.3:brightness=0.02`、`curves=preset=vintage`、`colorbalance`、`lut3d=file.cube`、`hue=s=0`（黑白）
- 模糊：`gblur=sigma=12`、局部模糊用 `boxblur` 配 `crop`/`overlay`
- 推拉/平移（Ken Burns）：`zoompan=z='min(zoom+0.0015,1.3)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30`
- 晃动/故障感：`rgbashift=rh=6:bh=-6`、`noise=alls=20:allf=t`、`lagfun`
- 闪白/闪黑：`fade=t=in:st=0:d=0.15:color=white`
- 变速：`setpts=0.5*PTS`（声音 `atempo=2.0`）；倒放 `reverse`/`areverse`（只用于短片段）
- 防抖：`vidstabdetect` → `vidstabtransform`（KDJ 的 FFmpeg 不一定带，失败就跳过）

## 文字

简单字幕：`drawtext=text='Set A':fontsize=96:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:enable='between(t,0,3)'`。
要动画、排版、多行设计的字卡，用 Remotion。

## 分析

- 找镜头切换：`-i SRC -vf "select='gt(scene,0.35)',showinfo" -f null -`，看输出里的 `pts_time`。
- 找黑场/静音：`blackdetect=d=0.3`、`silencedetect=n=-40dB:d=0.5`（`-f null -`，output 写 `analysis.txt` 也可以，看返回的日志）。
