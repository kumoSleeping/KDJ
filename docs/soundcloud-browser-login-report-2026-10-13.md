# SoundCloud 浏览器登录调查报告

日期：2026-10-13。范围：当前 KDJ 工作区、macOS Arc 1.168.0 / Chrome 154 的已有实测，以及 Windows Edge 的官方支持情况。工作区包含未提交实现，不能把当前结果归到已经发布的安装包。

## 结论

Arc 的真实账号导入已经成功：KDJ 通过 Arc 的 macOS 自动化接口，让已登录的 SoundCloud 页面返回指定登录 Cookie，再由后端联网验证账号。此过程不使用磁盘 Cookie 解密，也不使用远程调试。

“JavaScript 菜单看起来未勾选，但仍能成功”的现象有本机证据；具体原因尚未确定。不能把它说成用户看错，也不能据此宣布所有 Arc 都不需要这个开关。

Windows 的 Chrome/Edge 有官方支持的现有会话连接流程，技术可行性高；但当前新版尚未完成 Windows 真实账号导入验收，没有依据给出成功率百分比。Mac Arc 的成功不能算作 Windows 的成功样本。

## 1. 这次成功经过了什么

1. KDJ 调用 macOS 自带的 Apple Events 脚本执行器，访问当前 Arc 窗口。
2. 当前页不是 SoundCloud 时，新建 SoundCloud 标签页；分次等待页面与脚本接口就绪。
3. 在精确的 `https://soundcloud.com` 页面内读取 `document.cookie`，只向 KDJ 返回 `oauth_token`。
4. Rust 后端使用本次取得的登录态请求 SoundCloud `/me`；成功后才保存到 KDJ。

