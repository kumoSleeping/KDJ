//! Scrub diagnostic text, never serialize application state or request bodies.
use regex::Regex;
use std::sync::LazyLock;

static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        // Header / credential assignments: discard the remainder of that line, not just a token.
        (r#"(?im)\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|access_token|refresh_token|auth_token|media_token|control_token|client_secret|api[_-]?key|secret|token|musickey|sapisid|po_token|visitor_data|refresh_key)\b[\"'\s]*[:=][^\r\n]*"#, "[credential redacted]"),
        (r"(?i)\bBearer\s+\S+", "Bearer [redacted]"),
        (r#"(?i)(?:https?|file|blob|data|wss?)://[^\s\"'<>]+"#, "[url]"),
        (r#"(?i)\bdata:[^\s\"'<>]+"#, "[data]"),
        (r#"(?i)(?:[a-z]:[\\/]|\\\\)[^\r\n\"'<>:]*"#, "[path]"),
        (r#"/(?:Users|home|Volumes|private|tmp|var|storage|sdcard|data|mnt|media|opt|Applications)/[^\r\n\"'<>:]*"#, "[path]"),
        (r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[email]"),
        (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[ip]"),
        (r"(?i)\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]{1,39}\b|\b[a-f0-9]{1,4}::[a-f0-9:]{1,39}\b|(?:^|[\s\[])::1(?:$|[\s\]])", "[ip]"),
        (r"\b(?:\+?86[- ]?)?1[3-9]\d{9}\b", "[phone]"),
        (r"\b\d{15,19}\b", "[identifier]"),
        (r"\b[A-Za-z0-9_+/=-]{48,}\b", "[opaque value]"),
    ].into_iter().map(|(pattern, replacement)| (Regex::new(pattern).expect("static redaction pattern"), replacement)).collect()
});

pub fn text(raw: &str, limit: usize) -> String {
    // Bound work BEFORE regex matching. Keep line breaks and stack traces readable.
    let mut value: String = raw
        .chars()
        .take(32_768)
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    for (pattern, replacement) in RULES.iter() {
        value = pattern.replace_all(&value, *replacement).into_owned();
    }
    value.chars().take(limit).collect()
}

pub fn sensitive_field(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "token",
        "secret",
        "cookie",
        "password",
        "authorization",
        "path",
        "filename",
        "title",
        "query",
        "lyrics",
        "body",
        "account",
        "username",
        "email",
        "url",
    ]
    .iter()
    .any(|part| name.contains(part))
}
