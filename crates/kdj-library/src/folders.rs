//! 文件夹模式：把曲库映射到真实目录，并在真实目录上做移动 / 链接。
//!
//! 设计前提：**文件夹就是磁盘上的文件夹**，不是数据库里的虚拟分组。
//! DJ 出场前要把一套歌拷进 U 盘、要用别的软件（Rekordbox / Serato）再读一遍，
//! 虚拟分组到了那一步就没了。所以这里所有操作都落到文件系统上，
//! 数据库只是跟着改 path。
//!
//! 一首歌要同时出现在两个 set 里时用**硬链接**：同一份数据、两个路径，
//! 不额外占空间。跨卷或文件系统不支持时依次退到符号链接、真复制。
//!
//! 安全：dest 一律必须落在已配置的曲库根目录内，否则渲染进程就能借这个接口
//! 把文件挪到系统任意位置。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use kdj_core::models::{FolderNode, FolderTree};
use kdj_providers::tags::is_media_extension;

/// 每个受管目录里放一份清单文件，记这一层的**子目录显示顺序**。
///
/// 为什么是"每个目录一份"而不是"根目录一份大清单"：清单跟着文件夹走。
/// 出场前把 `温州/` 整个拷进 U 盘，顺序也一起过去了。
/// 也不存进 SQLite：数据库在应用的 userData 里，换台电脑就没了，
/// 而 DJ 的目录本来就是要跨机器搬的。
pub const MANIFEST_NAME: &str = ".kdj.json";
const MANIFEST_VERSION: i64 = 1;

/// 扫描目录树的深度上限。DJ 的歌单目录一般 1~2 层，给到 6 层足够，
/// 同时挡住 node_modules 那种病态深度把 UI 卡死。
const MAX_DEPTH: usize = 6;
/// 单个目录下的子目录上限，防止误选了一个几万条目的目录
const MAX_CHILDREN: usize = 500;

const SKIP_DIRS: [&str; 6] = [
    ".git",
    ".svn",
    "node_modules",
    "__pycache__",
    ".Trash",
    ".partial",
];

/// 和 `service::normalize_path` 完全同一套归一化。
///
/// **不能**换成 `canonicalize`：那会解析符号链接，而入库的 path 没解析过；
/// 两边规则一旦不一致，文件夹树的计数就会全落到 `outside` 里。
fn norm(path: &Path) -> PathBuf {
    PathBuf::from(crate::service::normalize_path(path))
}

fn within(child: &Path, parent: &Path) -> bool {
    child == parent || child.starts_with(parent)
}

/// 确认 dest 在某个曲库根目录里（含根目录本身），返回归一化后的绝对路径。
///
/// 没有这一步，`dest="/"` 或 `dest="../../.."` 就能把用户的音乐文件搬到任意位置。
/// 用路径分段比较而不是字符串前缀：后者会被 `/Users/me/Music-evil`
/// 这种同前缀的兄弟目录骗过去。
///
/// 归一化路径和 realpath **两道都要过**：前者挡 `..`，后者挡"曲库里放一个
/// 指向 /etc 的符号链接再往里搬文件"。只做前者会被符号链接绕过，
/// 只做后者又会和数据库里未解析的 path 对不上。
pub fn ensure_inside(dest: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let target = norm(dest);
    for root in roots {
        if !within(&target, root) {
            continue;
        }
        let real_target = std::fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
        let real_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if within(&real_target, &real_root) {
            return Ok(target);
        }
        bail!("目标目录经符号链接指到了曲库之外：{}", target.display());
    }
    bail!("目标目录不在曲库范围内：{}", target.display())
}

