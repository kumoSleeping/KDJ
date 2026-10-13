# 桌面浏览器发现

Rust 的 `browser::discovery` 先枚举系统注册的网页处理应用，再匹配读取适配器。枚举不启动应用，不打开 Cookie 数据库，不触发钥匙串。

- macOS：查询 HTTP 和 HTTPS 的 `NSWorkspace.URLsForApplicationsToOpenURL`，取得实际应用位置和 Bundle ID。macOS 10.15–11 回退到 Launch Services 的 `LSCopyApplicationURLsForURL`。
- Windows：读取 HKCU/HKLM 的 `RegisteredApplications`（HTTP/HTTPS 的 ProgID）与 `Clients/StartMenuInternet`，覆盖两个注册表视图。只解析启动命令的可执行文件和路径环境变量，不执行注册表命令或其参数。
- 无效路径过滤，规范路径去重。不同位置的同名安装保留为独立选项。安装项 ID 是路径摘要；路径不返回前端。

`BrowserCatalog.installed_browsers` 是发现结果；`authorization_browsers` 是其中匹配现有授权适配器的安装项；`browsers` 继续提供直接读取适配器找到的 Profile（卸载应用后留下的 Profile 也保留）。能力字段只表示有适配代码，不代表连接或网站登录验证成功。授权请求重新枚举安装项，并核对连接端口的浏览器进程归属。

SoundCloud 授权菜单显示未适配的安装项，但禁用连接；重新检测在没有可用读取选项时仍可操作。未知应用、未适配的开发通道不会自动继承稳定版的授权能力。

安装目录和 Profile 目录是两回事。系统注册发现解决自定义**安装位置**；直接读取与授权端点仍使用各适配器的 Profile 定位规则。未注册的便携版、自定义用户数据目录尚不保证覆盖，也没有新增手动目录选择。系统登记为网页处理程序的非传统浏览器也可能出现在发现结果中，但不会因此获得读取能力。

验证：`cargo test -p kdj-providers browser:: --lib`；macOS 可显式运行只读本机检查 `cargo test -p kdj-providers system_discovery_smoke --lib -- --ignored --nocapture`。Windows/macOS CI 执行浏览器回归；需要真实授权的测试保持忽略。界面回归：`node --conditions=import scripts/test-workshop-ui.mjs youtube-login-ui`。
