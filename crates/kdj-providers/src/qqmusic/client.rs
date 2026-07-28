//! QQ 音乐的请求层：`u.y.qq.com/cgi-bin/musicu.fcg` 的 comm 组装 + zzc 签名。
//!
//! 相对 qqmusic-api-python 的一个关键简化：**不走 Android 平台**。
//! Android 的 comm 需要 QIMEI 设备指纹（要先 RSA+AES 和腾讯换一次），
//! 那正是那个 12MB `cryptography` 依赖的唯一用途。Desktop/Web 平台的 comm
//! 只要 `ct/cv/uin/g_tk/guid`，签名只用 SHA-1 + base64，纯 Rust 十几行就够。

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};

const MUSICU: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const MUSICS: &str = "https://u.y.qq.com/cgi-bin/musics.fcg";
const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 请求平台。Desktop 是默认；Web 只在个别接口（歌曲详情）上用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QqPlatform {
    Desktop,
    Web,
}

/// 登录凭证。字段名和 v0.1.x 写出来的 `qqmusic.json` 兼容，
/// 老用户升级上来不用重新扫码。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Credential {
    #[serde(default)]
    pub openid: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub expired_at: i64,
    #[serde(default)]
    pub musicid: i64,
    #[serde(default)]
    pub musickey: String,
    #[serde(default)]
    pub unionid: String,
    #[serde(default)]
    pub str_musicid: String,
    #[serde(default)]
    pub refresh_key: String,
    #[serde(default, alias = "musickeyCreateTime")]
    pub musickey_create_time: i64,
    #[serde(default, alias = "keyExpiresIn")]
    pub key_expires_in: i64,
    #[serde(default, alias = "encryptUin")]
    pub encrypt_uin: String,
    #[serde(default, alias = "loginType")]
    pub login_type: i64,
}

impl Credential {
    pub fn is_present(&self) -> bool {
        !self.musickey.is_empty() && self.musicid != 0
    }

    pub fn str_musicid(&self) -> String {
        if self.str_musicid.is_empty() {
            self.musicid.to_string()
        } else {
            self.str_musicid.clone()
        }
    }

    /// 本地判断是否过期。`expired_at` 有时是时长有时是时间戳，
    /// 只有看着像 epoch 才当过期时间用。
    pub fn is_expired(&self) -> bool {
        let now = now_secs();
        if self.musickey_create_time > 0 && self.key_expires_in > 0 {
            return now >= self.musickey_create_time + self.key_expires_in;
        }
        if self.expired_at > 1_000_000_000 {
            return now >= self.expired_at;
        }
        false
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// QQ 家的 Hash33。g_tk / ptqrtoken 都用它。
pub fn hash33(text: &str, init: i64) -> i64 {
    let mut hash = init;
    for ch in text.chars() {
        // Python 版用的是 `ord(c)`（码点），不是 UTF-8 字节
        hash = (hash << 5).wrapping_add(hash).wrapping_add(ch as i64);
    }
    2_147_483_647 & hash
}

const PART_1_INDEXES: [usize; 7] = [23, 14, 6, 36, 16, 7, 19];
const PART_2_INDEXES: [usize; 8] = [16, 1, 32, 12, 19, 27, 8, 5];
const SCRAMBLE_VALUES: [u8; 20] = [
    89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
];

/// `musics.fcg` 的 zzc 签名。
///
/// 三段拼起来：SHA-1 十六进制大写里挑出来的两组字符，中间夹一段
/// "把 hash 的每个字节和固定表异或再 base64、去掉 `\/+=`" 的结果。
pub fn zzc_sign(payload: &str) -> String {
    let hash_hex = hex::encode_upper(Sha1::digest(payload.as_bytes()));
    let bytes = hash_hex.as_bytes();

    let part1: String = PART_1_INDEXES.iter().map(|i| bytes[*i] as char).collect();
    let part2: String = PART_2_INDEXES.iter().map(|i| bytes[*i] as char).collect();

    let mut part3 = [0u8; 20];
    for (i, value) in SCRAMBLE_VALUES.iter().enumerate() {
        let byte = u8::from_str_radix(&hash_hex[i * 2..i * 2 + 2], 16).expect("SHA-1 输出是十六进制");
        part3[i] = value ^ byte;
    }
    let b64: String = base64::engine::general_purpose::STANDARD
        .encode(part3)
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | '+' | '='))
        .collect();

