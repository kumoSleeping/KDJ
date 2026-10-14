# 账号登录（桌面）

一个账号在设置里只有一行：开关，和一个键——没登录是「登录」，登录了是「退出」。「登录」在这一行
底下原位展开这个账号的几种方式，不开窗口、不盖蒙版（`src/components/settings/AccountLogin.tsx`）。
展开时只列出方式：用户选了哪一种，才取二维码、才查找浏览器；再点一次同一种就收起。

| 平台 | 方式 |
| --- | --- |
| 网易云、QQ 音乐、哔哩哔哩 | 扫码 · 复用浏览器 |
| SoundCloud、YouTube、YouTube Music | 复用浏览器 · 登录窗口 · 请求头 |

手机上没有别的应用的浏览器可读：二维码存成图片，SoundCloud 走 OAuth。

## 复用浏览器

先选浏览器，后面的一切都发生在选中的那一个里，不落到系统默认浏览器上。选中的浏览器是两种之一：

| 这个浏览器 | 面板上是什么 | 用户做什么 |
| --- | --- | --- |
| 读得到已有登录（`reuse`） | 浏览器、配置（多于一个时）、「登录」 | 按一次「登录」 |
| 读不到（下面的 Windows Chromium，或认不出配置规则的浏览器） | 浏览器，和三步 | 见「读不到的浏览器」 |

读得到的浏览器，「登录」旁边一直有一个键「用 Cookie-Editor 导入」：按了就换成同一个浏览器的
三步（读失败了、读到的不是想要的账号，或只是想走这条路）。换一个浏览器或按重新检测就回到读取。

接口只有一组，所有平台共用：

- `GET  /api/accounts/{platform}/login/browsers`：本机的浏览器和配置。只枚举，不打开 Cookie
  数据库，不触发钥匙串。认得出内核或厂商的安装都列出来。
- `POST /api/accounts/{platform}/login/browser`：`{ browser, profile?, request_id }`，读已有登录。
- `POST /api/accounts/browser/login/cancel`：按 `request_id` 停掉那一次。
- `POST /api/accounts/{platform}/login/browser/open`：`{ browser, page }`，在这个浏览器里打开
  这个平台的网站（`site`）或扩展的安装页（`extension`）。网址在后端的表里，请求里没有网址。
- `POST /api/accounts/{platform}/login/cookies`：`{ headers }`，用户导出的登录，一行 `Cookie:`。

读已有登录的三条路，后端按浏览器自己选（`crates/kdj-providers/src/browser.rs`）：

| 浏览器 | 怎么读 | 用户看到什么 |
| --- | --- | --- |
| Firefox、Zen、LibreWolf 和按内核认出的 Gecko 分支 | 只读所选配置的 `cookies.sqlite`（含已提交的 WAL 和会话恢复文件），只取普通标签页：容器、隐私窗口、分区会话不读 | 无 |
| Chrome、Edge、Brave 等 Chromium（macOS、Linux） | 读所选配置的 Cookie 库，密钥来自系统钥匙串 | macOS 的钥匙串确认 |
| Safari | 读它的 Cookie 文件 | 需要「完全磁盘访问权限」；被拒绝时面板给出打开那一页设置的键 |
| Arc（macOS，仅 SoundCloud 与 YouTube） | Arc 自己的系统自动化接口（`arc_automation.rs`） | macOS 的自动化确认 |

**Windows 的 Chrome / Edge 和其它 Chromium 读不了。** 它们运行时锁住 Cookie 库，并把密钥绑定在
浏览器自身（应用绑定加密）；KDJ 不提权，也不让用户去开浏览器的远程调试开关。所以目录里它们的
`reuse` 直接是 `false`，KDJ 不去试，也就没有一条必然出现的报错。

### 读不到的浏览器：三步，登录由用户自己带回来

登录留在用户平时用的那个浏览器、那个配置里，由用户用 Cookie-Editor 扩展导出，六个平台一样：

1. 「在 Edge 打开」（键上写的是选中的浏览器）：KDJ 在**那个浏览器**里打开这个平台的网站（macOS `open -a <应用>`，Windows 直接
   启动它的程序并把网址交给它；不带任何启动参数，不新建配置）。用户确认那里已经登录。
2. 用户点工具栏上的 Cookie-Editor → Export → JSON，内容进了剪贴板。没装的话，「安装」在
   同一个浏览器里打开 cookie-editor.com 的安装页。