/// 把设置里的曲库目录变成去重、存在、已归一化的根列表。
///
/// **互相包含的只留最外层那个**：如果 `~/git/djay` 和 `~/git/djay/温州` 都在列表里，
/// 温州会在树上同时以"根"和"djay 的子节点"两个身份出现，看着像凭空多了一份。
pub fn resolve_roots(dirs: &[String]) -> Vec<PathBuf> {
    let mut seen: Vec<PathBuf> = Vec::new();
    for item in dirs {
        if item.is_empty() {
            continue;
        }
        let path = norm(Path::new(item));
        if path.is_dir() && !seen.contains(&path) {
            seen.push(path);
        }
    }
    seen.iter()
        .filter(|path| {
            !seen
                .iter()
                .any(|other| other != *path && within(path, other))
        })
        .cloned()
        .collect()
}

/// 没配曲库目录时，从已入库的路径反推根目录。
///
/// 做法是"每个存歌的目录各自往上退一层"，**不是**"取全体的最近公共祖先"：
/// 实际的库常常横跨两棵树（下载目录 + 自己的 set 目录），
/// 取公共祖先会一路退到 `~`，等于把整个家目录当曲库根——又慢又危险。
pub fn infer_roots(track_paths: &[String]) -> Vec<PathBuf> {
    let parents: std::collections::HashSet<PathBuf> = track_paths
        .iter()
        .filter(|path| !path.is_empty())
        .filter_map(|path| Path::new(path).parent().map(norm))
        .collect();
    if parents.is_empty() {
        return Vec::new();
    }

    let home = kdj_core::config::home_dir();
    let blocked: Vec<PathBuf> = [
        PathBuf::from("/"),
        home.clone(),
        home.parent().map(Path::to_path_buf).unwrap_or_default(),
        PathBuf::from("/Volumes"),
        PathBuf::from("/tmp"),
    ]
    .into_iter()
    .collect();

    let mut candidates: Vec<PathBuf> = Vec::new();
    for parent in &parents {
        let up = parent.parent().map(Path::to_path_buf);
        let pick = match up {
            // 退到家目录、/Users、/Volumes、/ 这些就不再往上
            Some(up) if !blocked.contains(&up) && up.components().count() >= 4 => up,
            _ => parent.clone(),
        };
        if !candidates.contains(&pick) {
            candidates.push(pick);
        }
    }
    candidates.sort();
    candidates
        .iter()
        .filter(|node| {
            !candidates
                .iter()
                .any(|other| other != *node && within(node, other))
        })
        .filter(|node| node.is_dir())
        .cloned()
        .collect()
}

// ------------------------------------------------------------------ 目录清单

/// 读目录里的 `.kdj.json`。读不出来一律当成空清单。
///
/// 清单只影响显示顺序，坏了不该让整棵树打不开——所以这里吞掉所有异常，
/// 最坏情况是退回按名字排序，用户看到的是"顺序被重置了"，而不是白屏。
fn read_manifest(directory: &Path) -> serde_json::Map<String, serde_json::Value> {
    let Ok(text) = std::fs::read_to_string(directory.join(MANIFEST_NAME)) else {
        return Default::default();
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => Default::default(),
    }
}

pub fn read_manifest_order(directory: &Path) -> Vec<String> {
    read_manifest(directory)
        .get("order")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 清单文件在不在。`init_manifests` 用它决定要不要补一份，
/// 判断的是**文件存在**——已经有的一律不动，哪怕内容坏了也不覆盖用户的顺序。
pub fn has_manifest(directory: &Path) -> bool {
    directory.join(MANIFEST_NAME).is_file()
}

/// 这个目录的顺序是不是"受管的"。树上的 `managed` 字段走这一条。
///
/// 判据是**清单能解析成非空对象**，不只是文件存在：清单坏掉时读出来的顺序
/// 是空的，树实际按名字排，这时报 managed=true 会让用户以为自己排的顺序丢了。
fn manifest_is_managed(directory: &Path) -> bool {
    !read_manifest(directory).is_empty()
}

pub fn write_manifest(directory: &Path, order: &[String]) {
    let payload = serde_json::json!({ "version": MANIFEST_VERSION, "order": order });
    let body = match serde_json::to_string_pretty(&payload) {
        Ok(body) => body,
        Err(err) => {
            tracing::warn!("序列化清单失败：{err}");
            return;
        }
    };
    if let Err(err) = std::fs::write(directory.join(MANIFEST_NAME), body) {
        tracing::warn!("写不了 {}：{err}", directory.join(MANIFEST_NAME).display());
    }
}

/// 这一层的子目录名，按大小写不敏感的字母序。
fn child_names(directory: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            // follow_symlinks=false：符号链接指向的目录不算子目录，
            // 否则一个指回上层的链接会让遍历无限递归
            entry
                .file_type()
                .map(|kind| kind.is_dir() && !kind.is_symlink())
                .unwrap_or(false)
        })
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names
}

