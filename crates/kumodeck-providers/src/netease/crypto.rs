//! 网易云的两套请求加密：weapi（非对称）和 eapi（对称）。
//!
//! 常量与算法逐字搬自 pyncm 的 `pyncm/utils/crypto.py`，服务端对格式非常挑剔，
//! 任何"看起来更干净"的改动（比如去掉 base64 换行、改 padding）都会让接口直接 460。
//! 本模块的测试用的是从 pyncm 真机跑出来的 golden 向量，改动必须先过这些断言。

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyInit, KeyIvInit};
use base64::Engine as _;
use md5::{Digest, Md5};
use num_bigint::BigUint;
use rand::Rng;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes128EcbEnc = ecb::Encryptor<aes::Aes128>;
type Aes128EcbDec = ecb::Decryptor<aes::Aes128>;

/// weapi 第一段 AES 的固定密钥 / IV（AES-128-CBC）
const WEAPI_AES_KEY: &[u8; 16] = b"0CoJUm6Qyw8W8jud";
const WEAPI_AES_IV: &[u8; 16] = b"0102030405060708";
/// eapi 的固定密钥（AES-128-ECB）
const EAPI_AES_KEY: &[u8; 16] = b"e82ckenh8dichen8";

/// 教科书 RSA（无 padding），modulus 1024 位、e = 65537
const WEAPI_RSA_MODULUS_HEX: &str = concat!(
    "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725",
    "152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312",
    "ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424",
    "d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7"
);
const WEAPI_RSA_EXPONENT: u32 = 0x10001;

/// pyncm 的 `RandomString` 用的字符集，第二把 AES 密钥就从这里取 16 个字符。
const BASE62: &[u8] = b"PJArHa0dpwhvMNYqKnTbitWfEmosQ9527ZBx46IXUgOzD81VuSFyckLRljG3eC";

/// weapi 请求体：`params` + `encSecKey`，两个都是表单字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeapiPayload {
    pub params: String,
    pub enc_sec_key: String,
}

pub fn random_secret_key() -> String {
    let mut rng = rand::thread_rng();
    (0..16)
        .map(|_| BASE62[rng.gen_range(0..BASE62.len())] as char)
        .collect()
}

/// Python `base64.encodebytes`：每 76 个字符插一个换行，并且**结尾也有换行**。
///
/// 这不是可有可无的格式细节——pyncm 就是这么发出去的，服务端接受的也是这个形状。
fn encode_bytes_mime(data: &[u8]) -> String {
    let raw = base64::engine::general_purpose::STANDARD.encode(data);
    let mut out = String::with_capacity(raw.len() + raw.len() / 76 + 2);
    for chunk in raw.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).expect("base64 是 ASCII"));
        out.push('\n');
    }
    if out.is_empty() {
        out.push('\n');
    }
    out
}

