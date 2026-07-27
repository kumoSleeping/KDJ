# 01 · 内核 + 网易云 / QQ 音乐两家 provider（纯 Rust 跑通）

分支 `rust-rewrite`。这一步交付：Cargo workspace 骨架、契约模型、配置、事件总线、
provider 抽象、以及**两家平台的完整实现并在真机验证过**。

## 已经能跑的东西

```
cargo run -p kdj-providers --example smoke_netease -- Supernova
cargo run -p kdj-providers --example smoke_qq       -- Supernova
```

实测输出（无登录态，匿名）：

- 网易云：搜到 5 条，音质档位 / VIP 标记 / 时长 / 封面全部正确，`resolve` 单曲链接成功。
- QQ 音乐：搜到 5 条（`meta.sum=1013`），`resolve` 成功，**下载管线跑通**——
  vkey → CDN 直链 → 流式落盘 → 原子改名 → 写标签，产出 2.8MB MP3，
  lofty 读回时长 175.673s，和搜索接口自报的 175s 对得上。

52 个单元测试全绿，其中最关键的是**对拍测试**：网易云的 weapi/eapi 密文、
QQ 的 zzc 签名 / hash33，都是拿 Python 库真机跑出来的向量做断言，不是"看起来对"。

## 坑（这一步真正花时间的地方）

### 1. QQ 搜索的 `searchid` 不是随便填的

一开始 Desktop 平台的搜索**返回 `code=0` 但结果是空的**（`meta.sum=0`）。
排查路径是：先怀疑必须走 Android 平台（要 QIMEI 设备指纹），
于是把 Python SDK 的真实 comm 原样抄出来手工发——**照样是 0 条**。
说明问题不在 comm。逐参数对比才发现 SDK 传的 `searchid` 是
`291245902806000497` 这种 18~19 位大数，我传的是 `"1"`。

换成按 QQ 前端算法生成的 searchid 之后，Desktop 平台（`ct=19, cv=2201`）
直接搜到 1013 条。

**这一条的价值不只是修了个 bug**：它证明了 Android 平台不是必需的，
而 Android 平台正是 `QIMEI` 设备指纹的唯一用途，`QIMEI` 又是那个
**12MB `cryptography` 依赖**的唯一用途。也就是说这 12MB 可以整个不要。

假成功（code=0 但空结果）比报错难查得多，所以 `new_search_id()` 上写了注释。

### 2. `enc_sec_key` 的前导零不能丢

网易云的 RSA 是"教科书 RSA"：`hex(pow(m,e,N))[2:].zfill(256)`。
密文小于模数时前几个字节是 0，Rust 的 `BigUint::to_bytes_be()` 会把它们吃掉，
出来的 hex 就短了两位，服务端解出来的密钥整体错位 → **偶发登录失败**。
这种 1/256 概率的 bug 上线之后基本查不出来，所以专门写了个跑 64 次随机密钥、
断言长度恒为 256 的测试。

### 3. `base64.encodebytes` 的换行是协议的一部分

pyncm 的 weapi 密文用的是 Python `base64.encodebytes`——每 76 字符插一个 `\n`、
**结尾也有一个 `\n`**。Rust 的 base64 默认不换行。这个差异不会报错，
只会让服务端偶尔不认。对拍测试是逐字节比较的，所以一开始就暴露了。

### 4. QQ 的二维码图必须自己放大

`ptqrshow` 回的 PNG 只有一百多像素，原样塞进 `<img>` 会被浏览器插值成糊边、
手机扫不出来。Python 版为此拉了 14MB 的 Pillow 进来。
Rust 这边用 `image` crate 做整数倍最近邻放大到 ≥420px（必须整数倍，
非整数缩放会把码块切出灰边）。

### 5. `detect` 之外的小事

- `AtomicDownload` 用 `Drop` 实现"失败就删半成品"，比 Python 的 try/except 更难写漏。
- 试听片段检测必须在 `commit()` **之前**——一旦落到最终路径，曲库扫描就会把
  30 秒的残次品收进去。
- 网易云 eapi 响应有时是 AES 密文、有时是明文 JSON，两种都要认；
  解不出来时返回 `None` 让调用方退回明文解析，而不是把整个请求判失败。

## 迁移：老用户不用重新扫码

v0.1.x 的登录态是 `netease.pyncm`（`"PYNCM" + base64(zlib(json))`）和 `qqmusic.json`。

- 网易云：第一次启动时读旧文件、抽出 cookies/csrf，就地写成新格式 `netease.json`。
- QQ：字段名兼容旧的驼峰键（`musickeyCreateTime` / `encryptUin` / `loginType`）。

两条都有测试覆盖。

## 安全约束的落地位置

| 约束 | 在哪 |
| --- | --- |
| host 精确匹配（盲 SSRF） | `net::host_is`，测试里直接放了 `?ref=163cn.tv` 的攻击形状 |
| 短链逐跳 + 公网 IP 校验 | `net::expand_short_link` / `resolves_to_public_ip` |
| 先 `.partial` 再原子改名 | `net::AtomicDownload`（`Drop` 保证清理） |
| 媒体直链只挡协议和内网 | `net::ensure_media_url` |

`resolves_to_public_ip` 比 Python 版覆盖更全：额外挡了 CGNAT 100.64/10、
IETF 保留段、IPv4-mapped IPv6，测试里含 `169.254.169.254`（云元数据服务）。

## 下一步

B 站（WBI 签名 + DASH）、SoundCloud（client_id 抓取，替掉 15MB 的 yt-dlp），
然后是分析管线和曲库层。