/// 这一层目录里有几个音频文件（不含子目录）。
///
/// 树上要同时显示"库里有几首"和"磁盘上有几个"：两者不一致就说明这个目录还没扫过。
/// 没有这个数，用户看到的是一个空文件夹，而歌明明就在里面。
pub fn count_audio_files(directory: &Path) -> i64 {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file() && !kind.is_symlink())
                .unwrap_or(false)
        })
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            !name.starts_with('.')
                && Path::new(&name)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(is_media_extension)
        })
        .count() as i64
}

/// 按清单里的顺序排列子目录名。
///
/// 清单里有、磁盘上没有的（被删/改名了）直接丢掉；
/// 磁盘上有、清单里没有的（新建的）按名字排在后面。
/// 两边都不强行同步回文件——只有用户真的调过顺序才写盘。
pub fn apply_order(directory: &Path, listed: &[String]) -> Vec<String> {
    let actual = child_names(directory);
    let index: HashMap<&str, usize> = listed
        .iter()
        .enumerate()
        .map(|(position, name)| (name.as_str(), position))
        .collect();

    let mut known: Vec<String> = actual
        .iter()
        .filter(|name| index.contains_key(name.as_str()))
        .cloned()
        .collect();
    known.sort_by_key(|name| index[name.as_str()]);
    let fresh: Vec<String> = actual
        .into_iter()
        .filter(|name| !index.contains_key(name.as_str()))
        .collect();
    known.into_iter().chain(fresh).collect()
}

/// 给目录树里每一层补上清单文件，返回新建了几个。
///
/// 已经有清单的目录不动，不覆盖用户排好的顺序。
pub fn init_manifests(directory: &Path, roots: &[PathBuf]) -> Result<usize> {
    ensure_inside(directory, roots)?;
    Ok(init_manifests_at(directory, 0))
}

fn init_manifests_at(directory: &Path, depth: usize) -> usize {
    let mut created = 0;
    if !has_manifest(directory) {
        write_manifest(directory, &child_names(directory));
        created += 1;
    }
    if depth < MAX_DEPTH {
        for name in child_names(directory) {
            created += init_manifests_at(&directory.join(name), depth + 1);
        }
    }
    created
}

/// 按设置里的曲库目录构建文件夹树，并统计每个目录下的曲目数。
///
/// 统计走**数据库里已有的路径**而不是再扫一次磁盘：树只需要知道
/// "库里这些歌分别躺在哪"，重新遍历文件系统既慢又会把没入库的文件算进来。
pub fn build_tree(dirs: &[String], track_paths: &[String]) -> FolderTree {
    let roots = resolve_roots(dirs);
    let mut counts: HashMap<String, i64> = HashMap::new();
    for path in track_paths {
        if let Some(parent) = Path::new(path).parent() {
            *counts
                .entry(parent.to_string_lossy().into_owned())
                .or_insert(0) += 1;
        }
    }

    let mut nodes: Vec<FolderNode> = roots.iter().map(|root| walk(root, &counts, 0)).collect();
    for node in nodes.iter_mut() {
        node.is_root = true;
    }
    let inside: i64 = nodes.iter().map(|node| node.total_count).sum();
    FolderTree {
        roots: nodes,
        outside: (track_paths.len() as i64 - inside).max(0),
    }
}

