# 账号登录（桌面）

一个账号在设置里只有一行：开关，和一个键——没登录是「登录」，登录了是「退出」。「登录」在这一行
底下原位展开这个账号的几种方式，不开窗口、不盖蒙版（`src/components/settings/AccountLogin.tsx`）。

| 平台 | 方式 |
| --- | --- |
| 网易云、QQ 音乐、哔哩哔哩 | 扫码 · 复用浏览器 |
| SoundCloud、YouTube、YouTube Music | 复用浏览器 · 登录窗口 · 请求头 |

手机上没有别的应用的浏览器可读：二维码存成图片，SoundCloud 走 OAuth。

## 复用浏览器

用户选一个浏览器（有多个配置时再选配置），按一次「登录」。接口只有一组，所有平台共用：

- `GET  /api/accounts/{platform}/login/browsers`：本机的浏览器和配置。只枚举，不打开 Cookie
  数据库，不触发钥匙串。
- `POST /api/accounts/{platform}/login/browser`：`{ browser, profile?, request_id, window? }`。
- `POST /api/accounts/browser/login/cancel`：按 `request_id` 停掉那一次。

读已有登录的三条路，后端按浏览器自己选（`crates/kdj-providers/src/browser.rs`）：

| 浏览器 | 怎么读 | 用户看到什么 |
| --- | --- | --- |
| Firefox、Zen、LibreWolf 和按内核认出的 Gecko 分支 | 只读所选配置的 `cookies.sqlite`（含已提交的 WAL 和会话恢复文件），只取普通标签页：容器、隐私窗口、分区会话不读 | 无 |
| Chrome、Edge、Brave 等 Chromium（macOS、Linux） | 读所选配置的 Cookie 库，密钥来自系统钥匙串 | macOS 的钥匙串确认 |
| Safari | 读它的 Cookie 文件 | 需要「完全磁盘访问权限」；被拒绝时面板给出打开那一页设置的键 |
| Arc（macOS，仅 SoundCloud 与 YouTube） | Arc 自己的系统自动化接口（`arc_automation.rs`） | macOS 的自动化确认 |

**Windows 的 Chrome / Edge 读不了。** 它们把 Cookie 密钥绑定在浏览器自身（应用绑定加密），普通
权限的外部程序解不开；KDJ 不提权，也不让用户去开浏览器的远程调试开关。读取会立刻失败，然后：

- SoundCloud、YouTube：在**同一个浏览器**里开一个临时窗口（全新的临时配置，用完删除），用户在里面
  登录一次，KDJ 读回这个站点的登录 Cookie（`isolated_login.rs`；Chromium 走 CDP，Gecko 走
  WebDriver BiDi）。任何读不到的情况都这样接续，中间的失败不报，只报最后的结果。
- 网易云、QQ 音乐、哔哩哔哩：报出读取的错误。它们另有扫码。

规则：

- 一次点击只出一个系统确认或一个窗口；同一时间只有一个窗口流程。
- 每次请求都重新枚举安装，请求里的 id 只能选中一个已登记的浏览器，变不成路径。
- 验证通过才落盘，失败时原来的登录原样留着。
- 不改用户浏览器的配置和偏好，不装扩展，不要求远程调试，不提权。
- 日志只记固定词表里的步骤名（`login_trace.rs`），不记 Cookie、请求头和页面内容。

## 登录窗口、请求头

「登录窗口」是 KDJ 自己的无痕 WebView（`src-tauri/src/lib.rs`）。SoundCloud 的窗口遇到 Google 账号页
会自己关掉并回到「复用浏览器」：Google 不支持在内嵌 WebView 里做第三方登录。

「请求头」是把浏览器开发者工具里的请求头粘进来，用于以上都不行的时候。

## 浏览器从哪来

`browser::discovery` 枚举系统登记的网页处理应用：macOS 查 Launch Services，Windows 读
`RegisteredApplications` 和 `Clients\StartMenuInternet`（只取可执行文件，不执行登记的命令）。认得
bundle id / 路径的安装带上它的配置规则；认不出名字的按运行文件判断内核（Gecko：XUL + mozglue；
Chromium：framework 资源 / `chrome.dll`），只获得开临时窗口的能力，不继承别家的配置目录。没有系统
登记的便携版不会被发现。Linux 没有安装登记，按已知浏览器的配置目录列出。

## 已验证与未验证（2026-10-14）

已在真机看到的：Arc 的自动化导入 SoundCloud 真实账号（macOS）；Zen 读取已有配置后 YouTube 会话
结构校验通过（macOS）。

只有单元测试、没有真实账号走过的：

- 临时窗口登录（两种内核）。Google 可能拒绝带远程调试参数启动的浏览器登录，Firefox 系尤其可能。
- 网易云、QQ 音乐、哔哩哔哩的复用。QQ 的网页 Cookie 不带 `refresh_key`，票据过期后要重新登录；
  它的验证用的是「读自己的歌单」，这个接口是否一定要求登录态没有实测。
- Windows 上的一切：注册表发现、Job 清理、Chromium 临时窗口都没在 Windows 上编译或运行过。

遗留、没查清的：macOS 上钥匙串读取报过一次 `decrypt_encrypted_value failed`；SoundCloud 导入后
收藏数显示 0 而浏览器里是 184。

验证命令：`cargo test -p kdj-providers --lib browser`，
`node scripts/test-library-ui.mjs tests/youtube-login-ui.test.ts`。
