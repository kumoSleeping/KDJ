# 05 · CI 与打包：桌面三平台 + 安卓

两条新流水线，都**不碰**现有的 `build.yml` / `test.yml`：

| 文件 | 干什么 | 触发 |
| --- | --- | --- |
| `.github/workflows/build.yml`（旧，不动） | Electron + PyInstaller sidecar，v0.1.0 的正式产物 | `v*` tag / 手动 |
| `.github/workflows/test.yml`（旧，不动） | main 上的 pytest + 前端构建 | push main / PR |
| `.github/workflows/rust-build.yml`（新） | Tauri 桌面三平台 | push `rust-rewrite` / `v*`、`rust-v*` tag / 手动 |
| `.github/workflows/rust-android.yml`（新） | 安卓 APK（**骨架**） | `v*`、`rust-v*` tag / 手动 |

新旧并存是有意的：在用户点头把 `rust-rewrite` 扶正之前，main 上的发布路径
必须保持可用（HANDOFF 铁律 1）。

## 1. tag 撞车：这是第一个要知道的坑

旧的 `build.yml` 监听 `v*`。如果新流水线也只监听 `v*`，那么打一个 `v0.2.0`
会**同时**触发 Electron 和 Tauri 两条线，两个 `softprops/action-gh-release`
往同一个 Release 里塞包——用户会看到一个 155MB 的 DMG 和一个 15MB 的 DMG
并列，还分不清哪个是哪个。

所以 `rust-build.yml` 同时监听 `v*` **和** `rust-v*`：

- 切换之前：打 `rust-v0.2.0`。GitHub 的 ref 模式从头匹配，`v*` **不会**命中
  `rust-v0.2.0`，旧线不动，只出 Tauri 包。
- 正式切换之后：删掉 `build.yml`，`v*` 就归 Tauri 线独占，什么都不用改。

## 2. 桌面流水线（rust-build.yml）

矩阵三条，每条的步骤一样：

```
checkout → 装 Rust(+target) → rust-cache → 装 Node
        → [Linux] apt 装系统依赖
        → cargo test --workspace
        → npm ci → npm run typecheck
        → 探测 src-tauri/ → Tauri 打包 → 上传 artifact → [tag] 发 Release
```

| 矩阵项 | runner | 产物 |
| --- | --- | --- |
| `macos-universal` | macos-latest（Apple Silicon） | universal DMG（arm64+x64 合一） |
| `linux-x86_64` | ubuntu-latest | AppImage / deb / rpm |
| `windows-x86_64` | windows-latest | NSIS exe / msi |

几个决定的理由：

**`permissions: contents: write` 写在顶层。** v0.1.0 首跑三平台的包全打出来了，
栽在最后一步上传——默认 `GITHUB_TOKEN` 是只读的。这一条是 `docs/05-tabs-git-and-ci.md`
记录的原始伤口，照抄过来。

**mac 出 universal 而不是两个包。** v0.1.0 是 arm64 / x64 两个 DMG；Tauri 的
`--target universal-apple-darwin` 一次合成一个，用户不用挑。代价是编两遍，
所以两个 apple target 都要在 `dtolnay/rust-toolchain` 的 `targets` 里装上。

**测试跑 debug，不跑 `--release`。** 根 `Cargo.toml` 的 release 档开了
`lto = true` + `codegen-units = 1`，跑测试等于白等十几分钟；而且
`panic = "abort"` 对测试 harness 无意义（cargo 会忽略它并告警）。

**cargo 后面不许接 `| head -N`。** 读端提前关闭会给 cargo 发 SIGPIPE 把编译
打断，表现是"随机失败"，很难联想到管道。这条在本地排查时也一样。

**产物路径用 `**/release/bundle/...` 宽松通配。** `src-tauri` 到底算不算
workspace 成员，会决定产物落在根 `target/` 还是 `src-tauri/target/`；
加 `--target` 又多一层三元组目录。与其猜三种组合，不如让 glob 全兜住。

**Linux 的 appindicator 包名换过。** Ubuntu 24.04 起 `libappindicator3-dev`
已被 `libayatana-appindicator3-dev` 取代，写死旧名字会 `E: Unable to locate package`。
脚本里先试新名再回退旧名。webkit 要 **4.1**（Tauri 2），写 4.0 是 Tauri 1 的说明书。

## 3. 现在这条线是"能绿但不打包"

M7 的 Tauri 壳还没完工。流水线里有一步 `探测 Tauri 壳`：

- 缺 `src-tauri/tauri.conf.json` 或 `src-tauri/Cargo.toml` → 打一条
  `::warning::`，跳过打包/上传/发布，只留 `cargo test --workspace` +
  `npm run typecheck`。这样它**今天就有用**：三个平台上验证 Rust 代码能编、
  能过测（本地只跑得到 macOS）。
- 两个文件都在 → 自动开始真打包，不需要再改 YAML。

判据故意不是"目录存不存在"：壳在半成品状态下（只有 `icons/`、`capabilities/`、
`src/`，配置还没写）目录就已经在了，按目录判会误触发一次注定失败的打包。