fn walk(directory: &Path, counts: &HashMap<String, i64>, depth: usize) -> FolderNode {
    let listed = read_manifest_order(directory);
    let managed = manifest_is_managed(directory);
    let mut children: Vec<FolderNode> = Vec::new();
    if depth < MAX_DEPTH {
        // 顺序由目录自己的清单决定，不是字母序：DJ 的 set 目录是按演出顺序排的，
        // 按字母排会把「5月 / 6yue / 7yue」打散成毫无意义的次序。
        for name in apply_order(directory, &listed)
            .into_iter()
            .take(MAX_CHILDREN)
        {
            children.push(walk(&directory.join(name), counts, depth + 1));
        }
    }

    let direct = counts
        .get(&directory.to_string_lossy().into_owned())
        .copied()
        .unwrap_or(0);
    let files = count_audio_files(directory);
    FolderNode {
        path: directory.to_string_lossy().into_owned(),
        name: directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| directory.to_string_lossy().into_owned()),
        parent: directory
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default(),
        track_count: direct,
        file_count: files,
        // 累计计数让人一眼看出哪个分支是空的，不用一层层点开
        total_count: direct + children.iter().map(|child| child.total_count).sum::<i64>(),
        // 未入库 = 磁盘上有、库里没有。负数没有意义（库里可能还留着已删文件的记录）
        pending_count: (files - direct).max(0)
            + children
                .iter()
                .map(|child| child.pending_count)
                .sum::<i64>(),
        children,
        is_root: false,
        managed,
    }
}

// ------------------------------------------------------------------ 目录操作

fn validate_name(name: &str) -> Result<String> {
    let clean = name.trim().trim_matches('/').to_string();
    if clean.is_empty()
        || clean == "."
        || clean == ".."
        || clean.contains('/')
        || clean.contains('\\')
    {
        bail!("文件夹名不合法");
    }
    Ok(clean)
}

pub fn create_folder(parent: &Path, name: &str, roots: &[PathBuf]) -> Result<PathBuf> {
    let clean = validate_name(name)?;
    let base = ensure_inside(parent, roots)?;
    anyhow::ensure!(base.is_dir(), "上级目录不存在");
    let target = base.join(&clean);
    // 再验一次：clean 已经排除了分隔符，这里挡的是符号链接把 target 指到界外
    ensure_inside(&base, roots)?;
    anyhow::ensure!(!target.exists(), "同名文件夹已存在");
    std::fs::create_dir(&target).context("建目录失败")?;
    Ok(target)
}

pub fn rename_folder(path: &Path, name: &str, roots: &[PathBuf]) -> Result<PathBuf> {
    let clean = validate_name(name)?;
    let source = ensure_inside(path, roots)?;
    anyhow::ensure!(
        !roots.contains(&source),
        "曲库根目录不能在这里改名，去设置里改"
    );
    anyhow::ensure!(source.is_dir(), "文件夹不存在");
    let target = source.parent().context("没有上级目录")?.join(&clean);
    anyhow::ensure!(!target.exists(), "同名文件夹已存在");
    std::fs::rename(&source, &target).context("改名失败")?;
    Ok(target)
}

/// 把一整个文件夹搬进另一个文件夹，返回 `(旧路径, 新路径)`。
///
/// 三条必须挡住：根目录不能被搬；不能搬进自己或自己的子目录里（会把整棵子树搬没）；
/// 目标下同名已存在时**不合并**，直接报错——静默合并会让两批同名文件混在一起。
pub fn move_folder(
    source_path: &Path,
    dest_parent: &Path,
    roots: &[PathBuf],
) -> Result<(PathBuf, PathBuf)> {
    let source = ensure_inside(source_path, roots)?;
    let parent = ensure_inside(dest_parent, roots)?;
    anyhow::ensure!(!roots.contains(&source), "曲库根目录不能拖动，去设置里改");
    anyhow::ensure!(source.is_dir(), "文件夹不存在");
    anyhow::ensure!(parent.is_dir(), "目标不是文件夹");
    anyhow::ensure!(!within(&parent, &source), "不能把文件夹拖进它自己里面");

    let name = source.file_name().context("没有目录名")?;
    let target = parent.join(name);
    if target == source {
        return Ok((source.clone(), source));
    }
    anyhow::ensure!(
        !target.exists(),
        "「{}」下已经有同名文件夹了",
        parent.file_name().unwrap_or_default().to_string_lossy()
    );
    if std::fs::rename(&source, &target).is_err() {
        // rename 跨卷会报 EXDEV。用户完全可能把外置硬盘上的一个 set 拖进内置盘的
        // 曲库目录（两个都是已配置的曲库根），必须支持跨卷。
        move_dir_across_volumes(&source, &target)?;
    }
    Ok((source, target))
}

