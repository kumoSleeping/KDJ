//! 文件名净化 / 模板渲染 / 路径包含性检查。
//!
//! 直译自 `sidecar/kumodeck/providers/base.py`，两处细节不能简化：
//! 1. 文件名按**字节**截断（中文一个字 3 字节，按字符截断会超出文件系统 NAME_MAX），
//!    截断后可能切碎多字节字符，要一路退到能解码为止。
//! 2. 扩展名只保留字母数字，空了就用兜底扩展名。

use std::path::{Component, Path, PathBuf};

/// 文件系统单个文件名的字节上限。Python 版是 `os.pathconf(dir, "PC_NAME_MAX")`，
/// 主流文件系统（APFS/ext4/NTFS）都是 255，这里直接取常量。
const NAME_MAX: usize = 255;

/// 去掉路径分隔符和 Windows 非法字符，压平空白。
pub fn sanitize_filename_value(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | '*' | '?' | ':' | '"' | '<' | '>' | '|' | '\r' | '\n' | '\t'))
        .collect();
    // 连续空白压成一个空格
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == ' ');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_ext(ext: &str, fallback: &str) -> String {
    let kept: String = ext
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if kept.is_empty() {
        fallback.to_string()
    } else {
        kept.to_ascii_lowercase()
    }
}

/// 净化文件名并按字节截断到 NAME_MAX。
pub fn finalize_filename(filename: &str, fallback_ext: &str) -> String {
    let raw_name = Path::new(filename)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string());
    let (stem, ext) = match raw_name.rfind('.') {
        Some(idx) if idx > 0 => (&raw_name[..idx], &raw_name[idx..]),
        _ => (raw_name.as_str(), ""),
    };
    let mut safe_stem = sanitize_filename_value(stem, "track");
    let safe_ext = sanitize_ext(ext, fallback_ext);
    let ext_part = if safe_ext.is_empty() {
        String::new()
    } else {
        format!(".{safe_ext}")
    };

    let max_stem_bytes = NAME_MAX.saturating_sub(ext_part.len()).max(1);
    if safe_stem.len() > max_stem_bytes {
        // 退到最近的字符边界，别切碎多字节字符
        let mut cut = max_stem_bytes;
        while cut > 0 && !safe_stem.is_char_boundary(cut) {
            cut -= 1;
        }
        safe_stem.truncate(cut);
    }
    let trimmed = safe_stem.trim_end_matches(['.', ' ']);
    let stem = if trimmed.is_empty() { "track" } else { trimmed };
    format!("{stem}{ext_part}")
}

/// 按用户模板渲染文件名。
///
/// 支持的占位符和 Python 版一致：`{title} {artist} {artists} {album} {track} {id}`。
/// 模板里写了不认识的占位符时**不能**让整单下载失败——退回 `标题 - 艺人`。
pub fn render_filename(
    template: &str,
    title: &str,
    artists: &str,
    album: &str,
    key: &str,
    ext: &str,
) -> String {
    let safe_title = sanitize_filename_value(title, "Unknown");
    let safe_artists = sanitize_filename_value(artists, "Unknown");
    let safe_album = sanitize_filename_value(album, "");
    let safe_ext = sanitize_ext(ext, "mp3");

    let rendered = match expand_template(
        template,
        &[
            ("title", &safe_title),
            ("artist", &safe_artists),
            ("artists", &safe_artists),
            ("album", &safe_album),
            ("track", &safe_title),
            ("id", key),
        ],
    ) {
        Some(text) => text,
        None => format!("{safe_title} - {safe_artists}"),
    };
    finalize_filename(&format!("{rendered}.{safe_ext}"), "mp3")
}