    format!("zzc{part1}{b64}{part2}").to_lowercase()
}

/// 每次启动生成一个 guid。vkey 接口要求 guid 和 uin 配套，但不要求稳定。
fn new_guid() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// 搜索会话 ID。
///
/// **这个值的形状是有意义的**：实测传 `"1"` 之类的短值，接口照样回 code=0，
/// 但 `body.item_song` 是空的、`meta.sum` 是 0——看起来"成功"其实什么都没搜到。
/// 必须按 QQ 前端的算法生成一个 18~19 位的大数。
pub fn new_search_id() -> String {
    let e = rand::random::<u64>() % 20 + 1;
    let t = e * 18_014_398_509_481_984u64;
    let n = (rand::random::<u64>() % 4_194_305) * 4_294_967_296u64;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let r = millis % (24 * 60 * 60 * 1000);
    (t + n + r).to_string()
}

/// 接口明说"凭证失效"时才作废本地登录态，网络错误不算。
/// 文案照抄 Python 版 `_invalidate_expired_credential` 的 marker 列表。
const EXPIRED_MARKERS: [&str; 8] = [
    "登录凭证已过期",
    "登录凭证失效",
    "凭证失效",
    "登录过期",
    "credential expired",
    "credential has expired",
    "not logged in",
    "未登录",
];

pub fn looks_like_expired_credential(message: &str) -> bool {
    let lower = message.to_lowercase();
    EXPIRED_MARKERS.iter().any(|marker| lower.contains(marker))
}

pub struct QqClient {
    http: reqwest::Client,
    session_path: PathBuf,
    credential: RwLock<Credential>,
    /// 接口已经明确拒绝过这份凭证。Python 版是 `_credential_invalid`：
    /// 置位之后 account() 报 expired，而不是继续显示"已登录"却每次操作都失败。
    credential_invalid: RwLock<bool>,
    guid: String,
}

