# KDJ 构建档位

KDJ 的稳定版与实验版是两个独立产品，不是运行时开关。

| 档位 | 产品名 / identifier | 实验功能 | 更新清单 |
| --- | --- | --- | --- |
| 稳定主版 | **KDJ** / **com.kdj.app** | 编译期移除 OneLibrary；隐藏 DJ 与全部实验入口 | **latest.json** |
| 实验版 | **KDJ Labs** / **com.kdj.app.labs** | DJ 模式、OneLibrary、虚拟 DJ 磁盘 | **latest-labs.json** |

已有 KDJ 用户始终沿 latest.json 升级到稳定主版，不会自动迁移到 Labs。两个应用
可以并存，配置目录和系统安装身份由各自 identifier 隔离。

## 本机构建

~~~bash
npm run build                 # 稳定 KDJ
npm run build:labs            # KDJ Labs
npm run tauri:dev             # 开发默认跑 Labs，便于覆盖实验功能
npm run tauri:dev:stable      # 稳定版开发壳
~~~

Rust 边界：kdj-app/labs 传播到 kdj-server/onelibrary。稳定构建不会解析或链接
rbox、Diesel、SQLCipher 和 vendored OpenSSL；普通 SQLite 曲库仍由 rusqlite 提供。

正式 tag 的桌面流水线同时构建两档，但 Android 只发布稳定 KDJ。发布完成前必须同时
生成两个桌面更新清单，任何清单都只能引用自己 flavor 的 artifact。
