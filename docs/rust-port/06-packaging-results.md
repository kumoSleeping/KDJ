# 06 · 打包实测：macOS 产物体积 + 安卓 APK

**这一份全是实测数字，没有一个是估的。** 命令、字节数、错误原文都在下面，
想复现照抄第 5 节。

三句话版本：

- macOS DMG **5,911,874 B**，v0.1.0 是 155 MB —— **小了 26 倍（−96.2%）**；
- 安卓 aarch64 release APK **18,025,001 B** 真的编出来了，但是 **unsigned**，
  而且 **`usesCleartextTraffic=false` 会让它装上去白屏**（§4.7），装机前必须先改；
- 还能再省 **597,424 B**：`image` crate 开着 default features，把 AVIF 编码器
  和 OpenEXR 一起编进来了，而代码里一次都没用（§3，已量准，改一行）。

---

## 1. 结论先放：小了 26 倍

在 M4 MacBook（arm64、macOS 15、Xcode 15.2、rustc 1.90.0）上跑
`npx tauri build`，一次通过，没有改任何配置。

| 产物 | v0.1.0（Electron + PyInstaller） | v0.2.0（Rust + Tauri） | 变化 |
| --- | --- | --- | --- |
| macOS arm64 DMG | 155 MB | **5,911,874 B ≈ 5.64 MiB** | **−96.2%**，小 26.2 倍 |
| macOS `.app` 目录 | — | **10,096 KiB ≈ 9.9 MiB** | — |
| 主可执行文件 | — | **9,980,144 B ≈ 9.52 MiB** | — |

`.app` 里就两样东西，没有第三样：

```
KDJ.app/Contents/
├── Info.plist                4.0 KiB
├── MacOS/kdj-app        9,980,144 B   ← 前端产物也在里面（见下）
└── Resources/icon.icns       348,956 B
```

**没有 `node_modules`、没有 `.venv`、没有 Electron Framework、没有 sidecar 子进程。**
对照 v0.1.0 的体积来源（`00-architecture.md` §1，本机现在还能量到）：
`node_modules/electron/dist` 242 MB、`sidecar/.venv` 163 MB。这两坨整个消失了。

前端不是外挂目录而是**编进二进制**的（`custom-protocol` feature 让
`generate_context!` 把 `dist-tauri/` 嵌进去）：

| 前端产物 | 字节 |
| --- | --- |
| `dist-tauri/assets/index-*.js` | 307,956 |
| `dist-tauri/assets/index-*.css` | 25,489 |
| `dist-tauri/index.html` | 419 |

也就是 5792 行 React 的全部编译产物只占 334 KB，占最终二进制的 3.3%。
**保留 React 不换 Svelte 这个决定，事后看在体积上完全不吃亏**
（`HANDOFF.md` §5 当时的判断是"差异只有几十 KB"，实测确认）。

### Tauri 壳本身只贵 1.7 MB

同一份 profile 下，纯 axum server 的独立二进制是 8,249,584 B。
Tauri 壳（wry + tao + 两个插件 + 嵌进去的 334 KB 前端）把它推到 9,980,144 B，
**净增 1,730,560 B ≈ 1.65 MiB**。

macOS 的 WebView 是系统的 WKWebView，不随包携带——这是和 Electron 拉开 26 倍的
根本原因，不是"Rust 比 JS 小"。

### DMG 压缩比

`.app` 10,338,304 B → DMG 5,911,874 B，压到 57%。Tauri 默认 UDBZ（bzip2）。

---

## 2. `[profile.release]` 确认真的生效了

根 `Cargo.toml` 的 profile 不是摆设。首轮体积验证时从构建进程抓到的参数是：

```
-C opt-level=z -C panic=abort -C lto -C codegen-units=1 -C strip=symbols
```

这组参数是本页安装包数字对应的历史基线。波形/解码实测证明 `z` 会让运行期 DSP 慢一倍以上后，当前 release 已改为 `-C opt-level=2`；LTO、单 codegen unit、abort 和 strip 不变。包体数字若要作为当前门禁基线，必须重新完整构建测量，不能直接沿用本页旧值。