打包命令也做了兜底：`package.json` 里有 `tauri:build` 就用它，没有就
`npx --yes @tauri-apps/cli@^2 build`。注意**必须写全包名**——`npx tauri`
会去装 npm 上那个 v1 时代的同名废弃包。

## 4. 安卓流水线（rust-android.yml）：明确是骨架

没人在真机上跑通过，M7/M8 都没做。YAML 注释里逐条写了风险，这里汇总：

| 风险 | 症状 | 怎么办 |
| --- | --- | --- |
| **签名** | APK 出来了但真机"应用未安装" | 现在只出未签名/debug 签名包。发版要加 keystore secrets，在 `gen/android/app/build.gradle.kts` 挂 `signingConfigs` |
| **NDK 版本飘** | 昨天还好好的，今天 clang 找不到 | 钉 `NDK_VERSION=27.2.12479018`，不用 runner 预装版本 |
| **ring 交叉编译** | `-lgcc not found` / `clang: not found` | reqwest 走 rustls → 后端是 ring，有汇编+C，吃 NDK clang。armv7 上可能还要显式 `CC_armv7_linux_androideabi` / `AR_...` |
| **rusqlite bundled** | 编 SQLite 的 C 源码时报错 | 同样吃 NDK clang；别让它去 pkg-config 找系统 sqlite |
| **16KB page size** | Android 15 上加载 .so 失败 | 老 NDK 编的库不对齐，这是钉 r27 的另一个理由 |
| **identifier 非法** | `android init` 直接拒绝 | Java 包名规则：不能带 `-`、不能数字开头 |
| **`gen/android` 不入库** | 手改的 AndroidManifest 每次被冲掉 | Tauri 官方建议生成物不提交；要加权限就得把 `gen/android` 提交进仓库，或用 Tauri 的 manifest 合并配置 |

`ANDROID_NDK_HOME` 和 `NDK_HOME` 两个变量都要设：Tauri 读前者，cc-rs
（ring / libsqlite3-sys 的 build script）读后者。只给一个会在"gradle 起来了
但 cargo 编不过"的地方失败，非常难看出是缺变量。

只装 `aarch64` + `armv7` 两个 ABI（真机）。要跑模拟器再补 `i686`/`x86_64`——
**rustup target 和 `--target` 参数要一起加**，否则 gradle 找不到那个 ABI 的
`.so` 会直接失败。

## 5. 本地怎么复现

```bash
# 桌面：CI 的前半段，本地一模一样
cargo test --workspace          # 不要接 | head，会 SIGPIPE
npm ci && npm run typecheck

# 壳做好之后
npx --yes @tauri-apps/cli@^2 build
npx --yes @tauri-apps/cli@^2 build --target universal-apple-darwin   # mac 双架构

# Linux 系统依赖（Ubuntu 24.04）
sudo apt-get install -y build-essential curl wget file \
  libwebkit2gtk-4.1-dev librsvg2-dev patchelf libxdo-dev libssl-dev \
  libayatana-appindicator3-dev

# 安卓
rustup target add aarch64-linux-android armv7-linux-androideabi
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export NDK_HOME="$ANDROID_NDK_HOME"
npx --yes @tauri-apps/cli@^2 android init
npx --yes @tauri-apps/cli@^2 android build --apk --target aarch64 --target armv7
```

真库集成测试在 CI 上会自己跳过（靠 `KDJ_TEST_DB` 开关），
本地想跑见 `04-library-layer.md`。

## 6. 远程排障

`docs/05-tabs-git-and-ci.md` 里那招"给 pytest 装
`pytest-github-actions-annotate-failures`，失败断言变成匿名可读的 check-run
annotation"，**Rust 这边没有直接对应物**。替代手段：

- 流水线里主动 `echo "::error::..."` / `::warning::` 的内容会进 annotation，
  匿名可读——`探测 Tauri 壳` 那步的 warning 就是按这个写的；
- `cargo test` 失败时 runner 会带上 `RUST_BACKTRACE`（需要时在 step 上加
  `env: RUST_BACKTRACE: 1`）；
- 实在要看全量日志，只能登录看 Actions，或者把日志 `upload-artifact` 出来。

## 7. 已知边界

- **mac 不签名**，和 v0.1.0 一致：首次打开要右键 → 打开。要去掉这一步得买
  开发者证书 + 配公证（`APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_PASSWORD` secrets）。
- **ffmpeg 仍然不随包携带**：B 站视频混流依赖用户机器上有 ffmpeg。分析/解码
  已经改成 symphonia，不再需要它（见 `00-architecture.md` §6）。
- **这两条流水线都没在 GitHub 上真跑过**。本地能验证的只有 YAML 语法
  （`python3 -c "import yaml;yaml.safe_load(open('...'))"`）和步骤里那几条命令
  在 macOS 上的行为。首跑大概率要按报错迭代，属正常。

## 下一步

M7 的 Tauri 壳一落地，这两条流水线的 `探测 Tauri 壳` 就会自动从"跳过"
变成"打包"，不需要改 YAML。届时要补的是：`tauri.conf.json` 的 identifier /
图标 / `beforeBuildCommand`，以及 `package.json` 里的 `tauri:build` 脚本。
