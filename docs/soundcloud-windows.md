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

Mac 保留原有 Profile/钥匙串读取。Windows 优先尝试读取所选浏览器 Profile：
先使用当前用户的 DPAPI 密钥，不因配置中存在 App-Bound 密钥就提前拒绝；
按 Cookie 数据库版本解析并验证域名校验值。读取不会强制关闭浏览器。
这不能保证解密应用绑定的会话，也不能保证访问浏览器锁住的数据库，必须实机验收。

扩展是后备方案。当前实现仍是开发版配对码流程；面向普通用户的商店安装入口和
Native Messaging 自动连接尚未实现，也尚未上架。正式体验目标是 KDJ 打开商店页，
用户确认安装后自动接回 KDJ，不要求解压、开发者模式或复制配对码。

## 使用

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
