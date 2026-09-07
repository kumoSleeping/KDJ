# RC5 安装包体积排查

> 后续决策：用户明确选择发行版改回 `panic=abort`，保留本轮其他体积优化。
> 下表保留的是 **unwind 方案的历史 A/B 测量**，不是最终 RC6 的包体结果。
> 当前错误处理加固、审计与剩余风险见 [RC6 abort 与安全检查](rc6-abort-safety-review.md)。

## 范围与结论

RC5 的 Rust/前端编译与桌面 updater 签名校验成功，但所有平台被体积门禁拦截，
Release 没有产物。桌面日志：GitHub Actions `34157283444`；Android：`34157284548`。
RC5 增加 `panic=unwind` 是为了让解码/音频设备初始化的 `catch_unwind` 在发行版生效。
后续按用户决定改回 `abort` 时，这项 panic 隔离能力不再存在；正常 Result 错误仍可恢复。

这不意味着 RC5 的全部体积都必须接受。采用混合优化等级并去除未使用的动态权限
支持后，保留 unwind 的 macOS 主程序减少约 22%；再无损重压 DMG，下载体积减少约 15%。
**这是同机 A/B 实测，不是 Windows/Android 的预测，也不是新版本已经发布的证明。**

## 上一轮优化与测量配置

1. `Cargo.toml`：通用 release 从 `s` 改为 `z`，保留 LTO、单 codegen unit、符号裁剪、
   测量时 `panic=unwind`（最终另行改为 abort）。解码、重采样、FFT、波形和实时 DSP 的
   既有 `opt-level=2` 覆盖全部保留。
   不再把历史上“所有代码都用 z 导致波形变慢”的结论套到这个混合配置上。
2. `src-tauri/Cargo.toml`：显式保留 Tauri 的其他默认 features，只去除 `dynamic-acl`。
   KDJ 没有 `add_capability` 调用；权限仍由 `src-tauri/capabilities/*.json` 在编译期解析，
   运行时照常检查允许/禁止命令、窗口和作用域。没有删除任何权限规则。
   `plugins/native-audio/Cargo.toml` 同时关闭 Tauri 默认 features，防止移动端通过
   Cargo feature 合并重新启用动态 ACL。
3. `scripts/compress-macos-dmg.sh`：用系统 `hdiutil` 将未签名 DMG 容器转换为 UDBZ，
   校验成功且文件确实更小时才原子替换；已有外层签名的 DMG 拒绝处理。
   UDBZ 支持所有 KDJ 支持的 macOS 版本，不改应用内容或 `.app.tar.gz` 更新归档。
   桌面 CI 在体积门禁前调用它；本地 `tauri bundle` 后可手动运行同一脚本。

本次没有放宽 `check-desktop-bundle-size.sh` / `check-android-apk-size.sh` 的预算。

## 可复核的本地测量

环境：Apple M2、macOS 26.5、SDK 14.2、rustc 1.90.0、Tauri CLI 2.11.4，源码基线
`39db632`（RC5）。GitHub RC5 使用 rustc 1.98.1，因此**不能直接把本地绝对值与
GitHub 安装包相减当成优化收益**。下面两组使用同一工具链、同一份新构建前端。

| 产物 | RC5 配置 | 优化后（仍 unwind） | 减少 |
| --- | ---: | ---: | ---: |
| 已裁剪/临时 ad-hoc 签名的 arm64 主程序 | 21,332,704 B | 16,675,552 B | 4,657,152 B（21.8%） |
| 上述主程序 gzip -9（不是 updater 包） | 9,911,015 B | 8,907,413 B | 1,003,602 B（10.1%） |
| Tauri 默认 UDZO DMG | 10,789,149 B | 9,796,193 B | 992,956 B（9.2%） |
| 优化后再用 UDBZ 的 DMG | 10,789,149 B | 9,213,941 B | 1,575,208 B（14.6%） |

### 只切换 panic 的对照

在原 RC5 manifests 上，仅设置 `CARGO_PROFILE_RELEASE_PANIC=abort`（仍经同一 Tauri CLI、
相同前端/裁剪/打包流程），得到主程序 **16,995,280 B**、主程序 gzip **8,304,792 B**、
默认 UDZO DMG **9,178,463 B**。该变体仅用于测量，没有运行或用于产品发布。

因此可单独归因给 unwind 的本机增量是主程序 **4,337,424 B**、gzip **1,606,223 B**；
不是只根据 RC4/RC5 两个版本的差猜测。优化后仍保留 unwind 的主程序已经比这个
abort 对照更小；优化 + UDBZ 的 DMG 只比原配置 abort 对照大 **35,478 B**。
这说明优化抵消了大部分增量，**不是说 unwind 本身只花 35 KB**：同样的优化也可以
应用到 abort，而后者没有 panic 隔离能力。

