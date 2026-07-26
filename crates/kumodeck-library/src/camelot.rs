//! Camelot 轮盘：调号解析、兼容关系、BPM 分档。
//!
//! 这些是和声推荐的地基。表打错一格，用户就会在现场把两首根本不搭的歌接到一起。

use kumodeck_core::models::HarmonicRelation;

/// 逐条对应契约第 5 节的调号轮表格。
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

/// 同音异名。用户搜 "G# minor" 必须能命中库里存成 "Ab minor" 的那些。
const ENHARMONIC: [(&str, &str); 10] = [
    ("ab", "g#"),
    ("g#", "ab"),
    ("eb", "d#"),
    ("d#", "eb"),
    ("bb", "a#"),
    ("a#", "bb"),
    ("db", "c#"),
    ("c#", "db"),
    ("gb", "f#"),
    ("f#", "gb"),
];

pub fn relation_label(relation: HarmonicRelation) -> &'static str {
    match relation {
        HarmonicRelation::Same => "同调",
        HarmonicRelation::EnergyUp => "提能量",
        HarmonicRelation::EnergyDown => "降能量",
        HarmonicRelation::Relative => "转大小调",
        HarmonicRelation::EnergyBoost => "情绪跳",
        HarmonicRelation::TwoStep => "跨两格",
        HarmonicRelation::Diagonal => "斜接",
    }
}

/// 调性距离：越远排得越后（进 score 的加权距离）。
pub fn relation_distance(relation: HarmonicRelation) -> f64 {
    match relation {
        HarmonicRelation::Same => 0.0,
        HarmonicRelation::EnergyUp => 1.0,
        HarmonicRelation::EnergyDown => 1.0,
        HarmonicRelation::Relative => 1.2,
        HarmonicRelation::EnergyBoost => 2.0,
        HarmonicRelation::TwoStep => 2.4,
        HarmonicRelation::Diagonal => 2.8,
    }
}

/// 解析 "8A" / "8a" / "10 B"。
pub fn split_camelot(camelot: &str) -> Option<(u32, char)> {
    let cleaned: String = camelot.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.len() < 2 {
        return None;
    }
    let (number_part, letter_part) = cleaned.split_at(cleaned.len() - 1);
    let letter = letter_part.chars().next()?.to_ascii_uppercase();
    if letter != 'A' && letter != 'B' {
        return None;
    }
    let number: u32 = number_part.parse().ok()?;
    (1..=12).contains(&number).then_some((number, letter))
}

/// 1..12 的环形（12 + 1 = 1）。
pub fn camelot_wrap(number: i64) -> u32 {
    (((number - 1).rem_euclid(12)) + 1) as u32
}

/// 把用户输入的调性过滤条件解析成 `(camelot, 原始文本)`。
///
/// 既接受 `"8A"`，也接受 `"A minor"` / `"Am"` / `"a min"`。
/// 认不出来就返回 `("", 原始文本)`，由调用方退化成 `music_key` 模糊匹配。
pub fn parse_key_filter(value: &str) -> (String, String) {
    let raw = value.trim();
    if raw.is_empty() {
        return (String::new(), String::new());
    }
    if let Some((number, letter)) = split_camelot(raw) {
        return (format!("{number}{letter}"), raw.to_string());
    }
    let normalized = raw.to_lowercase().replace('♯', "#").replace('♭', "b");
    for (code, name) in CAMELOT_TO_KEY {
        if key_variants(name)
            .iter()
            .any(|variant| *variant == normalized)
        {
            return (code.to_string(), raw.to_string());
        }
    }
    (String::new(), raw.to_string())
}

/// 一个调名的所有可接受写法（含同音异名）。
fn key_variants(name: &str) -> Vec<String> {
    let (root, mode) = name.split_once(' ').unwrap_or((name, ""));
    let is_minor = mode.starts_with("min");
    let short_mode = if is_minor { "m" } else { "" };

    let mut roots = vec![root.to_string()];
    let lower = root.to_lowercase();
    if let Some((_, alt)) = ENHARMONIC.iter().find(|(from, _)| *from == lower) {
        let mut chars = alt.chars();
        let capitalized = match chars.next() {
            Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
            None => String::new(),
        };
        roots.push(capitalized);
    }

    let mut out = Vec::new();
    for r in roots {
        out.push(format!("{r} {mode}").to_lowercase());
        out.push(format!("{r}{short_mode}").to_lowercase());
        out.push(format!("{r} {}", if is_minor { "min" } else { "maj" }).to_lowercase());
    }
    out
}

