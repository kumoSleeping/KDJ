# Windows SoundCloud 浏览器连接

## Windows 启动前提

Windows MSVC 构建通过仓库 `.cargo/config.toml` 静态链接 C/C++ 运行库；
Rust 和通过 `cc` 编译的 Rubber Band 使用一致的 CRT 配置，不要求用户另装
Visual C++ Redistributable。桌面产物门禁调用 `check-windows-runtime.ps1`，
检查实际 `kdj-app.exe` 及同目录 DLL 的普通和延迟导入，拒绝编号 MSVC 运行库依赖。
这项检查不能替代无 VC++ 运行库的 Windows 虚拟机启动验收。

2026-10-12 的 de35bc9 测试包在虚拟机报 `MSVCP140.dll` 缺失，未进入账号导入；
原因是测试分支漏带主目录已有的静态 CRT 配置。后续验收保持虚拟机未安装 VC++
运行库，先确认新版可以启动，再执行下述账号测试。

## 浏览器授权（当前主路径）

Mac 显示「钥匙串读取」和「浏览器授权」两种独立方式。Windows 默认选「浏览器授权」，
也保留「直接读取」。仅展开面板或切换方式不会读取凭证。已有账号可点「重连」，
只有新会话经 SoundCloud `/me` 验证成功后才替换旧会话。

Chrome、Edge 的「浏览器授权」通过浏览器提供的远程调试入口连接原有会话，不安装扩展、Node 或脚本。
每次点「连接」时，KDJ 自动打开所选浏览器的授权页，等待用户开启远程调试；
浏览器若弹出连接许可，需要用户允许。此权限由浏览器控制，覆盖整个当前浏览器会话；
KDJ 自身仅对 SoundCloud 标签页调用 URL 限定的 `Network.getCookies`，筛选 `oauth_token`，
随后断开连接（成功、未登录、读取失败都断开）。不调用获取全部 Cookie 的接口。
授权开关需用户在浏览器中关闭，KDJ 不修改浏览器配置文件。

Chrome、Edge 有官方提供的流程，Chrome 官方要求 144+。macOS Arc 1.168.0 虽然有
相同的 Remote debugging 页面，但本机实测在勾选后立即返回 HTTP 403
`Connection rejected`，没有后续确认弹窗，因此不能视为支持这条 CDP 授权路径。
这里是该版本的实测限制，不推断其他版本的结果。
没有 SoundCloud 标签页时打开一个；多个浏览器账号同时打开 SoundCloud 时不猜账号。
凭证仅在 Rust 后端及固定的 SoundCloud 验证请求中使用，不返回前端或写入日志。

Chrome、Edge 在 macOS 和 Windows 共用 `crates/kdj-providers/src/browser/authorization.rs`
中的连接、标签页选择、Cookie 读取、超时和断开逻辑，平台分支定位浏览器、打开授权页
并核实浏览器进程身份。
浏览器创建的 `DevToolsActivePort` 仅提供本机回环 WebSocket 地址；不会复制 Profile，
不会添加远程调试启动参数，也不访问系统钥匙串或 Windows DPAPI。

关闭调试后 discovery 文件可能仍在。KDJ 在等待期间持续重新读取它，连接尚未就绪或
地址轮换时重试；403 是浏览器拒绝，不自动反复请求许可。浏览器可能共用 9222 端口，
因此在读取标签页和 Cookie 之前，通过 CDP 取得浏览器 PID，再用系统只读接口核对
可执行文件路径，避免用一个浏览器留下的地址读到另一个浏览器的账号。

### macOS Arc 系统授权

Arc 使用自己的 Apple Events 接口，菜单标记「Arc · 系统授权」。macOS 的
KDJ → Arc 自动化权限由系统管理。若 Arc 明确返回 JavaScript 未允许，提示用户在
`View → Developer` 中开启 `Allow JavaScript from Apple Events`。
本机 Arc 1.168.0 在该配置保存为 false 时仍接受读取；原因未确定，不能把开启此开关
写成该版本实测必需条件，也不能推广为所有 Arc 都不需要它。首次未授权流程尚未验收。
无需开启远程调试，不修改浏览器配置、钥匙串或登录数据库；系统自带 `osascript`
执行应用内置脚本，不要求用户安装脚本运行时或浏览器扩展。

连接仅使用当前 Arc 窗口。当前页面是 SoundCloud 时读取它，否则在当前窗口新建
SoundCloud 标签页，继承当前空间的账号。执行时再次检查精确的 HTTPS origin，
只返回 `oauth_token`，不返回整份 Cookie。Arc 对脚本返回的字符串可能再做一次 JSON
编码，后端兼容这层包装；失败只记录固定步骤和错误码，不记录原始输出。
后台经 SoundCloud `/me` 核验成功才保存，失败保留已有会话。

新标签页打开与登录读取分成独立的短 Apple Events：Arc 可能在新页面脚本接口就绪前
报告 `loading=false`，或短暂返回原标签页的信息。后端在同一次连接中自动重试，
最多只新建一个标签页；单次脚本执行等待 3 秒，整体读取等待上限 25 秒。
页面脚本仍在每次读取前检查精确 origin，超时终止子进程并显示可重试错误。

