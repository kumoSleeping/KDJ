# Zen Browser Toolbox 连接实测

2026-10-14，macOS，用户明确允许一次不读取凭证的连接测试。

## 结果

- 对正在运行的 Zen 开启开发者工具里的 `Enable browser chrome and add-on debugging toolboxes` 和 `Enable remote debugging`，打开 Browser Toolbox。
- Zen 主进程在本机回环地址开启临时 TCP 监听，并对工具箱自身和外部探针的连接分别显示 Incoming Connection 确认。
- Rust 探针核验监听进程属于选定的 Zen 安装后，接收 Gecko RDP 握手，发送一次 `root.listTabs`，得到 32 个标签描述符；只输出数量，不输出标题、URL 或凭证。
- 主浏览器 PID 在整个测试前后保持不变。没有重启浏览器、安装扩展、读取 Cookie 或执行页面脚本。
- 测试后两个开关均恢复为原来的关闭状态。关闭本次工具箱子进程和测试标签页后，确认主浏览器不再有 TCP 监听；原 Zen 主进程继续运行。

## 验证范围

`cargo test -p kdj-providers browser::gecko_rdp_probe --lib` 的两个模拟协议测试通过，覆盖分片消息、无关事件和超大消息拒绝。

`KDJ_TEST_RDP_BROWSER=zen KDJ_TEST_RDP_PORT=<本次端口> cargo test -p kdj-providers live_selected_browser_toolbox --lib -- --ignored --nocapture` 实机通过。端口是动态的，不能硬编码；该测试必须先在浏览器里明确开启工具箱，并确认连接。

这证明 **Gecko Browser Toolbox 能连接已运行的 Zen，无须重启或扩展**，不等同于 KDJ 的完整授权登录已经实现。当前探针仅在测试构建中启用，没有将 Zen 标为生产授权可用。后续还需完成可靠的端口发现、目标站点与账号隔离、凭证最小化读取、拒绝/取消/断开处理以及平台适配，并另行验证真实账号登录。

此前“Firefox 系只能安装扩展或重启才能连接”的判断过于绝对：启动参数限制针对 WebDriver BiDi Remote Agent；Browser Toolbox 的 Gecko RDP 是另一条已实测存在的路径。

## Integration and credential-read verification

The shared Gecko authorization adapter is now wired to the existing browser authorization API
and catalog for Zen, Firefox, and LibreWolf on macOS/Windows. The direct-read option stays
separate and is consistently labelled `直接读取` on macOS as well.

A user-approved macOS Zen test ran the production adapter with `--jsdebugger` against the
already-running browser. The browser showed its Incoming Connection permission dialog. After
approval, the test obtained a YouTube session and selected-page account metadata through RDP;
no credentials were printed or persisted by the test. This verifies acquisition, not an online
YouTube account validation or download. Windows shares the protocol but has not been exercised
locally; its listener discovery uses GetExtendedTcpTable and process-image verification.

Both debugging switches were observed off before the test, enabled with explicit permission,
then restored off. The toolbox process launched for the test was stopped and the browser's
loopback listener was confirmed gone. The temporary setup tab was closed.

The implementation validates the listener's process identity, requires loopback and connection
confirmation preferences, scopes reads to the selected site's cookie names and one non-private
container, and disconnects on completion/error/cancellation. It opens a selected-site page if
needed. Multiple containers with that site open are rejected rather than guessed. Runtime
preferences are never modified by KDJ. First-use setup remains an explicit browser action,
documented in the authorization panel.

Validation: provider authorization tests (12 passed, 2 manual tests ignored), Gecko script
scope tests (2 passed), browser-login UI dispatch/cancellation test, TypeScript check, and
`live_gecko_authorization` (1 passed with explicit user permission).

Safari's open error now distinguishes OS-denied access from a missing cookie file and other
I/O errors. A file-open-only local diagnostic returned EPERM (Operation not permitted), without
reading contents or modifying macOS permissions. The earlier unconditional English advice was
misleading and has been removed.

## First-use follow-up and complete account import

A real KDJ authorization attempt with both browser switches disabled reproduced the reported
ordinary/search window: bare `--jsdebugger` cannot enable Gecko's prerequisite permissions.
The launch now supplies an explicit `about:debugging#/setup` destination instead of allowing a
blank start window, and gives initial setup up to 60 seconds. Zen did not reliably open content
developer tools from the remote `--devtools` argument; do not claim that this flag configures
permissions automatically.

With user permission the two switches were enabled again. The first UI attempt timed out during
initial toolbox startup; a subsequent request through the running development app's real YouTube
authorization endpoint succeeded, returned a valid named account with `Zen · 浏览器授权`, and
published/saved it through the normal provider flow. This supersedes the earlier acquisition-only
verification. Both switches were then verified off again and the test toolbox and setup tab were
closed. No cookie values were included in test output.

At the user's request, the lengthy setup disclosure was removed entirely; the authorization row
now keeps the browser selector, login/cancel controls, and a short `等待浏览器授权` status. The
browser's initial debugging permission remains a prerequisite, not a permission KDJ silently grants
itself. Automatic connection, site-scoped acquisition, validation and saving work once it is enabled.
