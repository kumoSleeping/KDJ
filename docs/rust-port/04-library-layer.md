# 04 · 曲库层：SQLite / 文件夹 / 扫描 / 和声推荐

`crates/kdj-library`：43 个单元测试 + **11 个跑在用户真实曲库上的集成测试**。

## 最重要的一件事：老库直接能开

表结构和 v0.1.x 逐字一致，用户手上那个 1379 首的 `kdj.db`
不需要迁移、不需要重扫。集成测试就是拿真库的副本跑的。

```bash
KDJ_TEST_DB=~/Library/Application\ Support/kdj/data/kdj.db \
  cargo test -p kdj-library --test real_library
```

没设这个环境变量就整组跳过（CI 上没有这个文件）。
**测试内部会先拷一份到临时目录再打开**——WAL 模式会写 `-wal`/`-shm`，
绝不能碰用户的原始数据。

## 真库跑出来的 11 条

单元测试用的是造出来的几行数据，覆盖不到"真实数据的形状"：
空 camelot、NULL bpm、同一首歌在多个 set 里各有一份。这些只有真库里才有。

| 测的是什么 | 为什么值得单独测 |
| --- | --- |
| 开库不丢数据 | 1379 首 / 1037 首已分析，调号分布 > 10 种 |
| 分页不重复 | 排序键有大量并列值时，没有 id 兜底会翻页翻出重复 |
| 调号排序单调 | 字符串排序会把 `10A` 排到 `8A` 前面 |
| `8A` 和 `A minor` 命中同一批 | 同音异名表打错就会搜不到 |
| `%` 不是通配符 | LIKE 转义漏了的话搜 `%` 会返回全库 |
| 已分析 + 未分析 = 全部 | 两个过滤条件必须互补 |
| 和声推荐兼容/降序/去重/能对拍 | 这是 DJ 现场真正在用的功能 |
| **pending 只含未分析的** | 见下 |
| 文件夹浅层不含子目录曲目 | Windows 上 `\` 撞 LIKE 转义符的那个真 bug |

### `pending_analysis_ids` 这条是硬约束

`docs/rust-port/03` 里说过：Rust 版和 Python 版的 BPM 在约 10% 的曲子上
会选到不同的倍数。**只要不重算已分析的曲目，影响就是零。**

所以默认查询是 `WHERE analyzed_at IS NULL`，只有用户显式点「强制重新分析」
才覆盖。这条现在有测试钉着：抽查 pending 队列里的前 20 首，
每一首的 `analyzed_at` 都必须是 NULL。

## 顺手修掉的一个潜伏顺序问题

Python 版 `init_schema` 是先 `executescript`（里面含 `CREATE INDEX`）
再 `ALTER TABLE ADD COLUMN`。如果碰上一个真的缺 `camelot` 列的老库，
会卡在 `CREATE INDEX ... ON tracks(camelot)` 上。

现实里没炸过（那几列从 v1 起就在），但顺序反了就是反了。
Rust 版拆成三步：建表 → 补列 → 建索引，并配了一个"只有 NOT NULL 列的极简老库"
的迁移测试。

## 移植时特别注意的几处

### 1. 路径归一化两边必须完全一致

入库的 `path` 是 UNIQUE 键。`service::normalize_path` 和 `folders::norm`
用的是同一套：expanduser + absolute + normalize，**不做 realpath**。

一旦其中一处改成解析符号链接，文件夹树的计数会全落进 `outside`——
因为树上的目录路径和库里存的 path 对不上了。

### 2. 包含性检查要过两道

`ensure_inside` 先做词法包含（挡 `../../..`），再对 realpath 做一次
（挡"曲库里放一个指向 /etc 的软链接再往里搬文件"）。
只做前者会被软链接绕过，只做后者又和库里未解析的 path 对不上。

测试里有一条 `a_symlink_pointing_outside_the_library_is_rejected` 专门盯这个。

另外用的是 `Path::starts_with` 而不是字符串前缀——后者会被
`/Users/me/Music-evil` 这种同前缀的兄弟目录骗过去，也有测试。

### 3. 文件操作一律不覆盖

`unique_target` 同名时加 ` (2)`、` (3)`。DJ 的两个 set 里同名不同 mix
的文件很常见（`Track - Artist.mp3` 可能是 radio edit 也可能是 extended），
静默覆盖会直接丢掉一首歌。

`link_file` 优先硬链接 → 符号链接 → 真复制，返回实际用的方式给前端显示。

### 4. `rebase_paths` 不能用 SQL 的 replace

目录改名后要整体换路径前缀。用一条
`UPDATE ... replace(path, ?, ?)` 会替换字符串里**每一处**匹配，
路径里恰好出现两次同名片段时就改错了（`/Music/set1/set1/a.mp3` 并不罕见）。
所以是取出来在代码里按前缀长度切。

### 5. 扫描要剪枝而不是过滤结果

`walkdir` 的 `filter_entry` 是剪枝（根本不进那个目录），
`filter` 是遍历完了再筛。碰上 `node_modules` 那种目录，两者的差别是几万次 stat。

macOS 在非 HFS 卷上给每个文件配一个 `._xxx.mp3` 资源叉，后缀和正主一样，
不排掉会得到一堆 4KB 的"损坏音频"。

## 下一步

axum server（38 条路由 + `/ws`）→ Tauri 壳 → 安卓。