这是 macOS Arc 专用路径，不计为 Windows 或跨平台 CDP 验收。

### 本地验证（2026-10-13）

- Chrome 154：真实 CDP 连接与限定站点 Cookie 请求成功，该 Chrome 未登录 SoundCloud，
  所以不计为真实账号导入成功；测试后已关闭调试。
- Arc 1.168.0：开关关闭 → KDJ 打开授权页并等待 → 勾选 → KDJ 自动继续，收到浏览器 403；
  CDP 路径未读取到登录 Cookie。后来改用 Arc 系统授权，在实际 Tauri 开发版成功读取现有
  会话并经 `/me` 核验，界面显示真实昵称与 `Arc · 浏览器授权`。
  收藏数量曾与浏览器不一致，收藏同步不计为通过。
  修复新页面就绪等待后，从非 SoundCloud 页面点击连接 → 自动新建 SoundCloud 页面
  → 自动读入并验证账号的完整流程也已通过；远程调试关闭时同样成功。
  用户随后反馈 JavaScript 菜单项看起来未勾选；再次点击连接仍经 `/me` 成功核验，
  本地会话文件修改时间也随这次导入更新。随后只读检查发现 Default/Preferences 的
  `browser.allow_javascript_apple_events` 为 false，Arc 主进程也没有相关启用参数。
  因此用户的观察有依据；实际执行与保存配置不一致的具体原因尚未确定，首次未授权的
  弹窗与引导尚未验收。详见 [调查报告](soundcloud-browser-login-report-2026-10-13.md)。
- 自动回归覆盖：旧连接地址等待更新、地址格式限制、403 不循环弹许可、Cookie 域名/有效期
  筛选、只读进程身份核验。Windows VM 的真实账号导入仍需独立验收。

原理与上游实现：
- https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect
- https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/BrowserManager.ts

## 原有直接读取

Mac 保留原有 Profile/钥匙串读取。Windows 直接读取所选浏览器 Profile 时：
先使用当前用户的 DPAPI 密钥，不因配置中存在 App-Bound 密钥就提前拒绝；
按 Cookie 数据库版本解析并验证域名校验值。读取不会强制关闭浏览器。
这不能保证解密应用绑定的会话，也不能保证访问浏览器锁住的数据库，必须实机验收。

以下扩展仅保留为开发原型，当前账号界面不再展示配对码；没有上架商店，也没有
Native Messaging 自动连接。

## 历史扩展原型

1. 在已登录 SoundCloud 的 Edge Profile 中，打开 `edge://extensions`，启用开发人员模式，
   加载解压缩的扩展目录 `extensions/soundcloud`。Chrome 同样可加载。
2. 在 KDJ 开启 SoundCloud，账号连接面板选择「扩展连接」，复制配对码。
3. 打开 KDJ SoundCloud 扩展，粘贴配对码，点击「连接」。
4. 扩展提示成功后，KDJ 通过 `account.changed` 更新账号。

这是源码随附的开发版扩展，尚未上架扩展商店；正式分发应上架并链接商店安装页面。
扩展必须安装在目标浏览器 Profile，浏览器中已有登录即可，无需重新登录。

## 边界

- 仅有 cookies 权限、`https://soundcloud.com/*` 和 `http://127.0.0.1/*` 主机权限。
  没有所有站点、密码、历史记录、脚本注入或远程调试权限。
- 用户点击连接时仅查询 `oauth_token`，过滤根域名、过期、空值和过长 Cookie。
- 配对入口受 KDJ 原有控制面认证保护；独立监听器只绑定 IPv4 回环，随机端口。
  256 bit 随机配对凭证不等于 KDJ 控制凭证，5 分钟失效，校验通过的一次提交即消耗。
  新配对停止旧监听器；同一已接收的验证请求可能正在完成，最长 30 秒。
- 监听器仅处理 `/connect`，拒绝普通网页 Origin，限制请求体大小，响应禁止缓存。
  扩展不跟随重定向，不持久化/下载/记录配对码和 Cookie。
- 后端只向固定的 SoundCloud 接口验证会话，成功后才保存；无效会话不覆盖旧账号。
  扩展不会给网页登录 Cookie 增加 OAuth refresh token，失效后需再次连接。

## 验证

`node --test tests/soundcloud-extension.test.mjs`

`cargo test -p kdj-server soundcloud_bridge::tests --lib`

Windows 真机会话验收需在用户授权安装开发版扩展后进行：已有 Edge 登录 → 配对 →
KDJ 显示账号 → 喜欢/歌单读取；再验证配对码过期、重复提交、错误 Profile。
不应通过关闭 Edge 加密、导出全部 Cookie 或管理员解密来替代验收。

原理参考：
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/applicationboundencryptionenabled
- https://developer.chrome.com/docs/extensions/reference/api/cookies
