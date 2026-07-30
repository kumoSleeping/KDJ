# 08 · 自动发行、一键更新、安装包签名

这份讲三件互相咬合的事：**版本号一改就自动发布**、**桌面能一键更新**、
**安卓包能装进手机**。三件事共用两把钥匙，钥匙丢了都补不回来，所以先讲钥匙。

---

## 1. 两把钥匙（丢了没有备份）

| 钥匙 | 干什么用 | 存在哪 | 丢了会怎样 |
| --- | --- | --- | --- |
| **minisign 私钥** | 给桌面更新包签名，装机端用内嵌公钥验 | `~/.tauri/kdj.key` | 已装的旧版**永远收不到新更新**（公钥编译进了旧包，换钥匙 = 换身份）。只能让用户手动重装 |
| **Android keystore** | 给 APK 签名 | `~/.android/kdj-release.jks`，口令在同目录 `.pass` | 已装用户**无法覆盖升级**，必须先卸载再装（Android 认签名不认包名） |

两把钥匙都**没有进版本库**，也没有第二份拷贝。请立刻自己备份这三个文件：

```
~/.tauri/kdj.key            minisign 私钥（无口令）
~/.android/kdj-release.jks  Android keystore（4096 位 RSA，有效期到 2056）
~/.android/kdj-release.pass keystore 口令
```

minisign 的**公钥**是可以公开的，它就写在 `src-tauri/tauri.conf.json` 的
`plugins.updater.pubkey` 里。keystore 的证书指纹（SHA256）：
`BD:0C:0F:BE:BB:1F:DE:10:AC:91:04:58:54:2E:46:C6:20:4F:AC:3F:3B:4E:3F:27:B0:25:5D:4E:64:80:EA:72`

### 要往 GitHub 加的 secrets

Settings → Secrets and variables → Actions → New repository secret：

| 名字 | 值怎么来 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `cat ~/.tauri/kdj.key` 的全文 |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i ~/.android/kdj-release.jks \| pbcopy` |
| `ANDROID_KEYSTORE_PASSWORD` | `cat ~/.android/kdj-release.pass` |
| `ANDROID_KEY_ALIAS` | `kdj` |

仓库提供了不回显私钥的一次性配置脚本。先做好加密离线备份，再运行：

```bash
./scripts/configure-release-secrets.sh
```

脚本会先验证：内嵌 updater 公钥与本机私钥配对、Android keystore 中存在
`kdj` alias；确认备份后，四个值都通过 stdin 写入 `gh secret set`，不会
出现在命令行参数或日志里。

**分支构建**没配密钥仍可继续，只产普通安装包用于编译验证；**正式 tag** 缺
任意一个 Secret 会直接失败。`release.yml` 在创建 tag/空 Release **之前**也有
同样的门禁，避免再次出现“Actions 全绿、Release 却没有任何可更新签名包”。

---

## 2. 自动发行：改版本号 = 发版

发版入口是 `src-tauri/tauri.conf.json` 的 `.version`，但三处版本必须一致：
Tauri 安装包读它，前端/npm 读 `package.json`，内置 health 和旧版手动检查接口
读 Cargo workspace 版本。不要手改三次，统一运行：

```
node scripts/set-version.mjs 0.2.2 → 提交 → 推 main → 完事
```

`release.yml` 会再次校验三处一致，不一致就拒绝发行。

`release.yml` 干的事：

1. 读出 `.version`，形状不对（不是 `x.y.z`）就直接 fail——宁可不发也别打出 `vnull`
2. 问**远端**有没有 `v{version}` 这个 tag（不是问本地：checkout 默认浅克隆不带 tags）
3. 没有 → 打 tag、`gh release create --generate-notes --latest=false`
   （先不抢 `releases/latest`，避免空壳/旧清单把更新通道静默冻住）
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

- **桌面检查**直接调用 `tauri-plugin-updater::check()`。只有 `latest.json` 中
  当前 OS、CPU 架构和原安装格式对应的签名包确实存在，才显示可更新；不会在
  Release 已创建而三平台产物仍上传中的窗口误报。
- **安卓/浏览器检查**走后端 `/api/update/check`。安卓会从 Release assets 中
  精确选择不含 `unsigned` 的 APK，签名 APK 还没上传完时明确提示稍后重试；
  浏览器则打开 Release 页。
- **安装**按壳的能力自动分流，不给用户出选择题：
  - 桌面 → 下载 + 显示百分比 + minisign 校验 + 原地替换 + 自重启
  - 安卓 → 系统浏览器直接下载签名 APK，再由 Android 系统安装器确认覆盖
  - 浏览器 → 开 Release 页

正式应用身份固定为 `com.kdj.app`。从第一版正式签名 APK 开始，identifier 和
Android keystore 任意一个都不能再换，否则 Android 会把新版当成另一个应用。

### `latest.json` 是怎么来的

updater 启动时拉 `releases/latest/download/latest.json`，按 `os-arch` 取键。
这个文件由 `rust-build.yml` 的 `latest-json` job 在 desktop matrix **结束之后**拼
（`if: always()`，不要求三平台全绿）：

1. 下载已有 artifact → 找各平台更新包和 `.sig`
2. **有哪个平台就写哪个**；缺的平台只 warning，不堵死其它平台
3. 至少有一个平台成功 → `gh release upload --clobber`，再
   `gh release edit --latest` 提升本版
4. 若零平台成功 → 不写清单、不提升 Latest，上一版继续当更新通道

清单使用 updater 2.10+ 的安装格式精确键，并保留无后缀兼容键：

- macOS：`darwin-{aarch64,x86_64}-app`
- Windows：`windows-x86_64-{nsis,msi}`
- Linux：`linux-x86_64-{appimage,deb,rpm}`

macOS universal 包一份喂 arm64/x64 两个架构；Windows 和 Linux 则保证用户从
什么格式安装，就继续用同格式更新，避免 MSI→NSIS 或 DEB→AppImage 串包。

正式 tag 上 `cargo test` 失败不再阻断打包（main 分支仍硬失败），避免 CI
时序类单测把更新通道卡死。某个平台的 `.sig` 缺失会跳过该平台并告警。

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
# 1. 三处版本号 + Cargo.lock 一起更新
node scripts/set-version.mjs 0.2.2

# 2. 提交推送，剩下的全自动
git commit -am "release: v0.2.2" && git push origin main
```

盯 Actions 页：`release` 绿了 → tag 和 Release 就位 → `rust-build` /
`rust-android` 跑完把产物传进同一个 Release → `latest-json` 收尾。
桌面用户下次点「检查更新」就能一键升上去。