3. 用户回到 KDJ。窗口重新得到焦点时，面板读一次剪贴板（`read_clipboard_text`）：是这个平台
   的导出就直接登录；不是就原样丢掉，什么也不说。「粘贴」是同一件事的手动键，这时内容不对才
   报出来；剪贴板读不了时，面板给一个只收粘贴、不显示内容的框。

剪贴板只在这一种情况下读：面板正停在这三步上，并且用户已经从这里按过前两步的键。
解析在前端（`src/lib/cookieEditorImport.ts`）：只留这个站点会收到的 Cookie（域名匹配、路径 `/`、
未过期），没有这个平台的登录 Cookie 就不发请求；JSON、Netscape、Header String 三种导出都认。
后端每个平台再按自己的名单收（`import_cookie_login`），和读浏览器走同一个验证。KDJ 和扩展之间
没有任何连接，KDJ 也不安装扩展。

临时窗口（`isolated_login.rs`：在所选浏览器里开一个全新的临时配置，让用户重新登录一次）界面上
不再走：它不是「复用」，用 Google 账号登录时还会被 Google 拒绝。后端的 `window: true` 还在，
等确定不要了再删。

规则：

- 一次点击只出一个系统确认或一个窗口；同一时间只有一个窗口流程。
- 每次请求都重新枚举安装，请求里的 id 只能选中一个已登记的浏览器，变不成路径。
- 验证通过才落盘，失败时原来的登录原样留着。
- 不改用户浏览器的配置和偏好，不装扩展，不要求远程调试，不提权。
- 导出的登录不显示、不进日志，报错里也不引用它的内容。
- 日志只记固定词表里的步骤名（`login_trace.rs`），不记 Cookie、请求头和页面内容。

## 登录窗口、请求头

「登录窗口」是 KDJ 自己的无痕 WebView（`src-tauri/src/lib.rs`）。SoundCloud 的窗口遇到 Google 账号页
会自己关掉并回到「复用浏览器」：Google 不支持在内嵌 WebView 里做第三方登录。

「请求头」是把浏览器开发者工具里的请求头粘进来，用于以上都不行的时候。SoundCloud 和 YouTube
的导出登录走的是同一个解析（`import_headers`、`BrowserSession::from_headers`）。

## 浏览器从哪来

`browser::discovery` 枚举系统登记的网页处理应用：macOS 查 Launch Services，Windows 读
`RegisteredApplications` 和 `Clients\StartMenuInternet`（只取可执行文件，不执行登记的命令）。认得
bundle id / 路径的安装带上它的配置规则；认不出名字的按运行文件判断内核（Gecko：XUL + mozglue；
Chromium：framework 资源 / `chrome.dll`），只获得开临时窗口的能力，不继承别家的配置目录。没有系统
登记的便携版不会被发现。Linux 没有安装登记，按已知浏览器的配置目录列出。

## 已验证与未验证（2026-10-14）

已在真机看到的：Arc 的自动化导入 SoundCloud 真实账号（macOS）；Zen 读取已有配置后 YouTube 会话
结构校验通过（macOS）。

Windows 上（2026-10-14，候选构建）：临时窗口能打开（此前用带 `\\?\` 前缀的规范路径启动，浏览器
半秒内退出，已改）；Google 在这个窗口里拒绝登录，所以 YouTube 不再走它。

只有单元测试、没有真实账号走过的：

- 三步导入的全程（六个平台都没有用真实账号走过），以及 Windows 上的两段：把网址交给已在运行
  的浏览器、读剪贴板（`arboard`）。这两段没在 Windows 上编译或运行过。
- SoundCloud 在临时窗口里的登录（两种内核）；用 Google 账号登录 SoundCloud 同样会被 Google 拒绝。
- 网易云、QQ 音乐、哔哩哔哩的复用。QQ 的网页 Cookie 不带 `refresh_key`，票据过期后要重新登录；
  它的验证用的是「读自己的歌单」，这个接口是否一定要求登录态没有实测。
- Windows 上的一切：注册表发现、Job 清理、Chromium 临时窗口都没在 Windows 上编译或运行过。

遗留、没查清的：macOS 上钥匙串读取报过一次 `decrypt_encrypted_value failed`；SoundCloud 导入后
收藏数显示 0 而浏览器里是 184。

验证命令：`cargo test -p kdj-providers --lib browser`，
`node scripts/test-library-ui.mjs tests/youtube-login-ui.test.ts`。