`src-tauri` 是 workspace 成员，所以根 profile 自动覆盖到壳；
不需要在 `src-tauri/Cargo.toml` 里再写一份（写了反而会因为
"非 workspace root 的 profile 被忽略"而给一条 warning）。

二进制侧的旁证：`nm` 出来只剩 undefined 的系统符号（`U _CFDataGetBytePtr` 这类），
本地符号全没了 → `strip` 确实执行了。

代价：`lto = true` + `codegen-units = 1` 让最后一步 LTO 链接变成单线程，
在这台机器上冷编一次安卓 target 花了 **2 小时以上**（见 §4）。
**所以 CI 的 `cargo test` 千万别加 `--release`**（`05-ci-and-packaging.md` 已经写了，
这次实测坐实了这条）。

---

## 3. 还能再压：`image` 的默认 features 是唯一一块明显的肥肉

用 `cargo tree -p kdj-app -e normal -i <crate>` 查了 normal（非 build）依赖图，
`image v0.25.10` 是 `kdj-providers` 的**运行时**依赖，而且开着 default features：

```
rav1e v0.8.1
└── ravif v0.13.0
    └── image v0.25.10
        ├── kdj-providers   ← 这里
        └── qrcode v0.14.1 → kdj-providers
```

安卓那次冷编的日志里能直接看到这条链在实打实地编：
`y4m`、`av1-grain`、`loop9`、`ravif`、`exr`、`rav1e`、`zune-jpeg`、`png`、`tiff`……

而代码里对 `image` 的**全部**用法只有三种（`grep -rn "image::" crates/`）：

| 用法 | 位置 |
| --- | --- |
| `image::load_from_memory` 解封面 / 解 B 站截图 | `providers/src/ffmpeg.rs:211`、`provider.rs:235` |
| `PngEncoder` 编二维码和缩略图 | `provider.rs:201`、`provider.rs:249` |
| `ImageFormat::Jpeg` 写测试用图 | `ffmpeg.rs:381`（测试代码） |

**一个 AVIF 编码器、一个 OpenEXR 读写器、一个 TIFF 编解码器，一次都没用到。**

建议改法：

```toml
# crates/kdj-providers/Cargo.toml
image = { version = "0.25", default-features = false, features = ["png", "jpeg", "webp", "gif", "bmp"] }
```

`webp`/`gif`/`bmp` 要留着：`load_from_memory` 是靠嗅探魔数选解码器的，
四家平台的封面 CDN 现在就在发 webp，砍掉会变成"某些歌没封面"这种
**只在真机上才会暴露**的缺陷——正是 `HANDOFF.md` §2 说的那类问题。

### 实测收益：−597,424 B（−7.2%）

在 `/tmp` 的隔离副本上编了两遍 `kdj-server` 独立二进制（同一 profile、
同一 target dir、只改这一行）：

| 变体 | 字节 |
| --- | --- |
| 基线（`image = "0.25"`，default features） | 8,249,584 |
| 裁剪后（只留 png/jpeg/webp/gif/bmp） | **7,652,160** |
| 差 | **−597,424 B（−583 KiB，−7.2%）** |

基线那一遍编出来的字节数和主工作树的 `target/release/kdj-server`
**完全一致**（都是 8,249,584），说明隔离副本是忠实复现，不是另一套东西。

按同样比例推到 `.app` 上大约省 0.57 MB（9.9 MiB → 约 9.3 MiB）。
**不大，但它是纯赚**：砍掉的是 AVIF 编码器、OpenEXR、TIFF，代码里一次都没调过。
顺带还省掉 `rav1e`/`ravif`/`y4m`/`av1-grain`/`loop9`/`exr` 这一串的编译时间，
在安卓那种要按小时算的交叉编译上更明显。

~~本次没有把这个改动落到主工作树~~ **后记（统合阶段）：已落地**，
见 `crates/kdj-providers/Cargo.toml`（commit 3985e3a）。
当时没动的原因（文件范围 + 并发 agent 的增量编译）已经不存在。