/// 给定 Camelot 返回 `[(兼容调, relation)]`。
///
/// 核心四条：同号 / ±1 同字母 / 同号异字母（相对大小调）。
///
/// `wide = true` 再加两组现场真会用、但听感变化更明显的：
/// `+7 同字母`（情绪跳）和 `±2 同字母`（跨两格）。
/// 它们排序时会被 `relation_distance` 压后，所以打开之后只是"列表更长"，
/// 不会把稳妥的选项挤下去。
pub fn camelot_relations(camelot: &str, wide: bool) -> Vec<(String, HarmonicRelation)> {
    let Some((number, letter)) = split_camelot(camelot) else {
        return Vec::new();
    };
    let number = number as i64;
    let other = if letter == 'A' { 'B' } else { 'A' };
    let mut out: Vec<(String, HarmonicRelation)> = vec![
        (format!("{number}{letter}"), HarmonicRelation::Same),
        (
            format!("{}{letter}", camelot_wrap(number + 1)),
            HarmonicRelation::EnergyUp,
        ),
        (
            format!("{}{letter}", camelot_wrap(number - 1)),
            HarmonicRelation::EnergyDown,
        ),
        (format!("{number}{other}"), HarmonicRelation::Relative),
    ];
    if wide {
        // 绕圈之后可能和上面撞车；**先到的关系更近，不要覆盖**
        let mut push_if_absent = |code: String, relation: HarmonicRelation| {
            if !out.iter().any(|(existing, _)| *existing == code) {
                out.push((code, relation));
            }
        };
        push_if_absent(
            format!("{}{letter}", camelot_wrap(number + 7)),
            HarmonicRelation::EnergyBoost,
        );
        push_if_absent(
            format!("{}{letter}", camelot_wrap(number + 2)),
            HarmonicRelation::TwoStep,
        );
        push_if_absent(
            format!("{}{letter}", camelot_wrap(number - 2)),
            HarmonicRelation::TwoStep,
        );
        // 相邻调的相对大小调：换调又换调式，属于"敢接才接"，排最后
        push_if_absent(
            format!("{}{other}", camelot_wrap(number + 1)),
            HarmonicRelation::Diagonal,
        );
        push_if_absent(
            format!("{}{other}", camelot_wrap(number - 1)),
            HarmonicRelation::Diagonal,
        );
    }
    out
}

/// 在同速/半速/倍速里挑一个能对上的。
///
/// 返回 `(tempo_ratio, bpm_delta)`，delta 是**折算后**的差值。
/// 172 和 86 在 DJ 眼里是同一个速度，只按原始 BPM 比会漏掉一半可用曲目。
pub fn best_tempo(candidate_bpm: f64, source_bpm: f64, tolerance: f64) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;
    // 1.0 放最前，同分时优先同速
    for ratio in [1.0, 0.5, 2.0] {
        let delta = candidate_bpm * ratio - source_bpm;
        if delta.abs() > tolerance {
            continue;
        }
        if best.is_none_or(|(_, current)| delta.abs() < current.abs()) {
            best = Some((ratio, delta));
        }
    }
    best
}

/// 统计用的 BPM 分档，键就是前端要显示的字符串。
pub fn bpm_bucket(bpm: f64) -> String {
    if bpm < 90.0 {
        return "<90".to_string();
    }
    if bpm >= 170.0 {
        return "170+".to_string();
    }
    let low = (bpm / 10.0).floor() as i64 * 10;
    format!("{low}-{}", low + 9)
}

