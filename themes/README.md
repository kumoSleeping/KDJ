# KDJ 主题包

一个主题包就是一个文件夹。放进客户端数据目录的 `themes/` 下（设置 → General → 主题旁的文件夹按钮可直接打开），
再到设置里选中即可。分享时把整个文件夹打包发给对方，对方解压到同一位置。

主题包不随仓库和安装包分发。开发时把主题文件夹放在本目录下（子文件夹已被 git 忽略），截图脚本会直接读取。

## 目录结构

```
themes/<id>/
  theme.json     必需
  theme.css      必需（文件名由 theme.json 的 css 指定）
  filters.svg    可选，内联注入页面，给 CSS 的 filter: url(#id) 用
  theme.js       可选
  fonts/ img/ cursors/ …  任意静态资源，CSS 里用相对路径 url(fonts/x.woff2) 引用
```

文件夹名必须等于 `theme.json` 的 `id`。

## theme.json

```json
{
  "kdj": 1,
  "id": "sketch",
  "name": "手绘",
  "version": "1.0.0",
  "author": "…",
  "modes": ["light", "dark"],
  "css": "theme.css",
  "svg": "filters.svg",
  "js": "theme.js",
  "window": { "light": "#f8f3e8", "dark": "#23302b" },
  "options": [
    { "id": "icon-filter", "type": "boolean", "label": "图标滤镜", "default": true }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `kdj` | 格式版本，目前固定 `1` |
| `id` | `^[a-z0-9][a-z0-9-]{0,31}$`，与文件夹同名 |
| `modes` | 支持的模式。只写一个时，顶栏的深浅切换按钮停用，界面固定为该模式 |
| `window` | 每个支持的模式一个 `#rrggbb`：原生窗口底色，也是启动首帧的底色，应与该模式的 `--kd-bg` 一致 |
| `options` | 用户可在设置里开关的选项，目前只支持 `boolean` |
| `css` / `svg` / `js` | 包内相对路径，不能含 `..` |

## 生效后的页面状态

```html
<html data-theme="dark" data-theme-pack="sketch" data-theme-opt-icon-filter>
```

- `data-theme` 仍是 `light` / `dark`，和默认主题共用。
- 选项打开时才有对应的 `data-theme-opt-<id>` 属性。

所有规则都用主题包属性限定作用域：

```css
:root[data-theme-pack="sketch"] { --kd-font: "Kalam", "WenKai", cursive; }
:root[data-theme-pack="sketch"][data-theme="light"] { --kd-bg: #f8f3e8; }
:root[data-theme-pack="sketch"][data-theme="dark"]  { --kd-bg: #23302b; }
:root[data-theme-pack="sketch"][data-theme-opt-icon-filter] svg.lucide { filter: url(#sketch-rough); }
```

## 怎么改外观

1. **先改令牌。** `src/design.css` 开头的 `:root`（深色）与 `:root[data-theme="light"]`（浅色）定义了
   `--kd-*` 令牌：底色、面板、线条、文字、强调色、语义色、阴影、字体、字号。覆盖它们就能改掉大部分界面。
2. **再覆盖选择器。** 圆角、边框、阴影、滚动条、勾选框、活动日志终端、视频浮层（`.kd-pip-float*`）、
   调音台、混剪编辑器（`.vj-*`）等没有令牌的地方，直接写 `kd-*` / `vj-*` 选择器覆盖。类名是稳定的。
   默认样式里带 `!important` 的规则，覆盖时也要带。
3. **默认样式里针对浅色的分支**写成 `:root[data-theme="light"] .kd-xxx`。主题若改了相关颜色，
   记得两个模式都检查。

### 只给非 CSS 绘制用的令牌

这些令牌默认没有定义（回退到内置值），主题定义了才生效：

| 令牌 | 作用 |
|---|---|
| `--kd-wave-low` `--kd-wave-mid` `--kd-wave-high` | 波形低 / 中 / 高频的颜料色。三者按各频段强度相加混合 |
| `--kd-wave-detail-bg` | 调音台细节波形的底色 |
| `--kd-panel-inset` | （已有令牌）总览波形据此计算对比度 |
| `--kd-vinyl-body` `--kd-vinyl-groove` `--kd-vinyl-label` | 拖拽曲目时的唱片预览图 |
| `--kd-eq-1` … `--kd-eq-5` | EQ 频谱渐变，从低电平到高电平 |
| `--kd-font-code` | 代码类文本（AI 提示词文本框、重复曲目质量报告）的字体。把 `--kd-font-mono` 换成数字字形时，用它让这两处保持等宽字体 |

值必须是能解析成 `rgb()` 的颜色（十六进制、`rgb()`），不要用 `color-mix()` 或带透明度的写法。

### 曲目表的行状态

| 属性 | 含义 |
|---|---|
| `tr[aria-selected="true"]` | 选中 |
| `tr[data-focus="true"]` | 详情栏正在显示的那一行 |
| `tr[data-playing="true"]` | 正在播放的曲目 |

### 桌面歌词

歌词窗与主窗加载同一份主题。在 `.kd-desktop-lyrics` 上设置 `font-family`，以及
`--kd-desktop-lyrics-accent`（已唱）、`--kd-desktop-lyrics-dim`（未唱）、`--kd-desktop-lyrics-secondary`（翻译）、
`--kd-desktop-lyrics-stroke`（描边）。用户在歌词设置里改过的颜色优先于主题。

**歌词窗必须保持透明**：不要给 `html` / `body` 的背景加 `!important`，
需要改页面底色时只改 `--kd-bg`。

## theme.js

```js
export default {
  mount(ctx) { /* ctx = { id, baseUrl, root } ；baseUrl 是本主题文件夹的 URL 前缀 */ },
  unmount() { /* 撤掉 mount 里做的一切 */ },
};
```

- 模式或选项变化时 `window` 上会派发 `kd-theme-change` 事件；当前状态直接读 `<html>` 的属性。
- 脚本抛错不影响 CSS 生效。
- 不要逐元素实时重绘边框、不要对大面积区域做逐帧滤镜动画：曲目表滚动和面板缩放会掉帧。
  边框用预生成的 SVG `border-image` 或 `box-shadow`；动画只用在小元素上，
  并放在 `@media (prefers-reduced-motion: no-preference)` 里。
- SVG 滤镜在 WebKit 里走 CPU，只用于图标这类小元素。

## 字体

字体放在主题自己的 `fonts/` 里，用相对路径引用。分发时记得附上字体的许可证说明。

## 预览与自查

```sh
cargo build -p kdj-server --bin kdj-server
node scripts/theme-shot.mjs <输出目录> [主题 id ...]
```

脚本起一套隔离的后端和浏览器预览（不碰正式数据），对每个主题 × 模式截四张图：
主界面、选中曲目后、设置面板、歌词窗。主题直接读本目录，改完重跑即可。
脚本里的 `transformCallback` 和 404 报错来自浏览器预览缺少 Tauri 环境，与主题无关。