### 其它看过但不值得动的

`cargo tree --duplicates` 里的重复版本都是**别人拖进来的、砍不掉的**：

| 重复项 | 来源 | 结论 |
| --- | --- | --- |
| `thiserror` 1.0.69 + 2.0.19 | 上游没统一 | 等上游 |
| `tower-http` 0.6.11 + 0.7.0 | 0.6 来自 `reqwest`，0.7 是我们自己用的 | 降版会退功能，不动 |
| `rand_chacha` 0.3 + 0.9 | `rand` 新旧版并存 | 上游问题 |
| `tauri-utils` / `uuid` 各两份 | 一份 normal 一份 build | build 侧不进产物，无所谓 |
| `time` 0.3.54 两份 | 同上 | 无所谓 |

**没有为了体积删任何功能，也没有删任何测试。**

---

## 4. 安卓：APK 真的出来了

**结论先放**：`aarch64` 的 release APK 已经在本机产出，`EXIT=0`。

```
src-tauri/gen/android/app/build/outputs/apk/universal/release/
  app-universal-release-unsigned.apk      18,025,001 B  (≈17.19 MiB)
```

`unzip -l` 出来的构成（未压缩总计 19,343,258 B / 960 个文件）：

| 条目 | 未压缩字节 |
| --- | --- |
| `lib/arm64-v8a/libkdj_app_lib.so` | 15,239,504 |
| `classes.dex`（Kotlin/Java，过了 R8） | 2,073,184 |
| `resources.arsc` | 1,139,708 |
| 其余 res/ 图标等 | 约 0.9 MB |

**只有 arm64-v8a 一个 ABI**（虽然目录名叫 `universal`，那是 gradle 的 flavor 名，
不是"多 ABI"）。加 armv7 要 `--target aarch64 --target armv7`，会再多一份 .so。

⚠️ **是 unsigned 的**，文件名里就写着。装真机之前必须签名，见 §4.7。

下面是过程和踩到的坑。

### 4.1 环境是从零装起来的

本机原本只有 Android Studio + 一个老 SDK（`~/Library/Android/sdk`，
有 `platforms/android-33,34`、`build-tools/30.0.3,34.0.0`），
**没有 cmdline-tools、没有 NDK**。装的过程：

```bash
brew install --cask android-commandlinetools     # 旧的 tools/bin/sdkmanager 在 JDK 17+ 上跑不起来
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JDK 17.0.7
export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" --install "ndk;27.2.12479018" "platform-tools"
rustup target add aarch64-linux-android armv7-linux-androideabi
```

NDK 落盘 **2.4 GB**。版本就是 `rust-android.yml` 里钉死的 `27.2.12479018`（r27c），
没有换。JDK 用 Android Studio 自带的 JBR 17——**系统 `java` 是 22，
`sdkmanager` 在它下面会挂**，这一条 YAML 里没写，补在下面。

### 4.2 `tauri android init`：一次通过

```
Info Using installed NDK: .../ndk/27.2.12479018
Info Installing Android Rust targets...   ← 它自己又补装了 i686 / x86_64
Generating Android Studio project...
victory: Project generated successfully!
```

生成 `src-tauri/gen/android/`（gitignore 里已经排除了）。
`identifier = "com.kdj.app"` **没有**被 Java 包名规则拒绝
——YAML 注释里担心的那条没发生。但 Tauri 会告警：

```
Warn The bundle identifier "com.kdj.app" set in `"tauri.conf.json" identifier`
     ends with `.app`. This is not recommended because it conflicts with the
     application bundle extension on macOS.
```

**本次没改 identifier。** 它不阻塞任何构建，而 bundle id 是产品身份决定
（改了 macOS 的 LaunchServices / keychain 记录也跟着变），应该由用户拍板，
不该由打包这一步顺手改掉。数据目录不受影响：`src-tauri/src/lib.rs::legacy_data_dir`
取的是 `app_config_dir()` 的**父目录**再拼死 `kdj`，和 identifier 无关。