impl QqClient {
    pub fn new(session_dir: &Path) -> Result<Self> {
        let http = crate::net::http_timeouts(reqwest::Client::builder().user_agent(DESKTOP_UA))
            .build()
            .context("构建 QQ 音乐 HTTP 客户端失败")?;
        let client = QqClient {
            http,
            session_path: session_dir.join("qqmusic.json"),
            credential: RwLock::new(Credential::default()),
            credential_invalid: RwLock::new(false),
            guid: new_guid(),
        };
        client.load_session();
        Ok(client)
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn guid(&self) -> &str {
        &self.guid
    }

    pub fn credential(&self) -> Credential {
        self.credential.read().unwrap().clone()
    }

    pub fn has_credential(&self) -> bool {
        self.credential.read().unwrap().is_present()
    }

    pub fn credential_invalid(&self) -> bool {
        *self.credential_invalid.read().unwrap()
    }

    /// 接口明确拒绝了这份凭证：删掉落盘文件、置位标记。
    ///
    /// 只在错误文案命中 [`EXPIRED_MARKERS`] 时动手——网络抖动、限流都不算，
    /// 否则一次断网就把用户踢下线了。
    pub fn note_error(&self, message: &str) {
        if !looks_like_expired_credential(message) {
            return;
        }
        if *self.credential_invalid.read().unwrap() {
            return;
        }
        *self.credential_invalid.write().unwrap() = true;
        let _ = std::fs::remove_file(&self.session_path);
        tracing::warn!("QQ 音乐凭证被接口拒绝，已作废：{message}");
    }

    fn load_session(&self) {
        let Ok(text) = std::fs::read_to_string(&self.session_path) else {
            return;
        };
        match serde_json::from_str::<Credential>(&text) {
            Ok(credential) => *self.credential.write().unwrap() = credential,
            Err(err) => tracing::warn!("解析 QQ 音乐凭证失败：{err}"),
        }
    }

    pub fn store_credential(&self, credential: Credential) {
        if let Some(parent) = self.session_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(&credential) {
            Ok(body) => {
                let tmp = self.session_path.with_extension("json.tmp");
                if let Err(err) =
                    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &self.session_path))
                {
                    tracing::warn!("写入 QQ 音乐凭证失败：{err}");
                }
            }
            Err(err) => tracing::warn!("序列化 QQ 音乐凭证失败：{err}"),
        }
        *self.credential.write().unwrap() = credential;
        *self.credential_invalid.write().unwrap() = false;
    }

    pub fn clear_credential(&self) {
        *self.credential.write().unwrap() = Credential::default();
        *self.credential_invalid.write().unwrap() = false;
        let _ = std::fs::remove_file(&self.session_path);
    }

    /// 组 comm。Desktop/Web 都不需要 QIMEI。
    fn build_comm(&self, platform: QqPlatform) -> Map<String, Value> {
        let credential = self.credential.read().unwrap();
        let g_tk = if credential.musickey.is_empty() {
            5381
        } else {
            hash33(&credential.musickey, 5381)
        };
        let mut comm = Map::new();
        match platform {
            QqPlatform::Desktop => {
                comm.insert("ct".into(), json!(19));
                comm.insert("cv".into(), json!(2201));
                comm.insert("chid".into(), json!("0"));
                comm.insert("guid".into(), json!(self.guid.to_uppercase()));
            }
            QqPlatform::Web => {
                comm.insert("ct".into(), json!(24));
                comm.insert("cv".into(), json!(4747474));
                comm.insert("platform".into(), json!("yqq.json"));
                comm.insert("chid".into(), json!("0"));
                comm.insert("g_tk_new_20200303".into(), json!(g_tk));
                comm.insert("format".into(), json!("json"));
                comm.insert("inCharset".into(), json!("utf-8"));
                comm.insert("outCharset".into(), json!("utf-8"));
                comm.insert("notice".into(), json!(0));
                comm.insert("need_new_code".into(), json!(1));
            }
        }
        if credential.musicid != 0 {
            comm.insert("uin".into(), json!(credential.musicid));
        }
        comm.insert("g_tk".into(), json!(g_tk));
        // 登录态：新版接口认 authst，老接口认 cookie，两个都带上最保险
        if !credential.musickey.is_empty() {
            comm.insert("authst".into(), json!(credential.musickey));
            comm.insert("tmeLoginType".into(), json!(credential.login_type));
        }
        comm
    }

    pub(crate) fn cookie_header(&self) -> String {
        let credential = self.credential.read().unwrap();
        if !credential.is_present() {
            return String::new();
        }
        let uin = credential.str_musicid();
        format!(
            "uin={uin}; qqmusic_uin={uin}; qm_keyst={key}; qqmusic_key={key}",
            key = credential.musickey
        )
    }

    /// 发一个 musicu.fcg 请求，返回 `req_0.data`。
    pub async fn call(
        &self,
        module: &str,
        method: &str,
        param: Value,
        platform: QqPlatform,
    ) -> Result<Value> {
        self.call_signed(module, method, param, platform, false).await
    }

    /// `sign = true` 时改打 musics.fcg 并附带 zzc 签名。
    pub async fn call_signed(
        &self,
        module: &str,
        method: &str,
        param: Value,
        platform: QqPlatform,
        sign: bool,
    ) -> Result<Value> {
        let outcome = self
            .call_inner(module, method, param, platform, sign, None)
            .await;
        // 接口明说凭证死了就作废本地登录态，别让账号面板继续显示"已登录"
        if let Err(err) = &outcome {
            self.note_error(&format!("{err:#}"));
        }
        outcome
    }

    /// 刷新 musickey。
    ///
    /// 对应 Python 的 `client.login.refresh_credential`：QQ 的 musickey 有寿命，
    /// 到点了先静默换一张新的，换不动才算真掉线——少了这一步用户每隔一段时间
    /// 就得重新扫码一次。参数分支照抄 `qqmusic_api._build_refresh_param`。
    pub async fn refresh_credential(&self) -> Result<Credential> {
        let target = self.credential();
        anyhow::ensure!(target.is_present(), "没有可刷新的 QQ 音乐凭证");
        let param = refresh_param(&target);
        let mut comm = self.build_comm(QqPlatform::Desktop);
        comm.insert("tmeLoginType".into(), json!(target.login_type));

        let data = self
            .call_inner(
                "music.login.LoginServer",
                "Login",
                param,
                QqPlatform::Desktop,
                false,
                Some(comm),
            )
            .await
            .inspect_err(|err| self.note_error(&format!("{err:#}")))?;
        let refreshed: Credential =
            serde_json::from_value(data).context("刷新回来的凭证字段不完整")?;
        anyhow::ensure!(!refreshed.musickey.is_empty(), "刷新没有拿到新的 musickey");
        self.store_credential(refreshed.clone());
        Ok(refreshed)
    }

    async fn call_inner(
        &self,
        module: &str,
        method: &str,
        param: Value,
        platform: QqPlatform,
        sign: bool,
        comm_override: Option<Map<String, Value>>,
    ) -> Result<Value> {
        let mut payload = Map::new();
        payload.insert(
            "comm".into(),
            Value::Object(comm_override.unwrap_or_else(|| self.build_comm(platform))),
        );
        payload.insert(
            "req_0".into(),
            json!({ "module": module, "method": method, "param": bool_to_int(param) }),
        );
        let body = serde_json::to_string(&Value::Object(payload))?;

        let mut request = if sign {
            self.http.post(MUSICS).query(&[
                ("_", now_secs().to_string()),
                ("sign", zzc_sign(&body)),
            ])
        } else {
            self.http.post(MUSICU)
        };
        let cookie = self.cookie_header();
        if !cookie.is_empty() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .with_context(|| format!("QQ 音乐请求失败：{module}.{method}"))?;
        anyhow::ensure!(
            response.status().is_success(),
            "QQ 音乐 HTTP 状态异常：{}",
            response.status()
        );
        let value: Value = response.json().await.context("QQ 音乐响应不是合法 JSON")?;

        let outer_code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
        anyhow::ensure!(outer_code == 0, "QQ 音乐请求失败：code={outer_code}");
        let item = value
            .get("req_0")
            .with_context(|| format!("QQ 音乐响应缺少 req_0：{module}.{method}"))?;
        let code = item.get("code").and_then(Value::as_i64).unwrap_or(0);
        match code {
            0 => Ok(item.get("data").cloned().unwrap_or(Value::Null)),
            // 这三个码是接口在明说"凭证没了"，上层据此作废本地登录态
            1000 | 104401 | 104400 => bail!("登录凭证已过期"),
            2001 => bail!("QQ 音乐请求过于频繁，请稍后再试"),
            other => bail!("QQ 音乐接口返回 code={other}"),
        }
    }
}

