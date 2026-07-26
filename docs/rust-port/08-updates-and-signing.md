# 08 · 自动发行、一键更新、安装包签名

这份讲三件互相咬合的事：**版本号一改就自动发布**、**桌面能一键更新**、
**安卓包能装进手机**。三件事共用两把钥匙，钥匙丢了都补不回来，所以先讲钥匙。

---

## 1. 两把钥匙（丢了没有备份）

| 钥匙 | 干什么用 | 存在哪 | 丢了会怎样 |
| --- | --- | --- | --- |
| **minisign 私钥** | 给桌面更新包签名，装机端用内嵌公钥验 | `~/.tauri/kumodeck.key` | 已装的旧版**永远收不到新更新**（公钥编译进了旧包，换钥匙 = 换身份）。只能让用户手动重装 |
| **Android keystore** | 给 APK 签名 | `~/.android/kumodeck-release.jks`，口令在同目录 `.pass` | 已装用户**无法覆盖升级**，必须先卸载再装（Android 认签名不认包名） |

两把钥匙都**没有进版本库**，也没有第二份拷贝。请立刻自己备份这三个文件：

```
~/.tauri/kumodeck.key            minisign 私钥（无口令）
~/.android/kumodeck-release.jks  Android keystore（4096 位 RSA，有效期到 2056）
~/.android/kumodeck-release.pass keystore 口令
```

minisign 的**公钥**是可以公开的，它就写在 `src-tauri/tauri.conf.json` 的
`plugins.updater.pubkey` 里。keystore 的证书指纹（SHA256）：
`BD:0C:0F:BE:BB:1F:DE:10:AC:91:04:58:54:2E:46:C6:20:4F:AC:3F:3B:4E:3F:27:B0:25:5D:4E:64:80:EA:72`

### 要往 GitHub 加的 secrets

Settings → Secrets and variables → Actions → New repository secret：

