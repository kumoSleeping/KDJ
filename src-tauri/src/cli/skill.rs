//! 把 CLI 指挥手册导出成各家 Agent 的 skill 目录。
//!
//! 导出永远是**整份覆盖**：先删掉目标 `kdj/` 再写入新的 `SKILL.md`。
//! 软件升级后用户再点一次导出，不会留下旧段落或已删除的参考文件。

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kdj_core::config::home_dir;
use serde::{Deserialize, Serialize};

const SKILL_TEMPLATE: &str = include_str!("../../skills/kdj/SKILL.md");
const SKILL_DIR_NAME: &str = "kdj";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillPreset {
    Cursor,
    Claude,
    Codex,
    Pi,
}

impl SkillPreset {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cursor => "cursor",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "cursor" => Some(Self::Cursor),
            "claude" | "claude-code" | "claudecode" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "pi" => Some(Self::Pi),
            _ => None,
        }
    }

    fn skills_root(self) -> PathBuf {
        let home = home_dir();
        match self {
            Self::Cursor => home.join(".cursor").join("skills"),
            Self::Claude => home.join(".claude").join("skills"),
            Self::Codex => home.join(".codex").join("skills"),
            Self::Pi => home.join(".pi").join("agent").join("skills"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExportResult {
    pub version: String,
    pub path: String,
    pub overwritten: bool,
}

pub fn render_skill_markdown() -> String {
    SKILL_TEMPLATE.replace("{{VERSION}}", kdj_core::VERSION)
}

/// `root` 是各家的 skills 根目录，或用户自选的文件夹。写入 `root/kdj/SKILL.md`。
pub fn export_skill_to(root: &Path) -> Result<SkillExportResult> {
    let dir = if root.file_name().is_some_and(|name| name == SKILL_DIR_NAME) {
        root.to_path_buf()
    } else {
        root.join(SKILL_DIR_NAME)
    };
    let overwritten = dir.exists();
    if overwritten {
        fs::remove_dir_all(&dir)
            .with_context(|| format!("清除旧 skill 失败：{}", dir.display()))?;
    }
    fs::create_dir_all(&dir).with_context(|| format!("创建 skill 目录失败：{}", dir.display()))?;
    let path = dir.join("SKILL.md");
    let tmp = dir.join("SKILL.md.partial");
    fs::write(&tmp, render_skill_markdown())
        .with_context(|| format!("写 skill 临时文件失败：{}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("提交 skill 失败：{}", path.display()))?;
    Ok(SkillExportResult {
        version: kdj_core::VERSION.to_string(),
        path: path.to_string_lossy().into_owned(),
        overwritten,
    })
}

pub fn export_skill_preset(preset: SkillPreset) -> Result<SkillExportResult> {
    export_skill_to(&preset.skills_root())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_replaces_the_whole_skill_directory() {
        let root = std::env::temp_dir().join(format!(
            "kdj-skill-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let stale = root.join(SKILL_DIR_NAME);
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("OLD.md"), "stale").unwrap();
        fs::write(stale.join("SKILL.md"), "old handbook").unwrap();

        let first = export_skill_to(&root).unwrap();
        assert!(first.overwritten);
        assert!(stale.join("SKILL.md").is_file());
        assert!(!stale.join("OLD.md").exists(), "旧参考文件必须清掉");
        let body = fs::read_to_string(stale.join("SKILL.md")).unwrap();
        assert!(body.contains(&format!("手册版本：`{}`", kdj_core::VERSION)));
        assert!(body.contains(&format!("更新要点（{}）", kdj_core::VERSION)));
        assert!(body.contains("`forget` 不删磁盘文件"));
        assert!(!body.contains("{{VERSION}}"));
        assert!(!body.contains("old handbook"));

        let _ = fs::remove_dir_all(&root);
    }
}