> **后续产品决策（2026-07-27）**：正式身份已固定为 `com.kdj.app`。当时的
> `com.kdj.app` 构建只是无用户的预发行验证包，不保留覆盖升级兼容；从首个
> `com.kdj.app` 签名包起，identifier 与 Android keystore 均不得再更换。

### 4.3 `tauri android build --apk --target aarch64`：Rust 侧全通，产出 .so

**aarch64 的动态库编出来了**：

```
/Users/kumo/git/kdj/target/aarch64-linux-android/release/libkdj_app_lib.so
15,239,488 B  (≈14.53 MiB)
```

Tauri 随后把它 symlink 进 gradle 工程：
`src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libkdj_app_lib.so`。

`.so` 比 macOS 的可执行文件（9,980,144 B）大 5.3 MB，是正常的：cdylib 要保留
动态符号表和重定位信息，`strip = true` 剥不掉这部分。

编译过程里 YAML 列为高风险的那几个全部没报错：

| YAML 预判的风险 | 实测 |
| --- | --- |
| `ring` 需要 NDK clang，可能 `clang: not found` | ✅ `Compiling ring v0.17.14` 通过，没手工设 `CC_*`/`AR_*` |
| `rusqlite` bundled SQLite 要 cc + NDK | ✅ 通过 |
| `rustls` / `hyper-rustls` 交叉编译 | ✅ 通过 |
| NDK 版本飘 | 钉死 r27c，没遇到 |
| identifier 非法 | 没发生（见 4.2） |

也就是说 `rust-android.yml` 注释里排在前几位的风险，**在 r27c + NDK 自带 clang
的组合下都不成立**，可以把那几条降级。

### 4.4 真正卡住的地方：别的 agent 的 `pkill` 把 cargo 杀了

前两次构建都是这个错，**不是交叉编译问题**：

```
failed to build Android app: `Failed to run `cargo build`: command
["cargo", "build", "--package", "kdj-app", "--manifest-path",
 "/Users/kumo/git/kdj/src-tauri/Cargo.toml", "--target", "aarch64-linux-android",
 "--features", "tauri/custom-protocol tauri/custom-protocol", "--lib", "--release"]
exited with code <signal 15>
```

`<signal 15>` = SIGTERM。真因：同一时间另一个 agent 在跑
`for i in 1 2 3; do ./target/debug/kdj-app & sleep 12; pkill -f kdj-app; done`。
`pkill -f` 匹配的是**整条命令行**，而 tauri 生成的 cargo 命令行里有
`--package kdj-app`，于是连 cargo 一起杀了。

**这条坑值得记住**：在这个仓库里 `pkill -f kdj-app` 会误杀正在编译的 cargo。
要停应用请用 `pkill -f 'target/debug/kdj-app$'` 或者按 PID 杀。

这不是偶发：连着 5 次构建全死在这上面，其中一次是**编了 2 个多小时、
只差最后一步 LTO 链接**的时候被杀的。绕过办法（POSIX 语义：设成 SIG_IGN 的信号
在 `exec` 之后仍然是 ignored，会一路继承给 npx → tauri-cli → cargo → rustc）：

```bash
nohup sh -c "trap '' TERM; npx tauri android build --apk --target aarch64" &
```

另外多个 agent 共用同一个 `target/` 时会看到
`Blocking waiting for file lock on build directory`——那个是正常等待，不是故障。
但它和上面那条叠加起来很致命：cargo 排队等锁的那几分钟里被 `pkill` 扫到，
日志上看就是"什么都没编就 signal 15 了"，很容易误判成交叉编译配置有问题。

### 4.5 gradle 那一步：`Failed to find Build Tools revision 35.0.0`

Rust 侧全通之后，`gradlew` 倒在这里：

```
FAILURE: Build failed with an exception.
* What went wrong:
Could not determine the dependencies of task ':app:minifyUniversalReleaseWithR8'.
> Failed to find Build Tools revision 35.0.0
BUILD FAILED in 1m 53s
```

**和交叉编译一点关系都没有，是 SDK 装少了。** `tauri android init` 生成的
`gen/android/app/build.gradle.kts` 里写的是：

```kotlin
compileSdk = 36
minSdk = 24
targetSdk = 36
// build.gradle.kts: classpath("com.android.tools.build:gradle:8.11.0")
```

AGP 8.11 默认要 build-tools **35.0.0**，本机只有 30.0.3 / 34.0.0。
`rust-android.yml` 骨架里写的也是 `platforms;android-34` + `build-tools;34.0.0`，
**在 CI 上会撞一模一样的错**——而且是在 cargo 编了一两个小时之后才撞上。
已经把 YAML 改成 `platforms;android-36` + `build-tools;35.0.0` 并写清了理由。

本机补装：

```bash
sdkmanager --sdk_root="$ANDROID_HOME" --install "build-tools;35.0.0" "platforms;android-36"
```

补完之后重跑，**gradle 一次通过，APK 出来了**（`BUILD SUCCESSFUL`，
`Finished 1 APK at: .../app-universal-release-unsigned.apk`）。
这一遍 cargo 是全缓存的，只花了 20s + 55s，gradle 侧几分钟。

### 4.6 复现命令

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export NDK_HOME="$ANDROID_NDK_HOME"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd /Users/kumo/git/kdj
# 机器上有别的 agent 在跑 `pkill -f kdj-app` 时，套一层 trap 保命（见 4.4）
nohup sh -c "trap '' TERM; npx tauri android build --apk --target aarch64" &
```