| 名字 | 值怎么来 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `cat ~/.tauri/kumodeck.key` 的全文 |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i ~/.android/kumodeck-release.jks \| pbcopy` |
| `ANDROID_KEYSTORE_PASSWORD` | `cat ~/.android/kumodeck-release.pass` |
| `ANDROID_KEY_ALIAS` | `kumodeck` |

**没配也不会让 CI 红**：桌面那边会摘掉 `createUpdaterArtifacts` 出普通安装包
（代价是这一版之后的一键更新装不上它），安卓那边跳过签名出未签名包。
宁可少个功能也不要整条流水线倒下——但那样的话发出去的包用户装不了，
所以正式发版前这四个 secret 必须配齐。

---

## 2. 自动发行：改版本号 = 发版

**唯一权威是 `src-tauri/tauri.conf.json` 的 `.version`。** 它才是 Tauri 打包时
真正盖到产物上的那个数（DMG 文件名、APK 的 versionName 都从这来）；
`package.json` / `Cargo.toml` 里的只是影子。

```
改 tauri.conf.json 的 version → 提交 → 推 main → 完事
```

`release.yml` 干的事：

1. 读出 `.version`，形状不对（不是 `x.y.z`）就直接 fail——宁可不发也别打出 `vnull`
2. 问**远端**有没有 `v{version}` 这个 tag（不是问本地：checkout 默认浅克隆不带 tags）
3. 没有 → 打 tag、`gh release create --generate-notes`
4. `gh workflow run` 把 `rust-build.yml` 和 `rust-android.yml` **dispatch 到 tag ref**

### 第 4 步为什么不能省

**GITHUB_TOKEN 推的 tag 不会触发任何 `on: tags` 工作流。** 这是 GitHub 防
工作流无限递归的硬规则，没有开关可以关掉。表现是：tag 打出来了、Release
建好了、然后什么都不发生，而且**没有任何报错**——日志里一片绿。
所以必须显式 dispatch。手动 `git push origin v0.2.2` 那条老路仍然通
（人推的 tag 会正常触发），两条路殊途同归。

---

## 3. 桌面一键更新

前端「账号管理」面板里的「软件更新」一行：

- **检查**走后端 `/api/update/check`（问 GitHub 的 `releases/latest`）。
  不让前端直接 fetch GitHub 的原因：桌面 CSP、安卓 WebView 证书链、
  浏览器 CORS 三边规则各不相同，放后端就只有一条路要维护。
- **安装**按壳的能力自动分流，不给用户出选择题：
  - 桌面 → `tauri-plugin-updater` 下载 + minisign 校验 + 原地替换 + 自重启
  - 安卓 / 浏览器 → 开 Release 页自己下。安卓没法自替换（必须走系统安装器），
    这是平台限制不是偷懒。

### `latest.json` 是怎么来的

updater 启动时拉 `releases/latest/download/latest.json`，按 `os-arch` 取键。
这个文件由 `rust-build.yml` 的 `latest-json` job 在**三平台都传完之后**拼：
下载全部 artifact → 找 `*.app.tar.gz` / `*-setup.exe` / `*.AppImage` 和它们的
`.sig` → 拼 JSON → `gh release upload --clobber`。

macOS 的 universal 包一份喂两个键（`darwin-aarch64` 和 `darwin-x86_64`），
因为 updater 按精确的 os-arch 取键，只写一个的话另一半架构收不到更新。

没有 `.sig` 的平台会被跳过并 `::warning::`——那说明私钥 secret 没配。

---

## 4. 安卓签名

`gen/android/` 是生成物、**不进版本库**，每次 `tauri android init` 都会把手改冲掉。
所以凡是"改了 gen/android 才生效"的东西，都做成 init 之后的补丁：
**`scripts/android-postinit.sh`**，本地和 CI 跑同一份。

它做三件事：

1. **明文放行**：把 release 的 `usesCleartextTraffic` 从 `false` 翻成 `true`。
   这个 app 的前端在 WebView 里对 `127.0.0.1` 上的进程内 axum 发明文请求，
   Android 对 targetSdk 28+ 默认禁明文，不开的话 release 包装上真机就是**白屏**，
   而 debug 包复现不出来（模板里 debug 本来就是 true）。
2. **注入签名**：口令写进 `keystore.properties`（`chmod 600`）而不是直接塞进
   `build.gradle.kts`——gradle 脚本会进构建日志和各种缓存，properties 不会。
   `signingConfigs` 块必须放在 `buildTypes` **之前**：Kotlin DSL 顺序求值，
   放后面会报 `SigningConfig with name 'release' not found`。
3. **图标同步**：把 `src-tauri/icons/android/` 盖过模板默认图标，并把自适应
   图标的背景层从模板的 `#fff` 换成应用底色 `#111113`——白底配深色前景，
   在圆形遮罩里会露一圈白边。

### 踩过的坑

- **`$KEYSTORE）` 会炸**：bash 在 UTF-8 环境下会把紧跟的全角括号字节当成变量名的
  一部分，报 `KEYSTORE）: unbound variable`，看着完全像是"变量没设"。
  脚本里变量名一律写 `${VAR}` 全大括号。
- **`plugins` 段一加，`generate_context!` 就要 `serde_json`**：往
  `tauri.conf.json` 加 updater 配置之后，`cargo build` 报
  `could not find serde_json in the list of imported crates`——
  报错位置在 `generate_context!()` 那一行，和"加了个配置"看不出任何关系。
  解法是给 `src-tauri` 显式依赖 `serde_json`。
- 签名之后产物名从 `app-universal-release-unsigned.apk` 变成
  `app-universal-release.apk`，CI 里上传/发布的通配符要两种都收。

### 验证签名

```bash
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs -v <apk>
```
要看到 `Verified using v2 scheme (APK Signature Scheme v2): true`。
只有 v1 的话 Android 7+ 装不了。

---

## 5. 发一版的完整流程

```bash
# 1. 改版本号（唯一权威）
vim src-tauri/tauri.conf.json      # "version": "0.2.2"

# 2. 影子版本号跟一下（不改也能发，只是 npm/cargo 那边显示旧值）
vim package.json Cargo.toml

# 3. 提交推送，剩下的全自动
git commit -am "release: v0.2.2" && git push origin main
```

盯 Actions 页：`release` 绿了 → tag 和 Release 就位 → `rust-build` /
`rust-android` 跑完把产物传进同一个 Release → `latest-json` 收尾。
桌面用户下次点「检查更新」就能一键升上去。