pub const BPM_BUCKET_ORDER: [&str; 10] = [
    "<90", "90-99", "100-109", "110-119", "120-129", "130-139", "140-149", "150-159", "160-169",
    "170+",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camelot_table_has_24_unique_entries() {
        let mut codes: Vec<&str> = CAMELOT_TO_KEY.iter().map(|(code, _)| *code).collect();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), 24);

        let mut names: Vec<&str> = CAMELOT_TO_KEY.iter().map(|(_, name)| *name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 24, "24 个调名也不能重复");
    }

    #[test]
    fn camelot_codes_parse_in_every_casing() {
        assert_eq!(split_camelot("8A"), Some((8, 'A')));
        assert_eq!(split_camelot("8a"), Some((8, 'A')));
        assert_eq!(split_camelot("10 B"), Some((10, 'B')));
        assert_eq!(split_camelot("12A"), Some((12, 'A')));
        assert_eq!(split_camelot("13A"), None);
        assert_eq!(split_camelot("0A"), None);
        assert_eq!(split_camelot("8C"), None);
        assert_eq!(split_camelot(""), None);
    }

    #[test]
    fn key_names_resolve_to_camelot_including_enharmonics() {
        assert_eq!(parse_key_filter("A minor").0, "8A");
        assert_eq!(parse_key_filter("Am").0, "8A");
        assert_eq!(parse_key_filter("a min").0, "8A");
        assert_eq!(parse_key_filter("C major").0, "8B");
        // 同音异名：库里存的是 Ab minor，用户可能搜 G# minor
        assert_eq!(parse_key_filter("G# minor").0, "1A");
        assert_eq!(parse_key_filter("g#m").0, "1A");
        assert_eq!(parse_key_filter("D# minor").0, "2A", "= Eb minor");
    }

    #[test]
    fn unicode_sharp_and_flat_signs_are_normalized() {
        assert_eq!(parse_key_filter("F♯ minor").0, "11A");
        assert_eq!(parse_key_filter("A♭ minor").0, "1A");
    }

    #[test]
    fn unknown_key_text_is_returned_for_fuzzy_matching() {
        let (camelot, raw) = parse_key_filter("something weird");
        assert_eq!(camelot, "");
        assert_eq!(raw, "something weird");
    }

    #[test]
    fn wrap_is_circular_on_the_wheel() {
        assert_eq!(camelot_wrap(13), 1);
        assert_eq!(camelot_wrap(0), 12);
        assert_eq!(camelot_wrap(-1), 11);
        assert_eq!(camelot_wrap(8), 8);
    }

    #[test]
    fn narrow_relations_are_the_classic_four() {
        let relations = camelot_relations("8A", false);
        let codes: Vec<&str> = relations.iter().map(|(code, _)| code.as_str()).collect();
        assert_eq!(codes, vec!["8A", "9A", "7A", "8B"]);
        assert_eq!(relations[0].1, HarmonicRelation::Same);
        assert_eq!(relations[1].1, HarmonicRelation::EnergyUp);
        assert_eq!(relations[2].1, HarmonicRelation::EnergyDown);
        assert_eq!(relations[3].1, HarmonicRelation::Relative);
    }

    #[test]
    fn relations_wrap_around_the_wheel_edges() {
        let relations = camelot_relations("12A", false);
        let codes: Vec<&str> = relations.iter().map(|(code, _)| code.as_str()).collect();
        assert_eq!(codes, vec!["12A", "1A", "11A", "12B"], "12 的下一格是 1");

        let relations = camelot_relations("1B", false);
        let codes: Vec<&str> = relations.iter().map(|(code, _)| code.as_str()).collect();
        assert_eq!(codes, vec!["1B", "2B", "12B", "1A"], "1 的上一格是 12");
    }

    #[test]
    fn wide_relations_never_overwrite_a_closer_one() {
        let relations = camelot_relations("8A", true);
        // 每个 code 只能出现一次，且已有的关系不被后来的覆盖
        let mut codes: Vec<&str> = relations.iter().map(|(code, _)| code.as_str()).collect();
        let unique_len = {
            codes.sort();
            codes.dedup();
            codes.len()
        };
        assert_eq!(unique_len, relations.len(), "不能有重复的调号");
        // 8A 本身必须还是 same
        assert_eq!(
            relations
                .iter()
                .find(|(code, _)| code == "8A")
                .map(|(_, r)| *r),
            Some(HarmonicRelation::Same)
        );
    }

    #[test]
    fn relation_distance_orders_safest_first() {
        let mut relations = [
            HarmonicRelation::Diagonal,
            HarmonicRelation::Same,
            HarmonicRelation::TwoStep,
            HarmonicRelation::EnergyUp,
        ];
        relations.sort_by(|a, b| relation_distance(*a).total_cmp(&relation_distance(*b)));
        assert_eq!(relations[0], HarmonicRelation::Same);
        assert_eq!(relations[1], HarmonicRelation::EnergyUp);
        assert_eq!(relations[3], HarmonicRelation::Diagonal);
    }

    #[test]
    fn tempo_matching_accepts_half_and_double_time() {
        // 172 和 86 是同一个速度
        assert_eq!(best_tempo(86.0, 172.0, 6.0), Some((2.0, 0.0)));
        assert_eq!(best_tempo(172.0, 86.0, 6.0), Some((0.5, 0.0)));
        assert_eq!(best_tempo(128.0, 128.0, 6.0), Some((1.0, 0.0)));
        // 超出容差就不算能对拍
        assert_eq!(best_tempo(100.0, 128.0, 6.0), None);
    }

    #[test]
    fn tempo_matching_prefers_same_speed_on_ties() {
        // 120 对 120：同速 delta=0，倍速 delta=120，半速 delta=-60 → 必须选同速
        assert_eq!(best_tempo(120.0, 120.0, 200.0).unwrap().0, 1.0);
    }

    #[test]
    fn bpm_buckets_cover_the_whole_range_in_order() {
        assert_eq!(bpm_bucket(60.0), "<90");
        assert_eq!(bpm_bucket(89.9), "<90");
        assert_eq!(bpm_bucket(90.0), "90-99");
        assert_eq!(bpm_bucket(128.0), "120-129");
        assert_eq!(bpm_bucket(169.9), "160-169");
        assert_eq!(bpm_bucket(170.0), "170+");
        assert_eq!(bpm_bucket(200.0), "170+");
        // 每个产出的档位名都必须在展示顺序表里
        for bpm in [
            60.0, 95.0, 105.0, 115.0, 125.0, 135.0, 145.0, 155.0, 165.0, 180.0,
        ] {
            let bucket = bpm_bucket(bpm);
            assert!(
                BPM_BUCKET_ORDER.contains(&bucket.as_str()),
                "{bucket} 不在展示顺序表里"
            );
        }
    }
}