/// 跨卷搬目录：先整棵复制过去，**全部成功之后**才删源。
///
/// 中途失败就把半成品清掉、源目录原样留着——搬歌搬到一半两边都残缺是不可接受的。
fn move_dir_across_volumes(source: &Path, target: &Path) -> Result<()> {
    if let Err(err) = copy_dir_recursive(source, target) {
        let _ = std::fs::remove_dir_all(target);
        return Err(err.context("跨卷复制文件夹失败"));
    }
    std::fs::remove_dir_all(source).context("复制完成后删不掉源目录")
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target).with_context(|| format!("建目录失败：{}", target.display()))?;
    for entry in
        std::fs::read_dir(source).with_context(|| format!("读目录失败：{}", source.display()))?
    {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if kind.is_symlink() {
            // 符号链接照原样重建，不把它指向的内容复制一份（等同 shutil.move 的
            // symlinks=True）；跨卷时链接目标多半还在原来那个卷上，这是用户的意思。
            #[cfg(unix)]
            {
                let dest = std::fs::read_link(&from)?;
                std::os::unix::fs::symlink(dest, &to)?;
            }
            #[cfg(not(unix))]
            {
                std::fs::copy(&from, &to)?;
            }
        } else {
            std::fs::copy(&from, &to).with_context(|| format!("复制失败：{}", from.display()))?;
        }
    }
    Ok(())
}

/// 只删空目录。递归删会连带删掉音频文件，这个按钮不该有那么大的杀伤力。
pub fn delete_folder(path: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let target = ensure_inside(path, roots)?;
    anyhow::ensure!(
        !roots.contains(&target),
        "曲库根目录不能在这里删除，去设置里移除"
    );
    anyhow::ensure!(target.is_dir(), "文件夹不存在");
    std::fs::remove_dir(&target).context("文件夹非空或删不掉")?;
    Ok(target)
}

// ------------------------------------------------------------------ 文件操作