/// 展开 `{name}` 占位符。遇到未知占位符或不成对的花括号返回 None（调用方退回默认模板）。
fn expand_template(template: &str, vars: &[(&str, &str)]) -> Option<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('}')?;
        let name = &after[..end];
        let value = vars.iter().find(|(key, _)| *key == name).map(|(_, v)| *v)?;
        out.push_str(value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// 归一化路径：展开 `.`/`..`，不触碰文件系统。
///
/// `std::fs::canonicalize` 要求路径已存在，而"新建文件夹"这类操作在检查时目标还不存在，
/// 所以包含性检查要用这个纯词法版本 **加上** 对已存在父目录的 realpath 校验。
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `child` 是否落在 `root` 之内（含相等）。词法比较，调用方要先各自 normalize。
pub fn is_within(root: &Path, child: &Path) -> bool {
    let root = normalize_path(root);
    let child = normalize_path(child);
    child == root || child.starts_with(&root)
}

/// 包含性检查的完整版：先词法归一，再对**已存在的最近祖先**做 realpath，
/// 防止用软链接绕出曲库根。
///
/// 返回归一化后的绝对路径；越界返回 None。
pub fn contain_within_roots(roots: &[PathBuf], candidate: &Path) -> Option<PathBuf> {
    let target = normalize_path(candidate);
    if !target.is_absolute() {
        return None;
    }
    let real_target = resolve_existing_prefix(&target);
    for root in roots {
        let root_norm = normalize_path(root);
        let real_root = std::fs::canonicalize(&root_norm).unwrap_or(root_norm.clone());
        if is_within(&root_norm, &target) && is_within(&real_root, &real_target) {
            return Some(target);
        }
    }
    None
}

/// 对路径中"已经存在的那一段"做 realpath，剩下还不存在的部分原样接回去。
fn resolve_existing_prefix(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&existing) {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match existing.file_name() {
            Some(name) => {
                tail.push(name.to_os_string());
                if !existing.pop() {
                    return path.to_path_buf();
                }
            }
            None => return path.to_path_buf(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_path_separators_and_reserved_characters() {
        assert_eq!(sanitize_filename_value("a/b\\c:d*e?f", "x"), "abcdef");
        assert_eq!(sanitize_filename_value("  ...  ", "fallback"), "fallback");
        // 制表符先被当作非法字符删掉、再压空白，所以 "b\tc" 会粘成 "bc"——
        // 和 Python 版 `re.sub(非法字符)` → `re.sub(\s+)` 的顺序一致，不是 bug。
        assert_eq!(sanitize_filename_value("a   b\tc", "x"), "a bc");
    }

    #[test]
    fn truncates_by_bytes_not_characters() {
        // 中文一个字 3 字节：85 个字 = 255 字节，加上 ".mp3" 必然要截
        let long = "曲".repeat(200);
        let name = finalize_filename(&format!("{long}.mp3"), "mp3");
        assert!(name.len() <= NAME_MAX, "实际 {} 字节", name.len());
        assert!(name.ends_with(".mp3"));
        // 关键：截断后仍然是合法 UTF-8（没有切碎多字节字符）
        assert!(std::str::from_utf8(name.as_bytes()).is_ok());
        assert!(!name.contains('\u{fffd}'));
    }

    #[test]
    fn keeps_extension_lowercase_and_alphanumeric() {
        assert_eq!(finalize_filename("song.FLAC", "mp3"), "song.flac");
        assert_eq!(finalize_filename("song.m p3!", "mp3"), "song.mp3");
        assert_eq!(finalize_filename("song", "flac"), "song.flac");
    }

    #[test]
    fn unknown_placeholder_falls_back_instead_of_failing() {
        let name = render_filename("{title} [{bogus}]", "T", "A", "Al", "1", "mp3");
        assert_eq!(name, "T - A.mp3");
    }

    #[test]
    fn renders_the_default_template() {
        let name = render_filename("{title} - {artist}", "夜曲", "周杰伦", "十一月的萧邦", "1", "flac");
        assert_eq!(name, "夜曲 - 周杰伦.flac");
    }

    #[test]
    fn normalize_resolves_dot_segments_without_touching_disk() {
        assert_eq!(
            normalize_path(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn is_within_rejects_sibling_prefix_collisions() {
        assert!(is_within(Path::new("/lib/set"), Path::new("/lib/set/a.mp3")));
        assert!(is_within(Path::new("/lib/set"), Path::new("/lib/set")));
        // "/lib/set2" 不在 "/lib/set" 里，字符串前缀匹配会误判，Path::starts_with 不会
        assert!(!is_within(Path::new("/lib/set"), Path::new("/lib/set2/a.mp3")));
    }

    #[test]
    fn containment_rejects_escape_via_dotdot() {
        let root = std::env::temp_dir().join("kumodeck-contain-test");
        std::fs::create_dir_all(&root).unwrap();
        let roots = vec![root.clone()];
        assert!(contain_within_roots(&roots, &root.join("inside/new.mp3")).is_some());
        assert!(contain_within_roots(&roots, &root.join("../outside.mp3")).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
