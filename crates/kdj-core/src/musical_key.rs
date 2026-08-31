//! 本地曲库使用的调性契约。
//!
//! KDJ 同时接受短音名、传统长名、Camelot 与 Open Key，并统一成同一份结构，避免
//! 分析、筛选和播放控制各自维护一张映射表。

/// Camelot → KDJ 规范传统调名。顺序是轮盘上的 1A、1B、2A、2B……。
pub const CAMELOT_TO_KEY: [(&str, &str); 24] = [
    ("1A", "Ab minor"),
    ("1B", "B major"),
    ("2A", "Eb minor"),
    ("2B", "F# major"),
    ("3A", "Bb minor"),
    ("3B", "Db major"),
    ("4A", "F minor"),
    ("4B", "Ab major"),
    ("5A", "C minor"),
    ("5B", "Eb major"),
    ("6A", "G minor"),
    ("6B", "Bb major"),
    ("7A", "D minor"),
    ("7B", "F major"),
    ("8A", "A minor"),
    ("8B", "C major"),
    ("9A", "E minor"),
    ("9B", "G major"),
    ("10A", "B minor"),
    ("10B", "D major"),
    ("11A", "F# minor"),
    ("11B", "A major"),
    ("12A", "Db minor"),
    ("12B", "E major"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MusicalKey {
    /// KDJ 分析与查询使用的无歧义长名，例如 `F# major`。
    pub traditional: String,
    /// Camelot 数字制，例如 `2B`。
    pub camelot: String,
    /// Open Key，例如 `7d`。
    pub open_key: String,
}

impl MusicalKey {
    pub fn from_camelot(value: &str) -> Option<Self> {
        let (number, letter) = split_camelot(value)?;
        let camelot = format!("{number}{letter}");
        let traditional = CAMELOT_TO_KEY
            .iter()
            .find_map(|(code, name)| (*code == camelot).then_some((*name).to_owned()))?;
        Some(Self {
            traditional,
            open_key: camelot_to_open_key(&camelot),
            camelot,
        })
    }
}

/// 接受 Camelot、长音名、ID3 短名以及 djay 的 `F# M` / `F# m`。
pub fn parse_musical_key(value: &str) -> Option<MusicalKey> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(key) = MusicalKey::from_camelot(raw) {
        return Some(key);
    }

    let normalized = raw.replace('♯', "#").replace('♭', "b");
    let mut chars = normalized.chars();
    let head = chars.next()?.to_ascii_uppercase();
    if !(('A'..='G').contains(&head)) {
        return None;
    }
    let mut root = head.to_string();
    let rest = chars.as_str();
    let (accidental, mode_text) = match rest.chars().next() {
        Some('#') => (Some('#'), &rest['#'.len_utf8()..]),
        Some('b' | 'B') => (Some('b'), &rest[1..]),
        _ => (None, rest),
    };
    if let Some(accidental) = accidental {
        root.push(accidental);
    }
    let mode_text = mode_text.trim();
    let minor = match mode_text {
        "" | "M" => false,
        "m" => true,
        _ => {
            let lower = mode_text.to_ascii_lowercase();
            if matches!(lower.as_str(), "major" | "maj" | "dur") {
                false
            } else if matches!(lower.as_str(), "minor" | "min" | "mol") {
                true
            } else {
                return None;
            }
        }
    };

    let pitch = pitch_class(&root)?;
    let camelot_by_pitch = [
        ("5A", "8B"),
        ("12A", "3B"),
        ("7A", "10B"),
        ("2A", "5B"),
        ("9A", "12B"),
        ("4A", "7B"),
        ("11A", "2B"),
        ("6A", "9B"),
        ("1A", "4B"),
        ("8A", "11B"),
        ("3A", "6B"),
        ("10A", "1B"),
    ];
    MusicalKey::from_camelot(if minor {
        camelot_by_pitch[pitch].0
    } else {
        camelot_by_pitch[pitch].1
    })
}

pub fn split_camelot(value: &str) -> Option<(u32, char)> {
    let compact: String = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let mut characters = compact.chars();
    let letter = characters.next_back()?.to_ascii_uppercase();
    let number = characters.as_str().parse::<u32>().ok()?;
    ((1..=12).contains(&number) && matches!(letter, 'A' | 'B')).then_some((number, letter))
}

pub fn camelot_to_open_key(camelot: &str) -> String {
    let Some((number, letter)) = split_camelot(camelot) else {
        return String::new();
    };
    let open_number = (number as i32 - 8).rem_euclid(12) + 1;
    format!("{open_number}{}", if letter == 'A' { 'm' } else { 'd' })
}

fn pitch_class(root: &str) -> Option<usize> {
    match root.to_ascii_lowercase().as_str() {
        "c" | "b#" => Some(0),
        "c#" | "db" => Some(1),
        "d" => Some(2),
        "d#" | "eb" => Some(3),
        "e" | "fb" => Some(4),
        "e#" | "f" => Some(5),
        "f#" | "gb" => Some(6),
        "g" => Some(7),
        "g#" | "ab" => Some(8),
        "a" => Some(9),
        "a#" | "bb" => Some(10),
        "b" | "cb" => Some(11),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_notations_resolve_to_one_key() {
        for value in ["F# M", "F# major", "F#", "2B", "Gb maj", "F♯ M"] {
            let key = parse_musical_key(value).unwrap_or_else(|| panic!("无法解析 {value}"));
            assert_eq!(key.camelot, "2B", "输入 {value}");
            assert_eq!(key.traditional, "F# major", "输入 {value}");
        }
        for value in ["F# m", "F#m", "F# minor", "11A", "Gb min"] {
            let key = parse_musical_key(value).unwrap_or_else(|| panic!("无法解析 {value}"));
            assert_eq!(key.camelot, "11A", "输入 {value}");
        }
    }

    #[test]
    fn malformed_values_are_not_silently_relabelled() {
        for value in ["", "13A", "8C", "H major", "F# maybe", "8", "未知调性"] {
            assert!(parse_musical_key(value).is_none(), "输入 {value}");
        }
    }
}