### 4.7 装机之前必须先解决：`usesCleartextTraffic = false`

这是**看代码发现的、比签名更要命的一条**，写在最前面。

`gen/android/app/build.gradle.kts` 里 Tauri 生成的是：

```kotlin
defaultConfig {
    manifestPlaceholders["usesCleartextTraffic"] = "false"   // ← release 走这条
}
buildTypes {
    getByName("debug") {
        manifestPlaceholders["usesCleartextTraffic"] = "true"  // ← 只有 debug 是 true
    }
}
```

而 KDJ 的整个架构是"**进程内 axum 绑 127.0.0.1 + 前端走 http:// 和 ws://**"
（`HANDOFF.md` §5 明确保留了 localhost HTTP + token，理由是播放器要 Range 请求）。
`usesCleartextTraffic=false` 会让 Android 的默认 network security config
禁掉明文 HTTP，**release APK 装上去大概率是"能开但什么都加载不出来"**，
而且 debug 包试不出来（debug 那条是 true）。

三个解法，按推荐排序：

1. 给 release 也置 `manifestPlaceholders["usesCleartextTraffic"] = "true"`——
   最省事，但等于对全网放开明文；
2. 写一份 `network_security_config.xml`，只对 `127.0.0.1` / `localhost`
   开 `cleartextTrafficPermitted="true"`——更干净；
3. 改成走 Tauri 的自定义协议 / IPC，不用本地 HTTP——推翻既有架构决定，不建议。

**后记（统合阶段）：选了 1**，做成 CI 里 init 之后的 sed 补丁步骤
（`rust-android.yml`「放行 localhost 明文」，sed 打空会 fail 而不是装作补完）。
没选 2 的原因：`gen/android` 不入库，方案 2 要往生成树里塞一个新 res 文件
+ 改 manifest 引用，补丁面积是方案 1 的好几倍，而这个 app 自己的出站请求
全走 https，实际暴露面只有本机回环上的明文。哪天要收紧再升级到方案 2。

无论选哪个，都要面对"`gen/android` 不入库、下次 `init` 会冲掉手改"的问题
（见 `05-ci-and-packaging.md` §4）。

**好消息**：INTERNET 权限**不用补**。生成的 `app/src/main/AndroidManifest.xml`
第 3 行就有 `<uses-permission android:name="android.permission.INTERNET" />`，
merger report 里也确认合并进去了。原来 YAML 注释里把它列成第一风险，是猜错了。