本机此前检查到该 Cookie 的 `HttpOnly` 为 false，所以页面 JavaScript 可以读取。`Secure` 限制 HTTPS 传输，不等同于禁止 JavaScript 读取；真正限制该读取的是 `HttpOnly`。这解释了当前账号为何可用，但不是 SoundCloud 对未来 Cookie 属性的承诺。[MDN Cookie 属性说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#httponly)

最近一次主动重连后，KDJ 会话文件的修改时间从 09:06:51 更新到 09:16:39，界面显示真实账号及“Arc · 浏览器授权”。结合 `import_authorized_browser` → `import_browser_session` 的代码顺序，可以确认此次经过了新读取与 `/me` 核验，不能解释为仅显示旧昵称。

代码位置：`crates/kdj-providers/src/browser/arc_automation.rs`、`arc_soundcloud.applescript`、`arc_soundcloud.js`，以及 `crates/kdj-providers/src/soundcloud/provider.rs`。

## 2. 为什么没勾选也成功

本机只读检查得到：

| 检查项 | 结果 | 能证明什么 |
| --- | --- | --- |
| Arc `Default/Preferences` 的 `browser.allow_javascript_apple_events` | false | 此配置文件里保存的是关闭状态 |
| Arc `Local State` 的远程调试开关 | false | 保存的远程调试状态为关闭 |
| Arc 主进程启动参数 | 无启用 AppleScript JavaScript 或远程调试的参数 | 未通过这两类命令行参数开启 |
| KDJ 本次主动连接 | 账号核验成功 | 当前 Arc 实际接受了脚本读取 |
| Arc 随应用附带的 `Arc.sdef` | `execute javascript` 映射到 `AppleScriptTabWrapper.executeJavascript:` | Arc 暴露了自己的脚本接口 |

Chromium 上游的脚本实现会先检查 `kAllowJavascriptAppleEvents`，未允许时拒绝执行；Arc 的脚本字典却指向自己的包装类。**可能解释**是 Arc 的执行路径使用了不同的权限判断；另一种可能是运行中的状态、实际目标空间与已落盘配置不一致。仅凭类名和磁盘配置，不能判定哪一种成立。[Chromium 执行入口](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/cocoa/applescript/tab_applescript.mm)、[Chromium 权限检查](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/cocoa/applescript/apple_event_util.mm)

目前未找到 Arc 官方对这个确切现象的解释。本轮没有重启 Arc、重置系统权限或改写配置来强行验证，因而没有“干净首次授权”的结论。macOS 的应用自动化权限、浏览器的 JavaScript 开关、远程调试开关是不同层次，不能混为一个“开发者权限”。

产品应以真实执行结果决定下一步：成功就继续；明确收到权限拒绝才给对应引导。不应因为菜单显示不确定而反复要求用户切换开关。自动展开菜单、自动勾选、自动确认的首次流程尚未实现和验收。

## 3. Windows 为什么有希望，证据到哪里

旧方案由 KDJ 读取磁盘 Cookie 并尝试解密。Edge 默认会在条件允许时把本地数据加密密钥绑定到 Edge，普通外部进程不能假定拥有同一用户权限就能解密。[Microsoft 应用绑定加密策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/applicationboundencryptionenabled)

新方案让已登录的浏览器接受用户授权，再通过浏览器自己的调试协议返回目标站点 Cookie。KDJ 因此不需要解密磁盘数据。Microsoft 明确提供连接已运行 Edge、保留登录会话的流程，包含 `edge://inspect` 的 Remote debugging 开关；Chrome 对同类 auto-connect 流程明确要求 144+，并说明连接许可弹窗。Edge 文档没有给出同样的最低版本数字，不能直接套用 Chrome 的门槛。[Edge 官方流程](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server#auto-connect-to-a-running-edge-instance)、[Chrome 官方流程](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)

KDJ 使用 Rust 实现连接，不要求用户安装文档示例中的 MCP、Node、扩展或油猴。Chrome/Edge 在 Mac 与 Windows 共用协议代码，平台部分负责寻找浏览器和核实进程。浏览器授予的调试权限较广，KDJ 当前只查询 SoundCloud URL 对应的 Cookie；完成后断开连接，浏览器开关不会随断开自动关闭。

这与给默认浏览器添加启动参数不同：Chrome 136 起限制默认数据目录使用 `--remote-debugging-port` / `--remote-debugging-pipe`。不能把重启真实 Profile 并加参数当作可靠的一键方案。[Chrome 官方变更说明](https://developer.chrome.com/blog/remote-debugging-port)

| 路径 | 已有证据 | 判断 |
| --- | --- | --- |
| Mac Arc 系统自动化 | 真实账号、新建页面、重连成功 | 本机可用；首次权限流程未验收 |
| Mac Chrome 授权连接 | 协议连接和限定站点 Cookie 查询成功；该 Chrome 未登录 SoundCloud | 协议通过，真实账号导入未通过验收 |
| Windows Edge / Chrome 授权连接 | 官方支持，KDJ 共用协议实现 | 可行性高；当前版本完整成功样本尚无，成功率不可统计 |
| Windows Arc | 当前授权实现未支持 | 不纳入承诺 |
| 无任何确认的一键连接 | 当前代码只打开授权页并等待 | 尚未实现，不能用其他成功结果代替 |

Windows 的主要待验条件是浏览器版本和授权入口、正确用户目录、企业策略、握手许可、账号有效性，以及应用自身能否启动。企业策略可以禁止远程调试，即使页面路径正确也未必能连接。[Edge 远程调试策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/remotedebuggingallowed)

## 4. 已实际遇到的错误

| 错误或现象 | 当前结论与状态 |
| --- | --- |
| Windows 测试包缺少 `MSVCP140.dll` | de35bc9 安装包在账号测试前就启动失败。工作区已有静态 CRT 配置与产物依赖检查，仍须无 VC++ 运行库的 VM 实测新包。 |
| Windows 直接读取提示应用绑定加密 | 与系统机制相符；旧实现也可能仅凭存在相关密钥就提前拒绝，不能证明那一次具体 Cookie 必然无法解密。 |
| Mac 直接读取报 `decrypt_encrypted_value failed` | 属于旧的钥匙串/数据库路径；新自动化成功不代表旧路径的根因已修复。 |
| Arc CDP 返回 HTTP 403 `Connection rejected`，无后续确认框 | 本机 1.168.0 实测失败；内部拒绝原因未知。当前 Mac Arc 改走系统自动化。 |
| Arc 脚本 `-1700`，返回结果解析失败 | 分别修正标签页引用和 Arc 双层 JSON 字符串处理。 |
| 页面打开后长期转圈，`-1712` 超时 | 新标签页显示已加载，不代表脚本接口就绪。已拆分打开与读取，短次重试，整体读取上限 25 秒；新建页面流程复测成功。 |
| 我此前说菜单已弹出，用户实际没看到 | 操作工具读取到后台菜单不足以证明前台已展示。该说法已纠正，不算自动引导测试成功。 |
| Arc 曾提示无法加载保存的 Profile | 用户截图证实发生过；现有记录不足以精准归因，不能写成已经查明并彻底解决。 |
| KDJ 收藏数曾为 0，浏览器为 184 | 尚未定位；此次通过的是账号导入，不代表收藏、歌单和下载均已通过。 |

静态 CRT 解决 VC++ 运行库依赖，不等于 Tauri 完全没有系统运行前提；Windows 的 WebView2 需求另行存在，安装包可以负责检测和提供。[Tauri Windows 安装说明](https://v2.tauri.app/distribute/windows-installer/)

## 5. 下一次 Windows 验收应记录什么

先确认新版在未另装 VC++ 运行库的 VM 正常启动，再测试现有 Edge 登录：打开授权页 → 用户允许 → 连接正确浏览器 → 获取指定站点会话 → `/me` 核验 → 保存 → 收藏/歌单读取 → 断开。

分别覆盖首次开启、拒绝后重试、关闭再开启、未登录、错误账号、多 Profile、浏览器未运行，以及重复连接。保存每次的浏览器版本、阶段、耗时和错误分类；日志不得含 Cookie、请求头原文、令牌或任意页面正文。

只有这些用例在 Windows 跑过后，才能报告该环境的通过数/测试数；推广到普通用户的成功率，还需要更多浏览器版本和机器样本。