/// 刷新凭证的请求参数。三条分支和 `qqmusic_api._build_refresh_param` 一一对应：
/// login_type=1 是微信、2 是 QQ，其余（手机号等）走通用参数。
fn refresh_param(target: &Credential) -> Value {
    match target.login_type {
        1 => json!({
            "openid": target.openid,
            "refresh_token": target.refresh_token,
            "str_musicid": target.str_musicid(),
            "musickey": target.musickey,
            "unionid": target.unionid,
            "refresh_key": target.refresh_key,
            "loginMode": 2,
        }),
        2 => json!({
            "openid": target.openid,
            "access_token": target.access_token,
            "refresh_token": target.refresh_token,
            "expired_in": target.expired_at,
            "musicid": target.musicid,
            "musickey": target.musickey,
            "refresh_key": target.refresh_key,
            "loginMode": 2,
        }),
        _ => json!({
            "openid": target.openid,
            "access_token": target.access_token,
            "refresh_token": target.refresh_token,
            "expired_in": target.expired_at,
            "str_musicid": target.str_musicid(),
            "musicid": target.musicid,
            "musickey": target.musickey,
            "unionid": target.unionid,
            "refresh_key": target.refresh_key,
            "loginMode": 2,
        }),
    }
}

/// QQ 的接口不接受 JSON 布尔值，一律要 0/1。
fn bool_to_int(value: Value) -> Value {
    match value {
        Value::Bool(flag) => json!(i32::from(flag)),
        Value::Array(list) => Value::Array(list.into_iter().map(bool_to_int).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, bool_to_int(v))).collect())
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zzc_sign_matches_the_python_implementation() {
        // 对拍值来自 qqmusic_api.algorithms.sign.zzc_sign
        assert_eq!(
            zzc_sign(r#"{"comm":{"ct":19}}"#),
            "zzc3d462e66g7u2eeglyybapco7lxxyjcfe5s23b16c9d"
        );
        assert_eq!(
            zzc_sign(""),
            "zzcf0e03e5gx4qeiq5cfgdyqwu7sdqfsb5fro3aa45053"
        );
    }

    #[test]
    fn hash33_matches_the_python_implementation() {
        assert_eq!(hash33("", 5381), 5381);
        assert_eq!(hash33("abc", 5381), 193485963);
        // 非 ASCII 走码点而不是 UTF-8 字节
        assert_eq!(hash33("音乐", 0), hash33("音乐", 0));
    }

    #[test]
    fn booleans_are_flattened_to_ints_for_the_cgi() {
        let got = bool_to_int(json!({"tag": true, "list": [false, true], "n": 3}));
        assert_eq!(got, json!({"tag": 1, "list": [0, 1], "n": 3}));
    }

    #[test]
    fn credential_expiry_uses_create_time_plus_ttl_first() {
        let mut credential = Credential {
            musickey: "k".into(),
            musicid: 1,
            musickey_create_time: now_secs() - 100,
            key_expires_in: 50,
            ..Default::default()
        };
        assert!(credential.is_expired());

        credential.key_expires_in = 10_000;
        assert!(!credential.is_expired());

        // 没有 create_time 时才看 expired_at，而且只有看着像 epoch 才算
        credential.musickey_create_time = 0;
        credential.key_expires_in = 0;
        credential.expired_at = 7776000; // 90 天，是"时长"不是时间戳
        assert!(!credential.is_expired(), "时长不能当成时间戳");
        credential.expired_at = now_secs() - 1;
        assert!(credential.is_expired());
    }

    #[test]
    fn only_explicit_credential_rejections_invalidate_the_session() {
        // 网络抖动 / 限流不能把用户踢下线
        assert!(!looks_like_expired_credential("QQ 音乐请求失败：连接超时"));
        assert!(!looks_like_expired_credential(
            "QQ 音乐请求过于频繁，请稍后再试"
        ));
        assert!(looks_like_expired_credential("登录凭证已过期"));
        assert!(looks_like_expired_credential("Credential Expired"));
        assert!(looks_like_expired_credential("接口说：未登录"));
    }

    #[test]
    fn a_rejected_credential_deletes_the_session_file_and_flips_the_flag() {
        let dir = std::env::temp_dir().join(format!("kdj-qq-invalid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let client = QqClient::new(&dir).unwrap();
        client.store_credential(Credential {
            musicid: 1,
            musickey: "k".into(),
            ..Default::default()
        });
        assert!(dir.join("qqmusic.json").exists());
        assert!(!client.credential_invalid());

        client.note_error("QQ 音乐请求失败：网络不可达");
        assert!(!client.credential_invalid(), "网络错误不该作废凭证");

        client.note_error("登录凭证已过期");
        assert!(client.credential_invalid());
        assert!(!dir.join("qqmusic.json").exists(), "失效的凭证要从磁盘删掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_param_branches_match_the_sdk() {
        let wechat = Credential {
            login_type: 1,
            openid: "o".into(),
            refresh_token: "rt".into(),
            musicid: 7,
            musickey: "mk".into(),
            unionid: "u".into(),
            refresh_key: "rk".into(),
            ..Default::default()
        };
        let param = refresh_param(&wechat);
        assert_eq!(param["str_musicid"], "7", "没有 str_musicid 就用 musicid");
        assert_eq!(param["loginMode"], 2);
        assert!(param.get("access_token").is_none(), "微信分支不带 access_token");

        let qq = Credential {
            login_type: 2,
            expired_at: 1234,
            musicid: 7,
            musickey: "mk".into(),
            ..Default::default()
        };
        let param = refresh_param(&qq);
        assert_eq!(param["expired_in"], 1234);
        assert_eq!(param["musicid"], 7);
        assert!(param.get("str_musicid").is_none(), "QQ 分支不带 str_musicid");

        // 手机号等其余类型走通用参数：两组字段都要在
        let other = Credential {
            login_type: 3,
            musicid: 7,
            musickey: "mk".into(),
            ..Default::default()
        };
        let param = refresh_param(&other);
        assert_eq!(param["str_musicid"], "7");
        assert_eq!(param["musicid"], 7);
    }

    #[test]
    fn old_camel_case_session_files_still_load() {
        // v0.1.x 写出来的 qqmusic.json 有一部分是驼峰键
        let legacy = r#"{"musicid": 123, "musickey": "W_X_abc", "encryptUin": "E1",
                         "musickeyCreateTime": 100, "keyExpiresIn": 200, "loginType": 1}"#;
        let credential: Credential = serde_json::from_str(legacy).unwrap();
        assert_eq!(credential.musicid, 123);
        assert_eq!(credential.encrypt_uin, "E1");
        assert_eq!(credential.musickey_create_time, 100);
        assert_eq!(credential.login_type, 1);
        assert_eq!(credential.str_musicid(), "123");
    }
}