### 4.8 还没验证的（诚实清单）

| 项 | 状态 |
| --- | --- |
| APK 生成 | ✅ 18,025,001 B，unsigned，见 §4 开头 |
| INTERNET 权限 | ✅ Tauri 模板自带，不用补 |
| **明文 HTTP** | ❌ **release 是 false，装机前必须改**，见 §4.7 |
| 签名 | ⬜ 产物就叫 `-unsigned.apk`。装机要 `apksigner sign`（build-tools 35.0.0 里有），发版要挂 keystore secrets |
| 装进真机能起窗口 | ⬜ 没有真机/模拟器可用 |
| 16KB page size 对齐（Android 15） | ⬜ 钉 r27c 是为这个，但没在真机验证 |
| armv7 ABI | ⬜ 只编了 aarch64；APK 里只有 `lib/arm64-v8a/` |
| 下载 / 播放 / 分析在安卓上真的能跑 | ⬜ 一行都没验证过 |

---

## 5. 怎么复现

### 桌面（macOS）

```bash
cd /Users/kumo/git/kdj
npx tauri build
# 产物：
#   target/release/bundle/macos/KDJ.app
#   target/release/bundle/dmg/KDJ_0.2.0_aarch64.dmg

# 量体积（要真字节数，不要 du -sh 的四舍五入）
du -sk target/release/bundle/macos/KDJ.app
stat -f "%z %N" target/release/bundle/dmg/*.dmg \
                target/release/bundle/macos/KDJ.app/Contents/MacOS/kdj-app

# 验证它真的能跑（不是只是"文件存在"）
open target/release/bundle/macos/KDJ.app
osascript -e 'tell application "System Events" to get name of every window of \
  (first process whose unix id is <PID>)'      # → KDJ
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<随机端口>/   # → 401（鉴权在起作用）
```

本次就是这么验的：窗口标题 `KDJ` 出来了，进程内 axum 监听
`127.0.0.1:61791`（随机端口，每次启动重新生成 token），裸 GET 返回 401
—— 壳、前端、server、鉴权四段都通。

DMG 也真挂载过，不是只看了文件大小：

```bash
hdiutil attach -nobrowse -readonly target/release/bundle/dmg/KDJ_0.2.0_aarch64.dmg
ls -la /Volumes/KDJ/     # KDJ.app + Applications 软链 + .VolumeIcon.icns
du -sk /Volumes/KDJ/KDJ.app   # 10096
hdiutil detach /Volumes/KDJ
```

### 依赖裁剪对照（想量 `image` 那块的话）

**别在主工作树上量**，会把其他 agent 的增量编译作废。复制一份出去：

```bash
rsync -a --exclude target --exclude node_modules --exclude .git \
      /Users/kumo/git/kdj/ /tmp/kdsize/
# 从 /tmp/kdsize/Cargo.toml 的 members 里删掉 "src-tauri"（不然要前端产物）
CARGO_TARGET_DIR=/tmp/kdsize-target cargo build --release \
  --manifest-path /tmp/kdsize/Cargo.toml -p kdj-server --bin kdj-server
stat -f "%z" /tmp/kdsize-target/release/kdj-server        # 基线
# 改 /tmp/kdsize/crates/kdj-providers/Cargo.toml 的 image features，再编一次，对比
```

⚠️ 冷编一次要很久（`lto = true` + `codegen-units = 1`），机器上有别的 cargo 在跑
就更久。本次这一对照跑完了，结果见 §3。第二遍是增量的，只重编 `image` 及其下游，
比第一遍快得多。

### 安卓（从零到 APK 的完整序列）