/// 同名时加 ` (2)`、` (3)`…… **不覆盖**已有文件。
///
/// 覆盖同名文件是不可逆的：DJ 的两个 set 里同名不同 mix 的文件很常见
/// （`Track - Artist.mp3` 可能是 radio edit 也可能是 extended），
/// 静默覆盖会直接丢掉一首歌。
pub fn unique_target(directory: &Path, filename: &str) -> Result<PathBuf> {
    let target = directory.join(filename);
    if !target.exists() {
        return Ok(target);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let suffix = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..1000 {
        let candidate = directory.join(format!("{stem} ({index}){suffix}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    bail!("目标目录里同名文件太多")
}

pub fn move_file(source: &Path, directory: &Path) -> Result<PathBuf> {
    let name = source
        .file_name()
        .context("源文件没有文件名")?
        .to_string_lossy()
        .into_owned();
    let target = unique_target(directory, &name)?;
    // rename 跨卷会报 EXDEV，退回"复制 + 删除"。
    // 用户完全可能把外置硬盘上的歌拖进内置盘的文件夹里，必须支持跨卷。
    if std::fs::rename(source, &target).is_err() {
        std::fs::copy(source, &target).context("跨卷复制失败")?;
        std::fs::remove_file(source).context("复制后删除源文件失败")?;
    }
    Ok(target)
}

/// 优先硬链接，退符号链接，再退真复制。返回 `(目标路径, 实际用的方式)`。
pub fn link_file(source: &Path, directory: &Path) -> Result<(PathBuf, &'static str)> {
    let name = source
        .file_name()
        .context("源文件没有文件名")?
        .to_string_lossy()
        .into_owned();
    let target = unique_target(directory, &name)?;

    #[cfg(unix)]
    {
        if std::fs::hard_link(source, &target).is_ok() {
            return Ok((target, "hardlink"));
        }
        if std::os::unix::fs::symlink(source, &target).is_ok() {
            return Ok((target, "symlink"));
        }
    }
    #[cfg(windows)]
    {
        if std::fs::hard_link(source, &target).is_ok() {
            return Ok((target, "hardlink"));
        }
        // Windows 建符号链接要管理员权限或开发者模式，失败很正常，直接退复制
        if std::os::windows::fs::symlink_file(source, &target).is_ok() {
            return Ok((target, "symlink"));
        }
    }
    std::fs::copy(source, &target).context("复制失败")?;
    Ok((target, "copy"))
}

/// 这个文件是不是某个链接的一端。前端据此在列表里打个链接标记。
///
/// `nlink > 1` 只说明"同一份数据有多个名字"，看不出另一个名字在哪，
/// 但对用户要回答的问题（"这首为什么出现两次？"）已经够了。
pub fn link_state(path: &Path) -> String {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return String::new();
    };
    if meta.file_type().is_symlink() {
        return "symlink".to_string();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if meta.nlink() > 1 {
            return "hardlink".to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kdj-folders-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // canonicalize 一次，免得 macOS 上 /var 与 /private/var 的差异干扰包含性判断
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn containment_blocks_escapes() {
        let root = scratch("contain");
        let roots = vec![root.clone()];
        assert!(ensure_inside(&root.join("sub"), &roots).is_ok());
        assert!(ensure_inside(&root, &roots).is_ok(), "根目录自己也算在内");
        assert!(ensure_inside(Path::new("/etc"), &roots).is_err());
        assert!(ensure_inside(&root.join("../.."), &roots).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn containment_is_not_fooled_by_a_sibling_with_the_same_prefix() {
        // 字符串前缀比较会把 Music-evil 当成 Music 的子目录
        let base = scratch("prefix");
        let root = base.join("Music");
        let evil = base.join("Music-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        let roots = vec![root];
        assert!(ensure_inside(&evil, &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_outside_the_library_is_rejected() {
        let base = scratch("symlink");
        let root = base.join("lib");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        let roots = vec![root.clone()];
        // 词法上 lib/escape 在 lib 里，但 realpath 指到了界外
        assert!(ensure_inside(&root.join("escape"), &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn nested_roots_collapse_to_the_outermost() {
        let base = scratch("roots");
        let outer = base.join("djay");
        let inner = outer.join("wenzhou");
        std::fs::create_dir_all(&inner).unwrap();

        let roots = resolve_roots(&[
            outer.to_string_lossy().into_owned(),
            inner.to_string_lossy().into_owned(),
        ]);
        assert_eq!(roots, vec![outer], "内层根会让同一批歌在树上出现两次");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_directories_are_dropped_from_roots() {
        let base = scratch("missing-root");
        let roots = resolve_roots(&[
            base.to_string_lossy().into_owned(),
            base.join("nope").to_string_lossy().into_owned(),
            String::new(),
        ]);
        assert_eq!(roots, vec![base.clone()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn manifest_roundtrips_and_bad_json_degrades_to_empty() {
        let dir = scratch("manifest");
        assert!(!has_manifest(&dir));
        write_manifest(&dir, &["b".into(), "a".into()]);
        assert!(has_manifest(&dir));
        assert_eq!(read_manifest_order(&dir), vec!["b", "a"]);

        // 坏清单不该让整棵树打不开
        std::fs::write(dir.join(MANIFEST_NAME), "{ not json").unwrap();
        assert_eq!(read_manifest_order(&dir), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_order_keeps_listed_first_and_new_ones_after() {
        let dir = scratch("order");
        for name in ["5月", "6yue", "7yue", "brand-new"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        // 清单里还列了一个已经被删掉的目录
        let listed = vec![
            "7yue".to_string(),
            "5月".to_string(),
            "deleted".to_string(),
            "6yue".to_string(),
        ];
        let ordered = apply_order(&dir, &listed);
        assert_eq!(
            ordered,
            vec!["7yue", "5月", "6yue", "brand-new"],
            "清单顺序优先，新目录排后面，已删的丢掉"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_and_noisy_directories_are_skipped() {
        let dir = scratch("skip");
        for name in [".hidden", "node_modules", ".git", "real"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        assert_eq!(child_names(&dir), vec!["real"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_files_are_counted_by_extension_only_at_this_level() {
        let dir = scratch("count");
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        std::fs::write(dir.join("b.flac"), b"x").unwrap();
        std::fs::write(dir.join("c.txt"), b"x").unwrap();
        std::fs::write(dir.join(".hidden.mp3"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/d.mp3"), b"x").unwrap();

        assert_eq!(
            count_audio_files(&dir),
            2,
            "只数本层、只数音频、跳过隐藏文件"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_files_count_as_library_media() {
        // 树上的"磁盘有几个"必须和扫描认的后缀是同一份，否则待入库数永远清不掉
        let dir = scratch("count-video");
        std::fs::write(dir.join("a.mkv"), b"x").unwrap();
        std::fs::write(dir.join("b.mov"), b"x").unwrap();
        std::fs::write(dir.join("c.mp3"), b"x").unwrap();
        std::fs::write(dir.join("d.jpg"), b"x").unwrap();
        assert_eq!(count_audio_files(&dir), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_manifest_is_not_reported_as_managed() {
        // 清单坏掉时树实际按名字排；这时报 managed=true 会让用户以为自己排的顺序丢了
        let base = scratch("managed");
        let root = base.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(MANIFEST_NAME), "{ not json").unwrap();

        let tree = build_tree(&[root.to_string_lossy().into_owned()], &[]);
        assert!(!tree.roots[0].managed, "坏清单不算受管");

        write_manifest(&root, &[]);
        let tree = build_tree(&[root.to_string_lossy().into_owned()], &[]);
        assert!(tree.roots[0].managed, "写过清单就是受管");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cross_volume_move_copies_the_whole_tree_then_drops_the_source() {
        // 真跨卷没法在测试里造，直接验搬运本身：整棵树过去、源目录清干净
        let base = scratch("xdev");
        let source = base.join("set1");
        std::fs::create_dir_all(source.join("sub")).unwrap();
        std::fs::write(source.join("a.mp3"), b"aaa").unwrap();
        std::fs::write(source.join("sub/b.mp3"), b"bbb").unwrap();

        let target = base.join("moved");
        move_dir_across_volumes(&source, &target).unwrap();

        assert!(!source.exists(), "源目录要清掉");
        assert_eq!(std::fs::read(target.join("a.mp3")).unwrap(), b"aaa");
        assert_eq!(std::fs::read(target.join("sub/b.mp3")).unwrap(), b"bbb");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tree_counts_roll_up_and_report_pending() {
        let base = scratch("tree");
        let root = base.join("lib");
        let set = root.join("set1");
        std::fs::create_dir_all(&set).unwrap();
        // 磁盘上两个文件，库里只有一个 → pending = 1
        std::fs::write(set.join("a.mp3"), b"x").unwrap();
        std::fs::write(set.join("b.mp3"), b"x").unwrap();

        let tree = build_tree(
            &[root.to_string_lossy().into_owned()],
            &[set.join("a.mp3").to_string_lossy().into_owned()],
        );
        assert_eq!(tree.roots.len(), 1);
        let root_node = &tree.roots[0];
        assert!(root_node.is_root);
        assert_eq!(root_node.total_count, 1, "累计到根");
        assert_eq!(root_node.track_count, 0, "根目录本层没有歌");
        assert_eq!(root_node.pending_count, 1, "磁盘 2 个、库里 1 个");
        assert_eq!(tree.outside, 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tracks_outside_every_root_are_counted_as_outside() {
        let base = scratch("outside");
        let root = base.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let tree = build_tree(
            &[root.to_string_lossy().into_owned()],
            &["/somewhere/else/a.mp3".to_string()],
        );
        assert_eq!(tree.outside, 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unique_target_never_overwrites() {
        let dir = scratch("unique");
        std::fs::write(dir.join("song.mp3"), b"first").unwrap();
        let target = unique_target(&dir, "song.mp3").unwrap();
        assert_eq!(target.file_name().unwrap(), "song (2).mp3");

        std::fs::write(&target, b"second").unwrap();
        let third = unique_target(&dir, "song.mp3").unwrap();
        assert_eq!(third.file_name().unwrap(), "song (3).mp3");
        // 原文件必须原封不动
        assert_eq!(std::fs::read(dir.join("song.mp3")).unwrap(), b"first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_names_are_validated() {
        assert!(validate_name("正常").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
    }

    #[test]
    fn a_folder_cannot_be_moved_into_itself() {
        let base = scratch("move-self");
        let root = base.join("lib");
        let set = root.join("set1");
        let sub = set.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let roots = vec![root];

        let err = move_folder(&set, &sub, &roots).unwrap_err().to_string();
        assert!(err.contains("它自己"), "{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn moving_onto_an_existing_name_refuses_instead_of_merging() {
        let base = scratch("move-clash");
        let root = base.join("lib");
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(a.join("set")).unwrap();
        std::fs::create_dir_all(b.join("set")).unwrap();
        let roots = vec![root];

        let err = move_folder(&a.join("set"), &b, &roots)
            .unwrap_err()
            .to_string();
        assert!(err.contains("同名"), "{err}");
        // 两边都还在，没被静默合并
        assert!(a.join("set").is_dir());
        assert!(b.join("set").is_dir());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn roots_are_protected_from_rename_move_and_delete() {
        let base = scratch("root-guard");
        let root = base.join("lib");
        std::fs::create_dir_all(root.join("other")).unwrap();
        let roots = vec![root.clone()];

        assert!(rename_folder(&root, "new", &roots).is_err());
        assert!(delete_folder(&root, &roots).is_err());
        assert!(move_folder(&root, &root.join("other"), &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_only_removes_empty_folders() {
        let base = scratch("delete");
        let root = base.join("lib");
        let empty = root.join("empty");
        let full = root.join("full");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("a.mp3"), b"x").unwrap();
        let roots = vec![root];

        assert!(delete_folder(&empty, &roots).is_ok());
        assert!(!empty.exists());
        assert!(delete_folder(&full, &roots).is_err(), "非空目录不能删");
        assert!(full.join("a.mp3").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn link_file_prefers_a_hard_link_and_reports_it() {
        let base = scratch("link");
        let source_dir = base.join("src");
        let dest_dir = base.join("dst");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        let source = source_dir.join("song.mp3");
        std::fs::write(&source, b"audio").unwrap();

        let (target, method) = link_file(&source, &dest_dir).unwrap();
        assert_eq!(method, "hardlink");
        assert_eq!(std::fs::read(&target).unwrap(), b"audio");
        // 两端都应当被标记成链接
        assert_eq!(link_state(&source), "hardlink");
        assert_eq!(link_state(&target), "hardlink");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_plain_file_has_no_link_state() {
        let dir = scratch("plain");
        let path = dir.join("a.mp3");
        std::fs::write(&path, b"x").unwrap();
        assert_eq!(link_state(&path), "");
        assert_eq!(link_state(&dir.join("missing.mp3")), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_manifests_does_not_overwrite_existing_order() {
        let base = scratch("init");
        let root = base.join("lib");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        write_manifest(&root, &["b".into(), "a".into()]);
        let roots = vec![root.clone()];

        let created = init_manifests(&root, &roots).unwrap();
        assert_eq!(created, 2, "只给 a、b 两个子目录新建");
        assert_eq!(read_manifest_order(&root), vec!["b", "a"], "已有顺序不动");
        let _ = std::fs::remove_dir_all(&base);
    }
}
