# 浏览器登录修复与 Windows 审查（2026-10-14）

## 本次问题

- Zen 的 `about:debugging#/setup` 只是连接其他调试目标的页面，不负责启用 Browser Toolbox。此前用户未手动开启两个开关时，点击登录只打开设置页、等待超时。此前工具箱实测成功不能证明默认用户流程可用。
- SoundCloud 的 Google 账号流程不适合作为内嵌 WebView 登录。Google 明确不支持此 OAuth 使用方式；截图的无响应没有采集到网络错误，不能断言唯一根因。现在在进入 Google 账号页前退出临时 WebView，转到 KDJ 的浏览器授权选择，不伪造 UA、不绕过限制。

## 当前实现

- Gecko 使用所选安装的真实浏览器，创建空的临时 profile，通过 WebDriver BiDi 自动打开站点、等待用户登录、读取目标站点的最小会话。无须开启普通浏览器的调试开关，也不复用/修改用户的已有 profile。需要在新窗口重新登录。
- Windows 的 Chromium 系共用同样的临时窗口生命周期，通过 CDP 自动连接；不要求各衍生浏览器实现 Chrome 特定版本的授权设置页。macOS Chrome/Edge 保留已有的浏览器确认流程，其他 Chromium 衍生版可走临时窗口。
- Windows 已注册的 HTTP/HTTPS 浏览器仍由系统注册表发现；除已知适配器外，按相邻 Gecko (`xul.dll` + `mozglue.dll`) 或 Chromium (`chrome.dll`，含版本子目录) 运行文件判断授权协议。品牌名、语言、Beta/Dev 名称不再阻止独立授权窗口。
- 引擎判断只提供协议尝试能力，不授予未知品牌稳定版的磁盘 profile 路径。直接读取仍使用已有的已知 profile 适配器；不会因为识别出内核而冒读 Chrome/Firefox 的账号。
- 连接前核验系统报告的本地监听端口与本次启动进程、所选安装。读取限定站点和 cookie 名称；错误不回显协议响应/凭证。Windows 端口表应对查询期间增长并核验返回边界。
- 成功、失败、超时、取消均结束临时进程，等待后清理临时 profile。macOS 使用独立进程组，Windows 使用 kill-on-close Job。登录窗口允许十分钟用户操作，服务端上限十一分钟。
- SoundCloud 顶层导航同时拒绝非标准 HTTPS 端口与 URL 用户信息。

## 边界

- 注册表未登记的便携浏览器不会凭空被发现；未实现 BiDi/CDP、禁用自动化或特殊启动器的衍生版可能拒绝连接。不能将“识别内核”表述成“所有浏览器均已实测”。
- 网页仍可要求验证码、二步验证或拒绝自动化浏览器，交由用户/站点处理。
- 本机为 macOS：Windows 注册表和 Job 生命周期尚未真机执行；不发布“Windows 全覆盖通过”的结论。

## 来源

- https://firefox-source-docs.mozilla.org/devtools-user/browser_toolbox/
- https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection
- https://www.w3.org/TR/webdriver-bidi/#command-storage-getCookies
- https://developers.google.com/identity/protocols/oauth2/policies

## 后续：KDJ 确认读取已有 Gecko 登录（取代上述 Gecko 临时窗口）

用户选择了「在 KDJ 点一次确认，读取所选浏览器已有的站点登录状态」，不采用扩展安装或 Browser Toolbox 设置。

- Zen、Firefox、LibreWolf 以及通过内核识别的 Gecko 安装，统一提供 `profile_confirmation`。界面显示实际配置；用户点击「允许并登录」即完成确认并提交明确的配置 ID 和 `profile_read_confirmed`，不再追加二次确认。仅选择浏览器或配置不发送登录请求。
- 后端重新发现安装与配置，缺少确认或配置失效均拒绝读取，不退回临时窗口。只读已有数据库及已提交 WAL/会话恢复文件，普通标签页与容器、隐私、分区会话隔离。凭证在 Rust 内筛选并验证，成功后沿用各站点原有保存流程。
- 这是 KDJ 的读取确认，不冒充浏览器自身权限弹窗；YouTube 使用该普通配置的默认 Google 账号，不能据此声称跟随当前标签页切换的多账号索引。
- macOS 新增基于 XUL/mozglue 或 Chromium framework 运行资源的识别，未知品牌不再仅因 bundle ID 未列入名单而失去连接入口。Windows 继续使用 DLL 特征识别。未知 Gecko 从自身 application.ini 的 Profile/Name/Vendor 和 profiles.ini 定位配置，不借用 Firefox 的固定路径。
- 发现范围仍是系统登记的 HTTP/HTTPS 应用，不进行全盘搜索、不自动启动全部候选、不读取全部候选的凭证。未知名字不是阻碍；没有系统登记的便携版、非标准配置位置、裁剪或禁用连接协议的衍生版不保证自动可用。发现能力不等同于实测连接成功。
- 本机验证：浏览器范围单元测试、普通配置/容器/分区/多配置隔离测试、三个站点的确认/取消 UI 测试、TypeScript 检查；实际 Zen 的现有单一配置通过拒绝未确认请求及 YouTube 会话格式验证测试，测试不启动浏览器、不保存会话、不打印凭证。Windows 留给 CI/真机验证。