```bash
# 1. 工具链（本机原来只有 Android Studio + 老 SDK，没有 cmdline-tools / NDK）
brew install --cask android-commandlinetools
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JDK 17
export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" --install \
  "ndk;27.2.12479018" "platform-tools" "platforms;android-36" "build-tools;35.0.0"
rustup target add aarch64-linux-android armv7-linux-androideabi

# 2. 生成 gradle 工程（gen/android 是生成物，不入库）
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export NDK_HOME="$ANDROID_NDK_HOME"
cd /Users/kumo/git/kdj
npx tauri android init

# 3. 编 APK（trap 那层见 §4.4；机器空闲时不需要）
nohup sh -c "trap '' TERM; npx tauri android build --apk --target aarch64" &

# 4. 产物
stat -f "%z %N" src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk
unzip -l src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk | grep lib/
```

`build-tools;35.0.0` / `platforms;android-36` 这两个是**必须的**，装 34 会在
gradle 那一步倒（§4.5）。版本要跟着 `gen/android/app/build.gradle.kts` 的
`compileSdk` 和 AGP 版本走。

---

## 6. 已经改进 CI 的地方

`.github/workflows/rust-android.yml`（本次改了）：

1. **SDK 版本装错了，是个真 bug**：原来装 `platforms;android-34` +
   `build-tools;34.0.0`，而 `android init` 生成的工程要 `compileSdk 36` +
   AGP 8.11（默认 build-tools 35.0.0）。已改成 `android-36` + `35.0.0` +
   `platform-tools`，并写清了"以后 Tauri 升版要 grep gen/android/app/build.gradle.kts
   跟着改"。**这个错要等 cargo 编完一两个小时才暴露**，值得提前修。
2. **风险表按实测重排**：`ring` / `rusqlite bundled` / `rustls` 三条在 NDK r27c
   下一次编过，标成 ✅ 并写明"别再去调 CC_*/AR_*"；把 INTERNET 权限提到第 1 位。
3. **JDK 上限**：补了一句"系统 JDK 22 会让 sdkmanager 起不来"，说明为什么钉 17。
4. **时间预期**：写明冷编要按小时算，`Swatinem/rust-cache` 是刚需不是优化。
5. **identifier**：把"必须改名"改成"现在这个合法，只是有告警，换不换用户拍板"。

`.github/workflows/rust-build.yml`（本次改了）：产物落点从"猜三种情况"改成
写死实测结果（根 `target/release/bundle/`），并把 155MB vs 5.9MB 的真实差距
补进 tag 撞车那段注释里。**逻辑一行没动，只补注释和实测数字。**

两个 YAML 都过了 `python3 -c "import yaml; yaml.safe_load(...)"`。
但**这两条流水线仍然没在 GitHub 上真跑过**，首跑还是要按报错迭代。

---

## 7. 下一步

按"装机前必须做"排序：

1. **`usesCleartextTraffic`（§4.7）**——不解决的话 release APK 装上去就是空白页，
   而且 debug 包复现不出来。建议写 `network_security_config.xml` 只放开 127.0.0.1。
2. **签名**：产物是 `-unsigned.apk`，`adb install` 会直接拒。本机自测可以先用
   `apksigner sign --ks debug.keystore`；发版走 CI secrets。
3. **装进真机跑一遍**：下载 / 播放 / 分析三条主路径，一行都还没验证过。
   范围按 `HANDOFF.md` §6 的第 3 条来——多根曲库目录和文件夹拖拽是桌面专属。
4. **armv7**：`--target aarch64 --target armv7`，兜老设备。
5. **`image` 的 default features**（§3）：改一行，实测省 597,424 B。
   要动 `crates/kdj-providers/Cargo.toml`，本次不在文件范围内。
   改完记得跑一遍封面相关的冒烟（四家平台各下一首看封面写进去没有）。
6. **identifier** 后续已拍板固定为 `com.kdj.app`（见 §4.2 后记）。
7. macOS 签名/公证仍然没有（和 v0.1.0 一致，首次打开要右键 → 打开）。

`HANDOFF.md` 的里程碑表里 M8 那一行可以从"⬜ 未开始"改成
"🟡 APK 能编出来了，还没装过真机"——本次没动 HANDOFF，因为同时有别的 agent
在改它，交给下一个人合并。
