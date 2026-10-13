//! Current-account identity only. Never treat arbitrary menu labels as a user name.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

use super::auth::BrowserSession;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AccountProfile {
    pub nickname: String,
    pub avatar: String,
}

fn text(value: &Value) -> Option<String> {
    let result = if let Some(text) = value.as_str().or_else(|| value["simpleText"].as_str()) {
        text.to_owned()
    } else {
        value["runs"]
            .as_array()?
            .iter()
            .filter_map(|run| run["text"].as_str())
            .collect::<String>()
    };
    let result = result.trim();
    (!result.is_empty()).then(|| result.to_owned())
}

impl AccountProfile {
    pub fn from_menu(body: &Value) -> Result<Self> {
        // Both live WEB_REMIX and WEB responses use this header. Menu items and account
        // switcher entries must never be searched as fallbacks for the active identity.
        let header = body["actions"].as_array().into_iter().flatten().find_map(|action| {
            action.pointer("/openPopupAction/popup/multiPageMenuRenderer/header/activeAccountHeaderRenderer")
        }).context("账号菜单缺少当前账号资料")?;
        let nickname = text(&header["accountName"]).context("账号菜单缺少真实用户名")?;
        let avatar = header
            .pointer("/accountPhoto/thumbnails")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|thumbnail| {
                let raw = thumbnail["url"].as_str()?;
                let url = if raw.starts_with("//") {
                    format!("https:{raw}")
                } else {
                    raw.to_owned()
                };
                let parsed = url::Url::parse(&url).ok()?;
                (parsed.scheme() == "https"
                    && parsed.host_str().is_some()
                    && parsed.username().is_empty()
                    && parsed.password().is_none())
                .then(|| (thumbnail["width"].as_u64().unwrap_or(0), url))
            })
            .max_by_key(|(width, _)| *width)
            .map(|(_, url)| url)
            .unwrap_or_default();
        Ok(Self { nickname, avatar })
    }
}

fn binding(session: &BrowserSession) -> String {
    let mut hash = Sha256::new();
    hash.update(session.cookie.as_bytes());
    hash.update([0]);
    hash.update(session.x_goog_authuser.as_bytes());
    hex::encode(hash.finalize())
}

pub(super) fn load(path: &Path, session: &BrowserSession) -> Option<AccountProfile> {
    let document: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if document["session_binding"].as_str()? != binding(session) {
        return None;
    }
    serde_json::from_value(document["profile"].clone()).ok()
}

/// This derived cache is separate from credentials: refreshing identity never rewrites a
/// login document. Preserve unknown cache fields, and don't write unchanged information.
pub(super) fn save(path: &Path, session: &BrowserSession, profile: &AccountProfile) -> Result<()> {
    let mut document: Value = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("账号资料缓存无法无损读取，未覆盖")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    let before = document.clone();
    let object = document
        .as_object_mut()
        .context("账号资料缓存格式无效，未覆盖")?;
    object.insert("session_binding".into(), Value::String(binding(session)));
    let existing = object.entry("profile").or_insert_with(|| json!({}));
    let fields = existing
        .as_object_mut()
        .context("账号资料字段格式无效，未覆盖")?;
    fields.insert("nickname".into(), Value::String(profile.nickname.clone()));
    fields.insert("avatar".into(), Value::String(profile.avatar.clone()));
    if document != before {
        crate::session_fs::write_private_atomic(path, &serde_json::to_vec_pretty(&document)?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn menu(header: Value) -> Value {
        json!({"actions":[{"openPopupAction":{"popup":{"multiPageMenuRenderer":{"header":{
            "activeAccountHeaderRenderer":header
        }}}}}]})
    }

    #[test]
    fn account_profile_reads_live_music_and_video_shapes() {
        for name in [
            json!({"runs":[{"text":"真实"},{"text":"名字"}]}),
            json!({"simpleText":"真实名字"}),
        ] {
            let profile = AccountProfile::from_menu(&menu(json!({
                "accountName":name,
                "accountPhoto":{"thumbnails":[{"url":"https://yt3.ggpht.com/small","width":32},
                    {"url":"//yt3.ggpht.com/large","width":96}]}
            })))
            .unwrap();
            assert_eq!(profile.nickname, "真实名字");
            assert_eq!(profile.avatar, "https://yt3.ggpht.com/large");
        }
    }

    #[test]
    fn account_profile_rejects_menu_labels_and_unsafe_photos() {
        assert!(AccountProfile::from_menu(
            &json!({"name":"Chrome", "accountName":"other account"})
        )
        .is_err());
        assert!(AccountProfile::from_menu(&menu(json!({"name":"Settings"}))).is_err());
        let profile = AccountProfile::from_menu(&menu(json!({"accountName":{"simpleText":"User"},
            "accountPhoto":{"thumbnails":[{"url":"javascript:alert(1)"}]}})))
        .unwrap();
        assert!(profile.avatar.is_empty());
    }

    #[test]
    fn account_profile_cache_preserves_unknown_fields_and_is_bound_to_session() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("profile.json");
        std::fs::write(&path, r#"{"future":true,"profile":{"future_name":"keep"}}"#).unwrap();
        let session = BrowserSession::from_cookie_header("SAPISID=test", "Test").unwrap();
        let profile = AccountProfile {
            nickname: "User".into(),
            avatar: "https://yt3.ggpht.com/photo".into(),
        };
        save(&path, &session, &profile).unwrap();
        assert_eq!(load(&path, &session), Some(profile.clone()));
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["future"], true);
        assert_eq!(saved["profile"]["future_name"], "keep");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        save(&path, &session, &profile).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        let mut other = session.clone();
        other.x_goog_authuser = "1".into();
        assert!(load(&path, &other).is_none());
        other = BrowserSession::from_cookie_header("SAPISID=other", "Test").unwrap();
        assert!(load(&path, &other).is_none());
        std::fs::write(&path, b"invalid").unwrap();
        assert!(save(&path, &session, &profile).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid");
    }
}
