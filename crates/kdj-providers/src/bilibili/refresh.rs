//! B 站网页端的 Cookie 刷新要用到的纯计算：CorrespondPath 与 refresh_csrf。
//!
//! 流程（bilibili-API-collect `docs/login/cookie_refresh.md`）：`cookie/info` 说要刷新时，用
//! B 站公开的 RSA 公钥按 RSA-OAEP（SHA-256，MGF1-SHA-256，空 label）加密 `refresh_{毫秒时间戳}`，
//! 小写十六进制拼到 `https://www.bilibili.com/correspond/1/` 后面取页面，页面里
//! `<div id="1-name">` 的文字就是 refresh_csrf。网络部分在 [`super::client`]。
//!
//! 不引 `rsa` crate：它有一条没有修复版本的 RUSTSEC 通告，`cargo audit` 会拦下发布；这里只做
//! 公钥加密，用已有的 num-bigint 做模幂就够了。

use num_bigint::BigUint;
use sha2::{Digest, Sha256};

/// B 站网页端的刷新公钥（1024 位，e = 65537），即文档里的
/// `MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg…QIDAQAB` 的模数。
const PUBLIC_MODULUS_HEX: &str = "cb81dd8e02470656da04dd38544446e2a3412051cfe9adc6a330a5ef90228509\
684960970b91c3360ca29c49e1690ff8fa068cb9dfc6179d1e9585cb9424e847db1ef59f33e37dd4dca8ccfb7631ee9b\
4a92640d00c8204300152a0ab7cd802889d3445aec69918fe6022b534912e7b095be3424dad1ba81145e969b533181f1";
const PUBLIC_EXPONENT: u32 = 65_537;

/// `cookie/info` 给的毫秒时间戳 → 取 refresh_csrf 的路径。
pub(super) fn correspond_path(timestamp_ms: i64) -> String {
    let message = format!("refresh_{timestamp_ms}");
    hex::encode(oaep_encrypt(
        PUBLIC_MODULUS_HEX,
        message.as_bytes(),
        rand::random(),
    ))
}

/// correspond 页面里的 refresh_csrf；页面不对（过期的路径会回 404 页）时为 None。
pub(super) fn refresh_csrf(html: &str) -> Option<String> {
    let start = html.find("<div id=\"1-name\">")? + "<div id=\"1-name\">".len();
    let rest = &html[start..];
    let value = rest[..rest.find("</div>")?].trim();
    (!value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| value.to_owned())
}

/// RFC 8017 §7.1.1 RSAES-OAEP-ENCRYPT，SHA-256 / MGF1-SHA-256 / 空 label。
fn oaep_encrypt(modulus_hex: &str, message: &[u8], seed: [u8; 32]) -> Vec<u8> {
    const H: usize = 32;
    let n = BigUint::parse_bytes(modulus_hex.as_bytes(), 16).expect("模数是合法十六进制");
    let k = n.bits().div_ceil(8) as usize;
    assert!(message.len() + 2 * H + 2 <= k, "消息超过 OAEP 能装的长度");

    let mut db = Vec::with_capacity(k - H - 1);
    db.extend_from_slice(&Sha256::digest(b""));
    db.resize(k - message.len() - H - 2, 0);
    db.push(1);
    db.extend_from_slice(message);
    xor(&mut db, &mgf1(&seed, k - H - 1));
    let mut masked_seed = seed.to_vec();
    xor(&mut masked_seed, &mgf1(&db, H));

    let mut encoded = Vec::with_capacity(k);
    encoded.push(0);
    encoded.extend_from_slice(&masked_seed);
    encoded.extend_from_slice(&db);
    let cipher = BigUint::from_bytes_be(&encoded)
        .modpow(&BigUint::from(PUBLIC_EXPONENT), &n)
        .to_bytes_be();
    // 密文固定 k 字节，高位不足补 0。
    let mut out = vec![0; k - cipher.len()];
    out.extend_from_slice(&cipher);
    out
}

fn mgf1(seed: &[u8], length: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(length + 32);
    let mut counter = 0u32;
    while out.len() < length {
        let mut hash = Sha256::new();
        hash.update(seed);
        hash.update(counter.to_be_bytes());
        out.extend_from_slice(&hash.finalize());
        counter += 1;
    }
    out.truncate(length);
    out
}

fn xor(target: &mut [u8], mask: &[u8]) {
    for (byte, mask) in target.iter_mut().zip(mask) {
        *byte ^= mask;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只给测试用的一对 1024 位密钥，用私钥解开验证填充。
    const TEST_N: &str = "d238da72421d293771102d5877c660e689c9894100e62302c9307864c62df3ed\
7b51ee9d97c2c270bd9fa3d2b77c395619229657309347dceb92be3e22b0f264699e20d6c5183ea172745b1f627adb77\
760f0d1864aeb82b0857151a898da9df7d0be32304858ead965d5cd1c4d5e4c620b66c4343b2efaf146236265b61ae5f";
    const TEST_D: &str = "8aed95b7f2e770a8ba28b5bf0490eed30c764b25d16145fbfe57f108b04c082b\
86d733b9a464cab95527de4d50836124fc417657b2bb72bf96538934691ac564d175763ab9adab251641e16db4c69a52\
4f7a54e969a826495f34467e1a68335b370e52711cb6eb0795be18f04e64ce20ce2551c119099f1a296598c9339fba51";

    fn oaep_decrypt(cipher: &[u8]) -> Vec<u8> {
        let n = BigUint::parse_bytes(TEST_N.as_bytes(), 16).unwrap();
        let d = BigUint::parse_bytes(TEST_D.as_bytes(), 16).unwrap();
        let plain = BigUint::from_bytes_be(cipher).modpow(&d, &n).to_bytes_be();
        let mut encoded = vec![0; 128 - plain.len()];
        encoded.extend_from_slice(&plain);
        assert_eq!(encoded[0], 0);
        let (masked_seed, masked_db) = encoded[1..].split_at(32);
        let mut seed = masked_seed.to_vec();
        xor(&mut seed, &mgf1(masked_db, 32));
        let mut db = masked_db.to_vec();
        let mask = mgf1(&seed, db.len());
        xor(&mut db, &mask);
        assert_eq!(&db[..32], Sha256::digest(b"").as_slice(), "label hash");
        let one = 32 + db[32..].iter().position(|byte| *byte != 0).unwrap();
        assert_eq!(db[one], 1);
        db[one + 1..].to_vec()
    }

    #[test]
    fn oaep_round_trips_with_the_matching_private_key() {
        let message = b"refresh_1684466082562";
        let cipher = oaep_encrypt(TEST_N, message, [7; 32]);
        assert_eq!(cipher.len(), 128);
        assert_eq!(oaep_decrypt(&cipher), message);
        assert_ne!(cipher, oaep_encrypt(TEST_N, message, [8; 32]), "种子不同密文就不同");
    }

    #[test]
    fn correspond_path_is_lowercase_hex_of_one_block() {
        let path = correspond_path(1_684_466_082_562);
        assert_eq!(path.len(), 256);
        assert!(path.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn refresh_csrf_is_read_from_the_page() {
        let page = "<html><body><div id=\"1-name\">b0cc8411ded2f9db2cff2edb3123acac</div>\
                    <div id=\"1-value\">x</div></body></html>";
        assert_eq!(
            refresh_csrf(page).as_deref(),
            Some("b0cc8411ded2f9db2cff2edb3123acac")
        );
        assert_eq!(refresh_csrf("<html>404</html>"), None);
        assert_eq!(refresh_csrf("<div id=\"1-name\"></div>"), None);
    }
}