### 容器压缩对照

对优化后的同一个 DMG 额外试验：UDZO level 9 仍为 9,796,193 B；ULFO 为
9,976,224 B；UDBZ 为 9,213,941 B。因此选择 UDBZ，而不是盲目换最新压缩格式。
它主要降低手动下载安装包体积；应用启动/播放代码及 updater 归档内容不受该步骤影响。

测量采用隔离源码副本，符号暂留以检查 Mach-O 分段，再对两组做相同裁剪和临时签名。
主要命令（不是正式签名发布流程）：

```sh
npm run tauri:web:build
# 基线：原 RC5 Cargo manifests；优化：应用本次 manifests。
CARGO_PROFILE_RELEASE_STRIP=none npm run tauri -- build --no-bundle --ci \
  --config '{"build":{"beforeBuildCommand":""}}'
cp target/release/kdj-app /tmp/measurement.symbols
strip -o /tmp/measurement /tmp/measurement.symbols
codesign --force --sign - /tmp/measurement
wc -c /tmp/measurement
gzip -9 -c /tmp/measurement | wc -c
# 在隔离副本内用上述裁剪文件替换 target/release/kdj-app，再打测量用 DMG。
npm run tauri -- bundle --bundles dmg --ci --no-sign \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'
bash scripts/compress-macos-dmg.sh target/release/bundle/dmg/KDJ_1.0.0-rc5_aarch64.dmg
```

使用 Tauri CLI 而不是直接 `cargo build` 很重要：CLI 会传入 `REMOVE_UNUSED_COMMANDS`，
使已有的 unused-command 裁剪真正生效。前期不带该变量的诊断构建不作为上表基线。

## 性能与行为检查

- 同一 60 秒 44.1 kHz 双声道合成音频（和弦 + 脉冲），基线/优化交替执行五轮。
  两组均使用现有生产解码、重采样、波形、BPM/调性分析路径，分析模块维持等级 2。
- 五轮中位数（毫秒）：解码 `14.23 → 14.22`，重采样 `9.41 → 9.26`，
  单线程波形 `193.77 → 196.39`，分析 `49.94 → 50.03`。
  波形约 +1.4%，其余接近；这是小型合成基准，**不等价于所有格式/真机均无性能回归**。
- 分析结果、重采样 PCM、波形振幅/极值的输出摘要十次一致。
- 现有 `scripts/test-playback-recovery.mjs` 增加音频优化等级和 Tauri feature 策略回归保护；
  原 unwind / 播放失败恢复用例保留，11 项通过。工作流 YAML 解析和新脚本 `bash -n` 通过。
- 四个平台（macOS、Windows、Linux、Android）的 `cargo tree --locked` 均确认
  `dynamic-acl` 不再启用，其他原默认 Tauri capabilities/backend features 保留。
- DMG 实测转换与 `hdiutil verify` 通过；重复运行不增大文件；带空格路径可用；
  给 DMG 添加临时外层签名后确认脚本拒绝重压，避免破坏签名。

## 其他排查结果与边界

- 前端新构建约 1.72 MB，逐文件 Brotli 合计约 0.423 MB（压缩量级参考，不是整个安装包）。
  Tauri 已开启内嵌资源压缩；没有大字体、海报或开发截图混入包体。
- 依赖图已统一主要 reqwest/rustls、image 和音频解码库；image 已裁掉 AVIF/OpenEXR/TIFF。
  不能把 proc-macro/build 依赖或 `.rlib/.a` 编译缓存大小当作安装包体积。
- FFT 的 f32/f64、网络协议、图片格式、标签编辑和音频格式均有实际调用；没有为省空间
  删除这些功能、关闭 SIMD、引入捆绑解码器或批量升级依赖。
- Android 已有 R8/resource shrinking、单 arm64 ABI 和现代未压缩 `.so` 布局。
  不启用 `useLegacyPackaging` 来制造下载数字变小而改变安装/加载行为。
- Windows NSIS 已使用默认 LZMA；没有未经实测替换安装器或压缩可执行文件壳。
- 本地最终 DMG 仍比旧 9.20 MB 门禁高约 14 KB；不能把接近上限当成发布通过。
  Windows、Intel Mac、Linux、Android 的最终大小和签名包须由各平台 CI 实测后决定，
  版本递增和正式发布仍需走完整发布流程。

所有隔离源码、测量程序、生成音频、安装包及日志在验证后删除，不写入正常用户数据目录。