fn aes_cbc_encrypt(data: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Vec<u8> {
    Aes128CbcEnc::new(key.into(), iv.into()).encrypt_padded_vec_mut::<Pkcs7>(data)
}

fn aes_ecb_encrypt(data: &[u8], key: &[u8; 16]) -> Vec<u8> {
    Aes128EcbEnc::new(key.into()).encrypt_padded_vec_mut::<Pkcs7>(data)
}

/// 教科书 RSA：把密钥字符串**反转**后按大端整数取幂，输出定长 128 字节。
fn rsa_encrypt(data: &str) -> Vec<u8> {
    let reversed: String = data.chars().rev().collect();
    let m = BigUint::from_bytes_be(reversed.as_bytes());
    let n = BigUint::parse_bytes(WEAPI_RSA_MODULUS_HEX.as_bytes(), 16).expect("模数是合法十六进制");
    let e = BigUint::from(WEAPI_RSA_EXPONENT);
    let cipher = m.modpow(&e, &n);
    // 必须左侧补零到 128 字节：pyncm 是 `hex(r)[2:].zfill(256)`，
    // 结果小于模数时前导零不能丢，否则服务端解出来的密钥整体错位。
    let bytes = cipher.to_bytes_be();
    let mut out = vec![0u8; 128usize.saturating_sub(bytes.len())];
    out.extend_from_slice(&bytes);
    out
}

/// weapi 加密。`secret` 传 None 时随机生成（生产用），传 Some 用于可复现测试。
pub fn weapi_encrypt(plain: &str, secret: Option<&str>) -> WeapiPayload {
    let key2 = secret.map(str::to_string).unwrap_or_else(random_secret_key);
    // 第一遍：固定密钥
    let first = encode_bytes_mime(&aes_cbc_encrypt(plain.as_bytes(), WEAPI_AES_KEY, WEAPI_AES_IV));
    // 第二遍：拿第一遍的 base64 文本（含换行）再加密一次
    let key2_bytes: [u8; 16] = key2.as_bytes().try_into().expect("密钥恒为 16 字节");
    let second = encode_bytes_mime(&aes_cbc_encrypt(first.as_bytes(), &key2_bytes, WEAPI_AES_IV));
    WeapiPayload {
        params: second,
        enc_sec_key: hex::encode(rsa_encrypt(&key2)),
    }
}

fn md5_hex(text: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

/// eapi 加密。`url` 要用 `/api/...` 形式（不是 `/eapi/...`）。
pub fn eapi_encrypt(url: &str, plain: &str) -> String {
    let digest = md5_hex(&format!("nobody{url}use{plain}md5forencrypt"));
    let body = format!("{url}-36cd479b6b5-{plain}-36cd479b6b5-{digest}");
    hex::encode(aes_ecb_encrypt(body.as_bytes(), EAPI_AES_KEY))
}

/// eapi 响应解密。
///
/// 返回 None 表示"这段内容不是 eapi 密文"——有些端点直接回明文 JSON，
/// 调用方应当退回按明文解析，而不是把整个请求判失败。
pub fn eapi_decrypt(cipher: &[u8]) -> Option<String> {
    if cipher.is_empty() || cipher.len() % 16 != 0 {
        return None;
    }
    let plain = Aes128EcbDec::new(EAPI_AES_KEY.into())
        .decrypt_padded_vec_mut::<Pkcs7>(cipher)
        .ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 从 pyncm 真机跑出来的输入
    const PLAIN: &str =
        r#"{"ids": "[347230]", "level": "lossless", "encodeType": "flac", "csrf_token": ""}"#;
    const SECRET: &str = "0123456789abcdef";

    #[test]
    fn weapi_matches_pyncm_golden_vector() {
        let got = weapi_encrypt(PLAIN, Some(SECRET));
        assert_eq!(
            got.params,
            "0Wz9+UFtS2GP86bhsoF4efsaDMJk9h1EWgdSuLxa0KU+6Tt2DKpJCDC6a+o6cvaDBz4lPp7oHI0l\n\
             YR0XhikDAkAu3kj/qRY2LU/cS2+mjivLSFUzhZMrHwUtrQ3cHqspQWjOELsbpsy2C8RWahVIe+lE\n\
             QfdPvi9frWF6LrTClaKl7n2T7gzc8GhU8NYbP3M6\n"
        );
        assert_eq!(
            got.enc_sec_key,
            "35701388baf89fed412e11269b9c76625d095ecaf17f03fa018abe19ea2d38b9\
             49debf242ee39a71ca1f6cda71b1b86a45aa909ee27f7e78e267d34e732f0de9\
             48206c3340a788d0003372183e2f753c1f78b66ac23d134ac1fc9b993156520e\
             a826b8aa89a962d4491b4b8d7e08738e1da9b07aa39bf4a7ef0b1c210728cd52"
        );
    }

    #[test]
    fn eapi_matches_pyncm_golden_vector() {
        let got = eapi_encrypt("/api/song/enhance/player/url/v1", PLAIN);
        assert_eq!(
            got,
            "fa90b329e9614f79e79598f37dc2edb487f00d1bc4c9b24cd57e6c318b907356\
             9338432cd7d98d1a3626e997a2c53121b92082ec03ca1650999230c57d6505c4\
             03bd977b7894a13288fb8a584c9dee9b2179a40742a9081585d78db245c2e32e\
             06ba62003d36d909e32aa6030b1ede225aa8f05a0b647f8ef3a0ebfca7f669d6\
             1871c577882b98893f51ff111314d181f7176757ff286244db6574b9533584fb\
             f08aae45b16689ec4bfabc80fbb9674f"
        );
    }

    #[test]
    fn enc_sec_key_is_always_256_hex_chars() {
        // 前导零被丢掉过一次就是"偶发登录失败"，很难查，所以这里跑一批随机密钥
        for _ in 0..64 {
            let payload = weapi_encrypt("{}", None);
            assert_eq!(payload.enc_sec_key.len(), 256, "{}", payload.enc_sec_key);
        }
    }

    #[test]
    fn base64_body_is_mime_wrapped_at_76_columns() {
        let payload = weapi_encrypt(PLAIN, Some(SECRET));
        assert!(payload.params.ends_with('\n'), "结尾必须有换行");
        for line in payload.params.trim_end().split('\n') {
            assert!(line.len() <= 76, "行长 {} 超了", line.len());
        }
    }

    #[test]
    fn eapi_roundtrips_through_decrypt() {
        // 服务端回的就是同一把 ECB 密钥加密的 body
        let body = r#"{"code":200,"data":[{"url":"https://m.example/a.flac"}]}"#;
        let cipher = super::aes_ecb_encrypt(body.as_bytes(), EAPI_AES_KEY);
        assert_eq!(eapi_decrypt(&cipher).as_deref(), Some(body));
    }

    #[test]
    fn plaintext_response_is_reported_as_not_ciphertext() {
        // 长度不是 16 的倍数 / 解不出合法 padding 时必须回 None，
        // 让调用方退回按明文解析，而不是把整个请求判失败
        assert_eq!(eapi_decrypt(b"{\"code\":200}"), None);
        assert_eq!(eapi_decrypt(b""), None);
    }

    #[test]
    fn random_secret_stays_in_the_base62_alphabet() {
        let key = random_secret_key();
        assert_eq!(key.len(), 16);
        assert!(key.bytes().all(|b| BASE62.contains(&b)));
    }
}
