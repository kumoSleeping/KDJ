//! 跨平台搜索聚合：并发搜索 → 模糊去重 → 按梯队 + 相关度排序。

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

use kumodeck_core::models::{MergedGroup, Platform, SearchRequest, SearchResponse, SongSource};

use crate::state::AppState;

/// 平台默认分。请求里没给顺序时用它。
fn default_priority(platform: Platform) -> f64 {
    match platform {
        Platform::Wyy => 1.0,
        Platform::Qqm => 0.95,
        Platform::Soundcloud => 0.8,
        Platform::Bilibili => 0.5,
        Platform::Local => 0.4,
    }
}

/// 判定为同一首歌的阈值。
const SAME_SONG_THRESHOLD: f64 = 0.82;

/// 噪声词：出现在括号里时整段括号丢掉，散落在标题里时单独抹掉。
///
/// **顺序重要**——长短语必须排在它的子串前面（`remastered` 在 `remaster` 前，
/// 否则 `remaster` 先匹配掉，剩一个孤零零的 `ed`）。
const NOISE_PHRASES: &[&str] = &[
    "radio edit",
    "extended mix",
    "extended version",
    "original mix",
    "remastered",
    "remaster",
    "instrumental",
    "explicit",
    "acoustic",
    "official",
    "live version",
    "remix",
    "cover",
    "live",
    "feat.",
    "feat",
    "ft.",
    "ft",
    "hq",
    "hd",
    "mv",
    "demo",
    "伴奏",
    "翻自",
    "官方",
    "高清",
    "完整版",
    "未删减",
    "原曲",
    "试听",
    "现场版",
    "纯音乐",
    "无损",
    "动态歌词",
    "歌词版",
];

const UNKNOWN_ARTISTS: &[&str] = &[
    "unknown",
    "未知",
    "未知艺人",
    "群星",
    "various",
    "variousartists",
];

// ---------------------------------------------------------------- 归一化

/// 半角片假名 `FF61..=FF9F` → 全角片假名/标点。下标 0 对应 `U+FF61`。
const HALFWIDTH_KATAKANA: [char; 63] = [
    '。', '「', '」', '、', '・', 'ヲ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ッ', 'ー',
    'ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ', 'タ',
    'チ', 'ツ', 'テ', 'ト', 'ナ', 'ニ', 'ヌ', 'ネ', 'ノ', 'ハ', 'ヒ', 'フ', 'ヘ', 'ホ', 'マ', 'ミ',
    'ム', 'メ', 'モ', 'ヤ', 'ユ', 'ヨ', 'ラ', 'リ', 'ル', 'レ', 'ロ', 'ワ', 'ン', '゙', '゚',
];

/// 罗马数字 `U+2160..=U+217F` → 拉丁字母。NFKC 就是这么拆的（Ⅱ → `II`）。
const ROMAN_NUMERALS: [&str; 32] = [
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "L", "C", "D", "M",
    "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "l", "c", "d", "m",
];

/// 浊点：`カ→ガ`。假名表里浊音就排在清音后面一格，`ウ/ワ/ヲ` 是三个例外。
fn voiced(ch: char) -> Option<char> {
    match ch {
        'ウ' => Some('ヴ'),
        'ワ' => Some('ヷ'),
        'ヲ' => Some('ヺ'),
        'カ' | 'キ' | 'ク' | 'ケ' | 'コ' | 'サ' | 'シ' | 'ス' | 'セ' | 'ソ' | 'タ' | 'チ' | 'ツ'
        | 'テ' | 'ト' | 'ハ' | 'ヒ' | 'フ' | 'ヘ' | 'ホ' => char::from_u32(ch as u32 + 1),
        _ => None,
    }
}

/// 半浊点：`ハ→パ`，比浊音再后一格。
fn semi_voiced(ch: char) -> Option<char> {
    matches!(ch, 'ハ' | 'ヒ' | 'フ' | 'ヘ' | 'ホ')
        .then(|| char::from_u32(ch as u32 + 2))
        .flatten()
}

/// 兼容性折叠：全角 → 半角、半角片假名 → 全角片假名、罗马数字 → 拉丁字母。
///
/// Python 版归一化的第一步是 `unicodedata.normalize("NFKC", ...)`，这里补上其中
/// **真的会出现在歌名/艺人名里**的那几段。只做子集是因为为此引一个完整的 Unicode
/// 规范化库不划算；但**一段都不做是不行的**：半角片假名（`ｱｲﾄﾞﾙ`）落在
/// `is_cjk` 的范围外，不折叠的话整条标题会被 `normalize_title` 抹成空串——
/// 而两个空串的相似度是 1.0，任意两首这样的日文歌都会被并进同一组。
fn nfkc_lite(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let code = ch as u32;
        index += 1;
        let mapped = match code {
            0x3000 => ' ',
            0xFF01..=0xFF5E => char::from_u32(code - 0xFEE0).unwrap_or(ch),
            0xFF61..=0xFF9F => HALFWIDTH_KATAKANA[(code - 0xFF61) as usize],
            0x2160..=0x217F => {
                out.push_str(ROMAN_NUMERALS[(code - 0x2160) as usize]);
                continue;
            }
            _ => ch,
        };
        // 浊点/半浊点在半角里是独立字符（`ﾄ` + `ﾞ`），NFKC 会把它们合成一个字。
        // 不合的话，同一首歌在 A 平台写作 `ド`、B 平台写作 `ﾄﾞ` 就对不上了。
        let composed = match chars.get(index).map(|next| *next as u32) {
            Some(0xFF9E) => voiced(mapped),
            Some(0xFF9F) => semi_voiced(mapped),
            _ => None,
        };
        match composed {
            Some(ch) => {
                out.push(ch);
                index += 1;
            }
            None => out.push(mapped),
        }
    }
    out
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x309F | 0x30A0..=0x30FF | 0xAC00..=0xD7AF)
}

/// 小写 + 全角转半角 + 去括号噪声 + 去散落噪声词，**保留空格**（分词还要用）。
fn clean(text: &str) -> String {
    let lowered = nfkc_lite(text).to_lowercase();
    let unbracketed = drop_brackets(&lowered);
    let denoised = strip_noise(&unbracketed);
    denoised.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 括号里含噪声词 → 整段丢掉；否则只脱掉括号，保留内容。
///
/// `(Part 2)` 这种是内容不是噪声，丢了会把两首不同的歌合并。
///
/// 对齐 Python 的 `【[^【】]*】|\([^()]*\)|（[^（）]*）|\[[^\[\]]*\]`：括号内**不能**
/// 再出现同类括号，所以 `a (b (c) d)` 只会命中里层的 `(c)`。
fn drop_brackets(text: &str) -> String {
    const PAIRS: [(char, char); 4] = [('(', ')'), ('（', '）'), ('[', ']'), ('【', '】')];
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let Some((open, close)) = PAIRS.iter().find(|(open, _)| *open == chars[index]).copied()
        else {
            out.push(chars[index]);
            index += 1;
            continue;
        };
        // 内容里再遇到同类左括号就当这里没有括号（正则的 `[^()]*` 就是这个语义）
        let end = chars[index + 1..]
            .iter()
            .position(|ch| *ch == close || *ch == open)
            .filter(|offset| chars[index + 1 + offset] == close);
        let Some(end) = end else {
            out.push(chars[index]);
            index += 1;
            continue;
        };
        let inner: String = chars[index + 1..index + 1 + end].iter().collect();
        if contains_noise(&inner) {
            out.push(' ');
        } else {
            out.push(' ');
            out.push_str(&inner);
            out.push(' ');
        }
        index += end + 2;
    }
    out
}

/// `text` 的 `at` 处能匹配到的噪声词长度（字节）。
///
/// ASCII 噪声词必须卡词边界，否则 `live` 会把 `deliver` 打穿；`\b` 对 `feat.`
/// 这种以点结尾的不管用，所以照 Python 那样自己写"前后不跟字母数字"。
/// 候选按 `NOISE_PHRASES` 的顺序试，等价于正则 `|` 的最左优先。
fn noise_len_at(text: &str, at: usize) -> Option<usize> {
    let rest = &text[at..];
    for phrase in NOISE_PHRASES {
        if !rest.starts_with(phrase) {
            continue;
        }
        if phrase.is_ascii() {
            let before_ok = text[..at]
                .chars()
                .next_back()
                .is_none_or(|ch| !ch.is_ascii_alphanumeric());
            let after_ok = rest[phrase.len()..]
                .chars()
                .next()
                .is_none_or(|ch| !ch.is_ascii_alphanumeric());
            if !(before_ok && after_ok) {
                continue;
            }
        }
        return Some(phrase.len());
    }
    None
}

fn char_len_at(text: &str, at: usize) -> usize {
    text[at..].chars().next().map(char::len_utf8).unwrap_or(1)
}

fn contains_noise(text: &str) -> bool {
    let mut at = 0;
    while at < text.len() {
        if noise_len_at(text, at).is_some() {
            return true;
        }
        at += char_len_at(text, at);
    }
    false
}

fn strip_noise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if let Some(len) = noise_len_at(text, at) {
            out.push(' ');
            at += len;
        } else {
            let step = char_len_at(text, at);
            out.push_str(&text[at..at + step]);
            at += step;
        }
    }
    out
}

/// 归一化标题：去噪声后再抹掉全部标点与空白，只留字母数字和 CJK。
pub fn normalize_title(text: &str) -> String {
    clean(text)
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || is_cjk(*ch))
        .collect()
}

/// 标题分词。
///
/// 中文没有空格，按字切 token 粒度太粗（"我爱你" vs "你爱我" 会 100% 命中），
/// 所以 CJK 段落用**二元组**，既保留语序又不需要引入分词库。
pub fn title_tokens(text: &str) -> BTreeSet<String> {
    let cleaned = clean(text);
    let mut tokens = BTreeSet::new();
    let mut current = String::new();
    let mut current_is_cjk = false;

    let flush = |chunk: &str, cjk: bool, tokens: &mut BTreeSet<String>| {
        if chunk.is_empty() {
            return;
        }
        if !cjk {
            tokens.insert(chunk.to_string());
            return;
        }
        let chars: Vec<char> = chunk.chars().collect();
        if chars.len() <= 2 {
            tokens.insert(chunk.to_string());
        } else {
            for pair in chars.windows(2) {
                tokens.insert(pair.iter().collect());
            }
        }
    };

    for ch in cleaned.chars() {
        let (keep, cjk) = if ch.is_ascii_alphanumeric() {
            (true, false)
        } else if is_cjk(ch) {
            (true, true)
        } else {
            (false, false)
        };
        if !keep {
            flush(&current, current_is_cjk, &mut tokens);
            current.clear();
            continue;
        }
        if cjk != current_is_cjk && !current.is_empty() {
            flush(&current, current_is_cjk, &mut tokens);
            current.clear();
        }
        current_is_cjk = cjk;
        current.push(ch);
    }
    flush(&current, current_is_cjk, &mut tokens);
    tokens
}

/// 艺人分隔符里的单字符部分：`/ 、 & , ， ; ； | ｜`。
const ARTIST_SPLIT_CHARS: &[char] = &['/', '、', '&', ',', '，', ';', '；', '|', '｜'];

/// 艺人分隔符里的词：`feat.? ft.? vs.? with`，都要卡词边界。
/// 带点的排在不带点的前面，等价于正则里 `\.?` 的贪婪。
const ARTIST_SPLIT_WORDS: &[&str] = &["feat.", "feat", "ft.", "ft", "vs.", "vs", "with"];

/// `base` 的 `at` 处能匹配到的艺人分隔符长度（字节）；0 表示不是分隔符。
fn artist_separator_len_at(base: &str, at: usize) -> Option<usize> {
    let rest = &base[at..];
    let first = rest.chars().next()?;
    if ARTIST_SPLIT_CHARS.contains(&first) {
        return Some(first.len_utf8());
    }
    // `\sx\s`：两侧都带空白的单个 x 才算分隔符，"Max" 之类不能被切开
    if first.is_whitespace() {
        let mut chars = rest.chars();
        let a = chars.next()?;
        let b = chars.next()?;
        let c = chars.next()?;
        if b == 'x' && c.is_whitespace() {
            return Some(a.len_utf8() + b.len_utf8() + c.len_utf8());
        }
    }
    for word in ARTIST_SPLIT_WORDS {
        if !rest.starts_with(word) {
            continue;
        }
        let before_ok = base[..at]
            .chars()
            .next_back()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric());
        let after_ok = rest[word.len()..]
            .chars()
            .next()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric());
        if before_ok && after_ok {
            return Some(word.len());
        }
    }
    None
}

/// 艺人列表 → 归一化名字集合（拆 `/ 、 & , ， ; ； | ｜ feat. ft. vs. with x` 等分隔符）。
pub fn normalize_artists(artists: &[String]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for raw in artists {
        let base = nfkc_lite(raw).to_lowercase();
        let mut piece = String::new();
        let mut at = 0;
        let flush = |piece: &mut String, out: &mut BTreeSet<String>| {
            let name: String = piece
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || is_cjk(*ch))
                .collect();
            piece.clear();
            if !name.is_empty() && !UNKNOWN_ARTISTS.contains(&name.as_str()) {
                out.insert(name);
            }
        };
        while at < base.len() {
            if let Some(len) = artist_separator_len_at(&base, at) {
                flush(&mut piece, &mut out);
                at += len;
                continue;
            }
            let step = char_len_at(&base, at);
            piece.push_str(&base[at..at + step]);
            at += step;
        }
        flush(&mut piece, &mut out);
    }
    out
}

// ---------------------------------------------------------------- 相似度

pub fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    intersection / union
}

/// `difflib.SequenceMatcher.find_longest_match` 的直译。
///
/// 返回 `(a 起点, b 起点, 长度)`；`j2len` 那圈滚动 DP 就是 difflib 的原写法。
fn longest_match(
    left: &[char],
    alo: usize,
    ahi: usize,
    blo: usize,
    bhi: usize,
    b2j: &std::collections::HashMap<char, Vec<usize>>,
) -> (usize, usize, usize) {
    let (mut besti, mut bestj, mut bestsize) = (alo, blo, 0usize);
    let mut j2len: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for (i, ch) in left.iter().enumerate().take(ahi).skip(alo) {
        let mut newj2len: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();
        if let Some(positions) = b2j.get(ch) {
            for &j in positions {
                if j < blo {
                    continue;
                }
                if j >= bhi {
                    break;
                }
                // j == 0 时没有前驱，checked_sub 落到 None → 长度从 1 起算
                let k = j.checked_sub(1).and_then(|prev| j2len.get(&prev)).copied().unwrap_or(0) + 1;
                newj2len.insert(j, k);
                if k > bestsize {
                    besti = i + 1 - k;
                    bestj = j + 1 - k;
                    bestsize = k;
                }
            }
        }
        j2len = newj2len;
    }
    (besti, bestj, bestsize)
}

/// 递归拆出全部匹配块的总长度（difflib `get_matching_blocks` 的分治）。
fn matched_total(
    left: &[char],
    alo: usize,
    ahi: usize,
    blo: usize,
    bhi: usize,
    b2j: &std::collections::HashMap<char, Vec<usize>>,
) -> usize {
    if alo >= ahi || blo >= bhi {
        return 0;
    }
    let (i, j, k) = longest_match(left, alo, ahi, blo, bhi, b2j);
    if k == 0 {
        return 0;
    }
    k + matched_total(left, alo, i, blo, j, b2j) + matched_total(left, i + k, ahi, j + k, bhi, b2j)
}

/// 等价 Python `difflib.SequenceMatcher(None, a, b).ratio()`。
///
/// **不能**用最长公共子序列代替：LCS 允许交错取字符，difflib 用的是
/// Ratcliff/Obershelp 的"整块递归"，对调换了顺序的标题给分明显更低，
/// 而 0.82 这个合并阈值就卡在这条曲线上。
fn sequence_ratio(a: &str, b: &str) -> f64 {
    let left: Vec<char> = a.chars().collect();
    let right: Vec<char> = b.chars().collect();
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    // 长度封顶避免超长标题拖慢搜索（difflib 在 200 以上会启用 autojunk，
    // 正好也是这条线，截断反而更接近）
    let left = &left[..left.len().min(200)];
    let right = &right[..right.len().min(200)];

    let mut b2j: std::collections::HashMap<char, Vec<usize>> = std::collections::HashMap::new();
    for (j, ch) in right.iter().enumerate() {
        b2j.entry(*ch).or_default().push(j);
    }
    let matches = matched_total(left, 0, left.len(), 0, right.len(), &b2j);
    2.0 * matches as f64 / (left.len() + right.len()) as f64
}

/// token 集合 Jaccard × 0.5 + 序列相似度 × 0.5。
pub fn title_similarity(a: &str, b: &str) -> f64 {
    let ratio = sequence_ratio(&normalize_title(a), &normalize_title(b));
    jaccard(&title_tokens(a), &title_tokens(b)) * 0.5 + ratio * 0.5
}

pub fn artist_similarity(a: &[String], b: &[String]) -> f64 {
    let (left, right) = (normalize_artists(a), normalize_artists(b));
    if left.is_empty() || right.is_empty() {
        // 任一为空 → 中性，不奖不罚
        return 0.5;
    }
    let intersection = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    intersection / union
}

pub fn duration_similarity(a: Option<f64>, b: Option<f64>) -> f64 {
    let (Some(a), Some(b)) = (a, b) else {
        return 0.5;
    };
    let delta = (a - b).abs();
    if delta <= 3.0 {
        1.0
    } else if delta <= 8.0 {
        0.6
    } else {
        0.0
    }
}

/// 两个来源是同一首歌的把握程度，0..1。
pub fn same_song_score(a: &SongSource, b: &SongSource) -> f64 {
    0.6 * title_similarity(&a.title, &b.title)
        + 0.3 * artist_similarity(&a.artists, &b.artists)
        + 0.1 * duration_similarity(a.duration, b.duration)
}

// ---------------------------------------------------------------- 聚合

fn priority_table(priority: &[Platform]) -> BTreeMap<Platform, f64> {
    let mut table: BTreeMap<Platform, f64> = [
        Platform::Wyy,
        Platform::Qqm,
        Platform::Soundcloud,
        Platform::Bilibili,
        Platform::Local,
    ]
    .into_iter()
    .map(|platform| (platform, default_priority(platform)))
    .collect();
    // 步长 0.05 只是为了排序，绝对值无意义
    for (index, platform) in priority.iter().enumerate() {
        table.insert(*platform, 1.0 - index as f64 * 0.05);
    }
    table
}

/// 按各平台原排名交错遍历：先取各平台第 1 名，再各平台第 2 名……
///
/// 这样贪心聚类的"先到先成簇"才公平——如果一个平台一口气排完，
/// 它的第 20 名会先于别家的第 1 名建簇，簇的代表就偏了。
fn interleave(
    per_platform: &BTreeMap<Platform, Vec<SongSource>>,
    table: &BTreeMap<Platform, f64>,
) -> Vec<SongSource> {
    let mut platforms: Vec<Platform> = per_platform
        .iter()
        .filter(|(_, items)| !items.is_empty())
        .map(|(platform, _)| *platform)
        .collect();
    platforms.sort_by(|a, b| {
        table
            .get(b)
            .unwrap_or(&0.5)
            .total_cmp(table.get(a).unwrap_or(&0.5))
            .then_with(|| a.as_str().cmp(b.as_str()))
    });

    let depth = platforms
        .iter()
        .map(|platform| per_platform[platform].len())
        .max()
        .unwrap_or(0);
    let mut ordered = Vec::new();
    for rank in 0..depth {
        for platform in &platforms {
            if let Some(item) = per_platform[platform].get(rank) {
                ordered.push(item.clone());
            }
        }
    }
    ordered
}

/// 优先有 flac 标记的源，其次平台优先级。
fn best_source_index(sources: &[SongSource], table: &BTreeMap<Platform, f64>) -> usize {
    sources
        .iter()
        .enumerate()
        .min_by(|(ia, a), (ib, b)| {
            let key = |index: usize, src: &SongSource| {
                let has_flac = i32::from(src.max_quality == Some(kumodeck_core::models::Quality::Flac));
                (-has_flac, -table.get(&src.platform).unwrap_or(&0.5), index)
            };
            let (fa, pa, na) = key(*ia, a);
            let (fb, pb, nb) = key(*ib, b);
            fa.cmp(&fb).then(pa.total_cmp(&pb)).then(na.cmp(&nb))
        })
        .map(|(index, _)| index)
        .unwrap_or(0)
}

/// 排序后再哈希：同一组的 group_id 不随来源到达顺序变化，前端可以拿它当 React key。
fn group_id(sources: &[SongSource]) -> String {
    let mut parts: Vec<String> = sources
        .iter()
        .map(|src| format!("{}:{}", src.platform, src.key))
        .collect();
    parts.sort();
    let joined = parts.join("|");
    // 只是个稳定标识，不需要密码学强度
    let mut hash: u64 = 1469598103934665603;
    for byte in joined.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("{hash:016x}")
}

/// 把多平台结果聚合成 `MergedGroup` 列表（已按相关度降序排好）。
pub fn merge_results(
    query: &str,
    per_platform: &BTreeMap<Platform, Vec<SongSource>>,
    priority: &[Platform],
) -> Vec<MergedGroup> {
    let table = priority_table(priority);
    let ordered = interleave(per_platform, &table);

    // 组排序用的平台梯队（按用户拖出来的顺序）：
    // - 网易云和 QQ 是同质的音乐库平台，永远共用更靠前那个的位置——
    //   两家之间只按相关度混排，不会出现"上半截全网易云、下半截全 QQ"。
    // - B 站 / SoundCloud 这类特化来源按自己的拖动位置自成梯队：
    //   拖在最后就整块沉底（B 站标题天然含关键词，纯按相关度会霸榜）。
    let order_list: Vec<Platform> = if priority.is_empty() {
        let mut all: Vec<Platform> = table.keys().copied().collect();
        all.sort_by(|a, b| table[b].total_cmp(&table[a]));
        all
    } else {
        priority.to_vec()
    };
    let fallback_tier = order_list.len();
    let tier_of = |platform: Platform| -> usize {
        if matches!(platform, Platform::Wyy | Platform::Qqm) {
            [Platform::Wyy, Platform::Qqm]
                .iter()
                .filter_map(|twin| order_list.iter().position(|p| p == twin))
                .min()
                .unwrap_or(fallback_tier)
        } else {
            order_list
                .iter()
                .position(|p| *p == platform)
                .unwrap_or(fallback_tier)
        }
    };

    // 簇代表 = 第一个进簇的来源（先到先成簇），后来者只跟代表比，不做质心更新——
    // 质心会漂移，导致"A 像 B、B 像 C，于是 A 和 C 被并到一起"。
    let mut clusters: Vec<Vec<SongSource>> = Vec::new();
    let mut first_rank: Vec<usize> = Vec::new();
    for (index, source) in ordered.into_iter().enumerate() {
        let mut best: Option<(usize, f64)> = None;
        for (i, cluster) in clusters.iter().enumerate() {
            let value = same_song_score(&cluster[0], &source);
            if value >= SAME_SONG_THRESHOLD && best.is_none_or(|(_, current)| value >= current) {
                best = Some((i, value));
            }
        }
        match best {
            Some((i, _)) => clusters[i].push(source),
            None => {
                clusters.push(vec![source]);
                first_rank.push(index);
            }
        }
    }

    let mut ranked: Vec<(usize, f64, usize, MergedGroup)> = Vec::new();
    for (cluster, rank) in clusters.into_iter().zip(first_rank) {
        let best_index = best_source_index(&cluster, &table);
        let best = cluster[best_index].clone();
        // 用**去重后的平台数**而不是 len(sources)：同平台的多个版本（原版/live）
        // 也会落进同一簇，用原始条数会让"某平台重复收录"的歌不合理地排到前面。
        let platforms: HashSet<Platform> = cluster.iter().map(|src| src.platform).collect();
        let breadth = platforms.len().min(3) as f64 / 3.0;
        let relevance = title_similarity(query, &best.title);
        let score = ((breadth * 0.4 + relevance * 0.6) * 1_000_000.0).round() / 1_000_000.0;
        let tier = tier_of(best.platform);

        ranked.push((
            tier,
            score,
            rank,
            MergedGroup {
                group_id: group_id(&cluster),
                artists: if best.artists.is_empty() {
                    cluster
                        .iter()
                        .find(|src| !src.artists.is_empty())
                        .map(|src| src.artists.clone())
                        .unwrap_or_default()
                } else {
                    best.artists.clone()
                },
                album: if best.album.is_empty() {
                    cluster
                        .iter()
                        .find(|src| !src.album.is_empty())
                        .map(|src| src.album.clone())
                        .unwrap_or_default()
                } else {
                    best.album.clone()
                },
                duration: best
                    .duration
                    .or_else(|| cluster.iter().find_map(|src| src.duration)),
                cover: if best.cover.is_empty() {
                    cluster
                        .iter()
                        .find(|src| !src.cover.is_empty())
                        .map(|src| src.cover.clone())
                        .unwrap_or_default()
                } else {
                    best.cover.clone()
                },
                title: best.title,
                sources: cluster,
                best_source_index: best_index,
                score,
                in_library: false,
            },
        ));
    }

    // 分数相同时用"首个成员的原始名次"兜底，保证排序稳定可复现
    ranked.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    ranked.into_iter().map(|item| item.3).collect()
}

/// merge=false 时也给前端一份统一结构的 groups（一个来源一组）。
///
/// 前端的结果表只认 `groups`，这里返回空的话「不合并」开关一拨就是整页空白。
/// 顺序走 interleave 而不是按平台平铺：后者会让列表变成
/// "上半截全网易云、下半截全 QQ"，跨平台比价的意义就没了。
pub fn singleton_groups(
    per_platform: &BTreeMap<Platform, Vec<SongSource>>,
    priority: &[Platform],
) -> Vec<MergedGroup> {
    let table = priority_table(priority);
    interleave(per_platform, &table)
        .into_iter()
        .map(singleton_group)
        .collect()
}

/// 把单个来源包成一组。歌单/专辑解析出来的每一首也走这里，
/// 这样 group_id 的算法只有一处，前端拿它当 React key 才不会两套。
pub fn singleton_group(source: SongSource) -> MergedGroup {
    MergedGroup {
        group_id: group_id(std::slice::from_ref(&source)),
        title: source.title.clone(),
        artists: source.artists.clone(),
        album: source.album.clone(),
        duration: source.duration,
        cover: source.cover.clone(),
        best_source_index: 0,
        // 单来源没有"跨平台覆盖度"可言，分数留 0，和 Python 版一致
        score: 0.0,
        in_library: false,
        sources: vec![source],
    }
}

/// 曲库里已经有的 `platform:key` 集合。
///
/// 逐组查库太慢（一次搜索几十组），一次取回来在内存里比。取不到就当作空集：
/// 这个集合只影响一个角标，读失败不该让整条搜索接口失败。
pub fn library_source_keys(state: &AppState) -> HashSet<String> {
    let query = || -> anyhow::Result<HashSet<String>> {
        let conn = state.library.db().conn()?;
        let mut stmt = conn.prepare(
            "SELECT source_platform, source_key FROM tracks \
             WHERE source_key IS NOT NULL AND source_key <> ''",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(format!(
                "{}:{}",
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, String>(1)?
            ))
        })?;
        Ok(rows.filter_map(std::result::Result::ok).collect())
    };
    match query() {
        Ok(keys) => keys,
        Err(err) => {
            tracing::warn!("读取曲库来源索引失败：{err:#}");
            HashSet::new()
        }
    }
}

/// 给每一组打上「曲库里已经有了」的标记。
pub fn mark_in_library(groups: &mut [MergedGroup], known: &HashSet<String>) {
    for group in groups {
        group.in_library = group
            .sources
            .iter()
            .any(|source| known.contains(&format!("{}:{}", source.platform, source.key)));
    }
}

/// 并发搜索所有目标平台，然后聚合。
pub async fn search(state: &Arc<AppState>, payload: &SearchRequest) -> SearchResponse {
    let started = std::time::Instant::now();
    let mut errors: BTreeMap<String, String> = BTreeMap::new();
    let settings = state.config.to_settings();

    let mut targets: Vec<Platform> = Vec::new();
    for platform in &payload.platforms {
        if *platform == Platform::Local || targets.contains(platform) {
            continue;
        }
        if *platform == Platform::Soundcloud && !settings.soundcloud_enabled {
            errors.insert(platform.to_string(), "SoundCloud 未在设置中启用".into());
            continue;
        }
        if state.provider(*platform).is_none() {
            errors.insert(platform.to_string(), "平台不可用".into());
            continue;
        }
        targets.push(*platform);
    }

    // 各平台并发搜；某个平台卡住不该把整个请求拖死
    let mut handles = Vec::new();
    for platform in &targets {
        let provider = state.provider(*platform).cloned().expect("上面已确认存在");
        let keyword = payload.query.clone();
        let limit = payload.limit;
        let platform = *platform;
        handles.push(tokio::spawn(async move {
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(25),
                provider.search(&keyword, limit),
            )
            .await;
            (platform, result)
        }));
    }

    let mut per_platform: BTreeMap<Platform, Vec<SongSource>> = BTreeMap::new();
    for handle in handles {
        let Ok((platform, result)) = handle.await else {
            continue;
        };
        match result {
            Ok(Ok(items)) => {
                per_platform.insert(platform, items);
            }
            Ok(Err(err)) => {
                errors.insert(platform.to_string(), format!("{err:#}"));
            }
            Err(_) => {
                errors.insert(platform.to_string(), "搜索超时".into());
            }
        }
    }

    // 梯队和优先级用**请求里原样的** platforms，不是过滤后的 targets：
    // 网易云和 QQ 共用靠前那一个的梯队，其中一家没搜（未登录/provider 缺失）时，
    // 另一家仍然应该继承它的位置——用 targets 的话 B 站会趁虚上浮到音乐平台前面。
    let mut groups = if payload.merge {
        merge_results(&payload.query, &per_platform, &payload.platforms)
    } else {
        // 不合并时也要给出 groups：前端结果表只认它，空数组等于整页空白
        singleton_groups(&per_platform, &payload.platforms)
    };
    // 「已在库」角标：一次取回曲库里的来源键，在内存里比
    mark_in_library(&mut groups, &library_source_keys(state));

    SearchResponse {
        query: payload.query.clone(),
        groups,
        per_platform: per_platform
            .into_iter()
            .map(|(platform, items)| (platform.to_string(), items))
            .collect(),
        errors,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(platform: Platform, title: &str, artists: &[&str], duration: f64) -> SongSource {
        SongSource {
            platform,
            key: format!("{platform}-{title}"),
            title: title.into(),
            artists: artists.iter().map(|a| (*a).to_string()).collect(),
            album: String::new(),
            duration: Some(duration),
            cover: String::new(),
            max_quality: None,
            vip: false,
            payload: Default::default(),
        }
    }

    #[test]
    fn fullwidth_text_is_normalized() {
        assert_eq!(nfkc_lite("（Ａ）"), "(A)");
        assert_eq!(normalize_title("（Ａ Ｂ）"), "ab");
    }

    #[test]
    fn halfwidth_katakana_folds_like_python_nfkc() {
        // 期望值是跑 sidecar 的 aggregate.normalize_title 抄回来的
        assert_eq!(normalize_title("ｱｲﾄﾞﾙ"), "アイドル", "浊点要和前一个假名合成");
        assert_eq!(normalize_title("ﾊﾟﾌﾟﾋﾟﾍﾟﾎﾟ"), "パプピペポ", "半浊点同理");
        assert_eq!(normalize_title("ｳﾞｧﾝﾊﾟｲｱ"), "ヴァンパイア");
        assert_eq!(normalize_title("ﾜﾞ"), "ヷ", "ウ/ワ/ヲ 的浊音不是简单的 +1");
        assert_eq!(normalize_title("ｶﾞｰﾙ"), "ガール");
        // 半角标点折过来之后仍然是分词边界，不能进 token
        assert_eq!(tokens("ｱ、ｲ"), vec!["ア", "イ"]);
        assert_eq!(
            normalize_artists(&["ｱ、ｲ".to_string()])
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["ア", "イ"],
            "半角顿号折成全角顿号之后要能拆开艺人"
        );
    }

    #[test]
    fn two_different_halfwidth_katakana_titles_do_not_merge() {
        // 不做兼容折叠的话这两条都会被归一化成空串，而空串之间的相似度是 1.0，
        // 于是任意两首这样的日文歌都会被并成一组——这是最容易漏掉的一种错并
        let similarity = title_similarity("ｱｲﾄﾞﾙ", "ﾃﾞｼﾞﾀﾙ");
        assert!(
            (similarity - 0.125).abs() < 1e-6,
            "Python 给 0.125，这里算出 {similarity}"
        );
        assert!(similarity < SAME_SONG_THRESHOLD);
        // 同一首歌写成半角/全角要认得出是同一首
        assert!((title_similarity("ｱｲﾄﾞﾙ", "アイドル") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn roman_numerals_survive_normalization() {
        // 丢掉罗马数字的话「夜曲Ⅱ」和「夜曲Ⅲ」会归一成同一串
        assert_eq!(normalize_title("夜曲Ⅱ"), "夜曲ii");
        assert_eq!(normalize_title("夜曲Ⅲ"), "夜曲iii");
        let similarity = title_similarity("夜曲Ⅱ", "夜曲Ⅲ");
        assert!(
            (similarity - 0.611111).abs() < 1e-6,
            "Python 给 0.611111，这里算出 {similarity}"
        );
        assert!(similarity < SAME_SONG_THRESHOLD, "不该被并成同一首");
    }

    #[test]
    fn noise_in_brackets_is_dropped_but_content_is_kept() {
        // "(Remastered)" 是噪声，"(Part 2)" 是内容
        assert_eq!(normalize_title("Song (Remastered)"), "song");
        assert_eq!(normalize_title("Song (Part 2)"), "songpart2");
    }

    #[test]
    fn cjk_titles_tokenize_as_bigrams_preserving_order() {
        // 按字切的话「我爱你」和「你爱我」会完全命中
        let a = title_tokens("我爱你");
        let b = title_tokens("你爱我");
        assert!(jaccard(&a, &b) < 1.0, "a={a:?} b={b:?}");
    }

    #[test]
    fn the_same_song_from_two_platforms_merges() {
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Wyy,
            vec![source(Platform::Wyy, "Supernova", &["aespa"], 178.0)],
        );
        per_platform.insert(
            Platform::Qqm,
            vec![source(Platform::Qqm, "Supernova", &["aespa"], 178.0)],
        );
        let groups = merge_results("Supernova", &per_platform, &[Platform::Wyy, Platform::Qqm]);
        assert_eq!(groups.len(), 1, "同一首歌应当并成一组");
        assert_eq!(groups[0].sources.len(), 2);
    }

    #[test]
    fn different_songs_do_not_merge() {
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Wyy,
            vec![
                source(Platform::Wyy, "Supernova", &["aespa"], 178.0),
                source(Platform::Wyy, "完全に別の曲", &["別人"], 240.0),
            ],
        );
        let groups = merge_results("Supernova", &per_platform, &[Platform::Wyy]);
        assert_eq!(groups.len(), 2);
    }

    #[test]
    fn bilibili_dragged_last_sinks_below_music_platforms() {
        // B 站标题天然含关键词，纯按相关度会霸榜；拖到最后就该整块沉底
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Bilibili,
            vec![source(Platform::Bilibili, "Supernova", &["up主"], 180.0)],
        );
        per_platform.insert(
            Platform::Wyy,
            vec![source(Platform::Wyy, "Supernova Love", &["IVE"], 199.0)],
        );
        let groups = merge_results(
            "Supernova",
            &per_platform,
            &[Platform::Wyy, Platform::Qqm, Platform::Bilibili],
        );
        assert_eq!(groups.len(), 2);
        assert_eq!(
            groups[0].sources[0].platform,
            Platform::Wyy,
            "即使 B 站标题更贴合，也该排在音乐平台之后"
        );
    }

    #[test]
    fn a_missing_twin_still_lends_its_tier() {
        // 用户把顺序拖成 [qqm, bilibili, wyy]，但 QQ 这次没搜到/没登录。
        // 网易云仍然要继承 QQ 那个更靠前的梯队，否则 B 站会趁虚上浮到它前面。
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Bilibili,
            vec![source(Platform::Bilibili, "Supernova", &["up主"], 180.0)],
        );
        per_platform.insert(
            Platform::Wyy,
            vec![source(Platform::Wyy, "Supernova Love", &["IVE"], 199.0)],
        );
        let groups = merge_results(
            "Supernova",
            &per_platform,
            &[Platform::Qqm, Platform::Bilibili, Platform::Wyy],
        );
        assert_eq!(
            groups[0].sources[0].platform,
            Platform::Wyy,
            "梯队要按请求里原样的 platforms 算，不是按实际搜了哪几家"
        );
    }

    #[test]
    fn wyy_and_qqm_share_a_tier() {
        // 两家同质，不该出现"上半截全网易云、下半截全 QQ"
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Wyy,
            vec![source(Platform::Wyy, "远的一首", &["A"], 200.0)],
        );
        per_platform.insert(
            Platform::Qqm,
            vec![source(Platform::Qqm, "Supernova", &["aespa"], 178.0)],
        );
        let groups = merge_results("Supernova", &per_platform, &[Platform::Wyy, Platform::Qqm]);
        assert_eq!(
            groups[0].sources[0].platform,
            Platform::Qqm,
            "同梯队内按相关度排，QQ 的更贴合就该在前"
        );
    }

    #[test]
    fn group_id_is_stable_regardless_of_arrival_order() {
        let a = source(Platform::Wyy, "S", &["x"], 100.0);
        let b = source(Platform::Qqm, "S", &["x"], 100.0);
        assert_eq!(
            group_id(&[a.clone(), b.clone()]),
            group_id(&[b, a]),
            "前端拿它当 React key，顺序变了 key 不能变"
        );
    }

    #[test]
    fn not_merging_still_yields_one_group_per_source() {
        // 前端的结果表只认 groups：这里返回空的话，「不合并」开关一拨就是整页空白
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Wyy,
            vec![
                source(Platform::Wyy, "w1", &["a"], 100.0),
                source(Platform::Wyy, "w2", &["a"], 100.0),
            ],
        );
        per_platform.insert(Platform::Qqm, vec![source(Platform::Qqm, "q1", &["a"], 100.0)]);

        let groups = singleton_groups(&per_platform, &[Platform::Wyy, Platform::Qqm]);
        let titles: Vec<&str> = groups.iter().map(|g| g.title.as_str()).collect();
        // 顺序走交错遍历，不能是"上半截全网易云、下半截全 QQ"
        assert_eq!(titles, vec!["w1", "q1", "w2"]);
        assert!(groups.iter().all(|g| g.sources.len() == 1));
        assert!(groups.iter().all(|g| g.best_source_index == 0));
    }

    #[test]
    fn singleton_group_ids_match_the_merged_path() {
        // 两条路径必须用同一套 group_id，前端拿它当 React key
        let one = source(Platform::Wyy, "S", &["x"], 100.0);
        let group = singleton_group(one.clone());
        assert_eq!(group.group_id, group_id(&[one]));
    }

    #[test]
    fn in_library_lights_up_when_any_source_is_already_downloaded() {
        let mut group = singleton_group(source(Platform::Qqm, "S", &["x"], 100.0));
        let key = format!("{}:{}", Platform::Qqm, group.sources[0].key);

        mark_in_library(std::slice::from_mut(&mut group), &HashSet::new());
        assert!(!group.in_library);

        mark_in_library(std::slice::from_mut(&mut group), &HashSet::from([key]));
        assert!(group.in_library, "曲库里已经有这一条来源，角标要亮");
    }

    #[test]
    fn in_library_does_not_match_across_platforms() {
        // 键必须是 "平台:key"，只比 key 的话网易云的 123 会点亮 QQ 的 123
        let mut group = singleton_group(source(Platform::Qqm, "S", &["x"], 100.0));
        let foreign = format!("{}:{}", Platform::Wyy, group.sources[0].key);
        mark_in_library(std::slice::from_mut(&mut group), &HashSet::from([foreign]));
        assert!(!group.in_library);
    }

    #[test]
    fn flac_sources_win_the_best_source_slot() {
        let table = priority_table(&[Platform::Wyy, Platform::Qqm]);
        let plain = source(Platform::Wyy, "S", &["x"], 100.0);
        let mut lossless = source(Platform::Qqm, "S", &["x"], 100.0);
        lossless.max_quality = Some(kumodeck_core::models::Quality::Flac);
        // 网易云优先级更高，但 QQ 这条有 flac
        assert_eq!(best_source_index(&[plain, lossless], &table), 1);
    }

    #[test]
    fn interleave_takes_one_from_each_platform_per_round() {
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Wyy,
            vec![
                source(Platform::Wyy, "w1", &[], 1.0),
                source(Platform::Wyy, "w2", &[], 1.0),
            ],
        );
        per_platform.insert(Platform::Qqm, vec![source(Platform::Qqm, "q1", &[], 1.0)]);
        let table = priority_table(&[Platform::Wyy, Platform::Qqm]);
        let ordered = interleave(&per_platform, &table);
        let titles: Vec<&str> = ordered.iter().map(|src| src.title.as_str()).collect();
        assert_eq!(titles, vec!["w1", "q1", "w2"]);
    }

    #[test]
    fn duration_similarity_has_three_bands() {
        assert_eq!(duration_similarity(Some(180.0), Some(182.0)), 1.0);
        assert_eq!(duration_similarity(Some(180.0), Some(185.0)), 0.6);
        assert_eq!(duration_similarity(Some(180.0), Some(240.0)), 0.0);
        assert_eq!(duration_similarity(None, Some(180.0)), 0.5, "缺值中性");
    }

    #[test]
    fn unknown_artists_are_ignored_when_comparing() {
        let known = normalize_artists(&["aespa".into()]);
        let unknown = normalize_artists(&["群星".into(), "Unknown".into()]);
        assert!(unknown.is_empty(), "占位艺人名不该参与比对：{unknown:?}");
        assert!(!known.is_empty());
    }

    // ------------------------------------------------------------ 与 Python 对拍
    //
    // 下面这些期望值是跑 `sidecar/kumodeck/aggregate.py` 抄回来的，不是推导出来的。
    // 归一化只要和参照实现差一点，0.82 这个合并阈值两边就会在不同的歌上翻车。

    fn tokens(text: &str) -> Vec<String> {
        title_tokens(text).into_iter().collect()
    }

    #[test]
    fn ascii_noise_words_only_match_on_word_boundaries() {
        // 这一组全都是"噪声词是别的词的子串"：直接做子串替换会把它们打穿
        assert_eq!(normalize_title("Deliver Me"), "deliverme", "live ⊂ deliver");
        assert_eq!(normalize_title("Feather"), "feather", "feat ⊂ feather");
        assert_eq!(normalize_title("MVP"), "mvp", "mv ⊂ mvp");
        assert_eq!(normalize_title("Demolition"), "demolition", "demo ⊂ demolition");
        assert_eq!(normalize_title("Software"), "software", "ft ⊂ software");
        // 真的独立成词时才该被抹掉
        assert_eq!(normalize_title("Live Forever"), "forever");
        assert_eq!(normalize_title("Cover Me"), "me");
        assert_eq!(normalize_title("Song feat. Someone"), "songsomeone");
    }

    #[test]
    fn cjk_noise_words_match_the_python_list() {
        assert_eq!(normalize_title("HQ 高清 完整版 夜曲"), "夜曲");
        assert_eq!(normalize_title("夜曲 (现场版)"), "夜曲");
        assert_eq!(normalize_title("夜曲 纯音乐 动态歌词"), "夜曲");
    }

    #[test]
    fn brackets_do_not_span_a_nested_open_bracket() {
        // Python 的 `\([^()]*\)` 只会命中里层的 `(c)`，外层那对当普通字符
        assert_eq!(normalize_title("a (b (c) d)"), "abcd");
        assert_eq!(normalize_title("X (Live Version)"), "x");
        assert_eq!(normalize_title("Song (Official Video)"), "song");
        assert_eq!(tokens("Song (Part 2)"), vec!["2", "part", "song"]);
    }

    #[test]
    fn artist_separators_match_the_python_regex() {
        let split = |raw: &str| -> Vec<String> {
            normalize_artists(&[raw.to_string()]).into_iter().collect()
        };
        for raw in ["A feat. B", "A ft B", "A vs. B", "A with B", "A x B"] {
            assert_eq!(split(raw), vec!["a", "b"], "{raw}");
        }
        assert_eq!(split("A|B"), vec!["a", "b"], "竖线也是分隔符");
        assert_eq!(split("C｜D"), vec!["c", "d"], "全角竖线同理");
        assert_eq!(
            split("A/B、C&D,E，F;G；H"),
            vec!["a", "b", "c", "d", "e", "f", "g", "h"]
        );
        // 分隔符同样要卡词边界，否则艺人名会被拦腰截断
        assert_eq!(split("Daft Punk"), vec!["daftpunk"], "ft ⊂ daft");
        assert_eq!(split("Featherweight"), vec!["featherweight"]);
        assert_eq!(split("Max Cooper"), vec!["maxcooper"], "x 两侧要带空格才算分隔符");
    }

    #[test]
    fn sequence_ratio_matches_difflib_not_lcs() {
        // 这三组是随机对拍里挑出来的"最长公共子序列会明显高估"的例子。
        // 期望值来自 difflib.SequenceMatcher(None, a, b).ratio()。
        for (a, b, expected) in [
            ("cccdaadd", "dcabac", 0.285714),
            ("cbdbb", "bbcb", 0.444444),
            ("ddbddbd", "aabcdc", 0.153846),
            ("adcaba", "bcccbad", 0.307692),
        ] {
            let got = sequence_ratio(a, b);
            assert!(
                (got - expected).abs() < 1e-6,
                "{a} vs {b}：difflib 给 {expected}，这里算出 {got}"
            );
        }
    }

    #[test]
    fn title_similarity_matches_the_python_reference() {
        for (a, b, expected) in [
            ("Supernova", "Supernova Love", 0.659091),
            ("Hello World", "World Hello", 0.75),
            ("Song", "Song (Remastered)", 1.0),
            ("夜曲", "夜的第七章", 0.142857),
        ] {
            let got = title_similarity(a, b);
            assert!(
                (got - expected).abs() < 1e-6,
                "{a} vs {b}：Python 给 {expected}，这里算出 {got}"
            );
        }
    }

    #[test]
    fn not_merging_still_returns_one_group_per_source() {
        // merge=false 时返回空 groups 的话，前端结果表就是整页空白
        let mut per_platform = BTreeMap::new();
        per_platform.insert(
            Platform::Wyy,
            vec![
                source(Platform::Wyy, "w1", &[], 1.0),
                source(Platform::Wyy, "w2", &[], 1.0),
            ],
        );
        per_platform.insert(Platform::Qqm, vec![source(Platform::Qqm, "q1", &[], 1.0)]);
        let groups = singleton_groups(&per_platform, &[Platform::Wyy, Platform::Qqm]);
        let titles: Vec<&str> = groups.iter().map(|g| g.title.as_str()).collect();
        assert_eq!(titles, vec!["w1", "q1", "w2"], "顺序要交错，不是按平台分块");
        assert!(groups.iter().all(|g| g.sources.len() == 1));
    }

    #[test]
    fn the_in_library_badge_matches_on_platform_and_key() {
        let mut groups = vec![
            singleton_group(source(Platform::Wyy, "有", &[], 1.0)),
            singleton_group(source(Platform::Qqm, "没有", &[], 1.0)),
        ];
        let known: HashSet<String> = ["wyy:wyy-有".to_string()].into_iter().collect();
        mark_in_library(&mut groups, &known);
        assert!(groups[0].in_library);
        assert!(!groups[1].in_library, "同名不同平台不能算命中");
    }
}

// ---------------------------------------------------------------- 批量投喂

/// 把粘贴进来的一大段文本拆成若干条"关键词或链接"。
///
/// 拆分规则（顺序很重要）：
/// 1. 只要正文里出现换行，就**只按换行拆**。多行粘贴时按逗号再拆会毁掉
///    `曲名 - 艺人A, 艺人B` 这种行——艺人名里的逗号非常常见。
/// 2. 完全没有换行时（单行粘贴），才按 `, ， 、 ; ； Tab` 拆。
/// 3. 任何一条里如果含 URL，就把 URL 抽出来单独成条：一行里贴了好几个
///    分享链接是很常见的粘贴方式。
///
/// 返回 `(条目, 被 max_entries 截掉的条数)`。条目去重且保持原顺序。
pub fn split_intake_text(text: &str, max_entries: usize) -> (Vec<String>, usize) {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let raw_lines: Vec<String> = if normalized.contains('\n') {
        normalized.split('\n').map(str::to_string).collect()
    } else {
        normalized
            .split([',', '，', '、', ';', '；', '\t'])
            .map(str::to_string)
            .collect()
    };

    let mut entries: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |value: &str, entries: &mut Vec<String>| {
        // 零宽空格：从网页复制分享文案时经常夹带
        let cleaned = value.trim().trim_matches('\u{200b}').trim();
        if cleaned.is_empty() || !seen.insert(cleaned.to_string()) {
            return;
        }
        entries.push(cleaned.to_string());
    };

    for line in &raw_lines {
        let urls = extract_urls(line);
        if urls.is_empty() {
            push(line, &mut entries);
            continue;
        }
        for url in urls {
            push(&url, &mut entries);
        }
        // 链接以外的残余文字（"分享单曲 xxx https://..."）不再当关键词，
        // 那基本都是分享话术，搜出来全是噪声。
    }

    if entries.len() <= max_entries {
        return (entries, 0);
    }
    let skipped = entries.len() - max_entries;
    entries.truncate(max_entries);
    (entries, skipped)
}

/// URL 的终止符。对齐 Python 的 `[^\s，,、；;）)】\]]+`：
/// **任何**空白都算（全角空格已经在这一步之前被转成半角，但换行之类仍要挡住）。
///
/// 引号不在 Python 那张表里，但从网页复制时 URL 后面紧跟一个引号非常常见，
/// 吃进去必然解析失败——多挡这两个字符是有意的收紧。
fn is_url_stop(ch: char) -> bool {
    ch.is_whitespace() || "，,、；;）)】]\"'".contains(ch)
}

/// 协议头的长度；不是 URL 开头就返回 None。大小写不敏感（Python 那条正则带 IGNORECASE）。
fn url_scheme_len(text: &str) -> Option<usize> {
    let lowered = text.to_ascii_lowercase();
    if lowered.starts_with("https://") {
        Some(8)
    } else if lowered.starts_with("http://") {
        Some(7)
    } else {
        None
    }
}

fn extract_urls(text: &str) -> Vec<String> {
    // to_ascii_lowercase 逐字节映射，不会改变长度，下标可以直接拿回原串上切
    let lowered = text.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(offset) = lowered[at..].find("http") {
        let start = at + offset;
        let Some(scheme) = url_scheme_len(&text[start..]) else {
            at = start + 4;
            continue;
        };
        let body = &text[start + scheme..];
        let end = body.find(is_url_stop).unwrap_or(body.len());
        if end == 0 {
            // `http://` 后面空空如也，Python 那条正则的 `+` 同样不认
            at = start + scheme;
            continue;
        }
        out.push(text[start..start + scheme + end].to_string());
        at = start + scheme + end;
    }
    out
}

pub fn is_url(entry: &str) -> bool {
    let trimmed = entry.trim();
    let Some(scheme) = url_scheme_len(trimmed) else {
        return false;
    };
    trimmed[scheme..]
        .chars()
        .next()
        .is_some_and(|ch| !is_url_stop(ch))
}

#[cfg(test)]
mod intake_tests {
    use super::*;

    #[test]
    fn multiline_input_splits_only_on_newlines() {
        // 艺人名里的逗号非常常见，多行粘贴时再按逗号拆会把这一行毁掉
        let (entries, skipped) =
            split_intake_text("曲名 - 艺人A, 艺人B\n另一首 - 艺人C", 50);
        assert_eq!(entries, vec!["曲名 - 艺人A, 艺人B", "另一首 - 艺人C"]);
        assert_eq!(skipped, 0);
    }

    #[test]
    fn single_line_input_splits_on_inline_separators() {
        let (entries, _) = split_intake_text("歌一，歌二、歌三;歌四", 50);
        assert_eq!(entries, vec!["歌一", "歌二", "歌三", "歌四"]);
    }

    #[test]
    fn urls_are_extracted_and_the_share_boilerplate_is_dropped() {
        let (entries, _) = split_intake_text(
            "分享单曲《夜曲》https://music.163.com/song?id=1 来自网易云",
            50,
        );
        assert_eq!(entries, vec!["https://music.163.com/song?id=1"]);
    }

    #[test]
    fn several_links_on_one_line_each_become_an_entry() {
        let (entries, _) = split_intake_text(
            "https://music.163.com/song?id=1 https://y.qq.com/n/ryqq/songDetail/abc",
            50,
        );
        assert_eq!(entries.len(), 2);
        assert!(entries[1].contains("y.qq.com"));
    }

    #[test]
    fn duplicates_are_collapsed_keeping_the_first_position() {
        let (entries, _) = split_intake_text("A\nB\nA\nC", 50);
        assert_eq!(entries, vec!["A", "B", "C"]);
    }

    #[test]
    fn entries_beyond_the_cap_are_reported_not_silently_dropped() {
        let text = (1..=60).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let (entries, skipped) = split_intake_text(&text, 50);
        assert_eq!(entries.len(), 50);
        assert_eq!(skipped, 10);
    }

    #[test]
    fn urls_are_recognised() {
        assert!(is_url("https://music.163.com/song?id=1"));
        assert!(is_url("  http://a.b  "));
        assert!(!is_url("夜曲 周杰伦"));
    }

    #[test]
    fn the_scheme_is_matched_case_insensitively() {
        // 微信/QQ 复制出来的分享文案里 HTTPS 大写并不罕见；
        // 认不出来就会被当成关键词拿去搜索，结果全是噪声
        assert!(is_url("HTTPS://music.163.com/song?id=1"));
        let (entries, _) = split_intake_text("看这个 Http://b23.tv/abc", 50);
        assert_eq!(entries, vec!["Http://b23.tv/abc"]);
    }

    #[test]
    fn a_bare_scheme_is_not_a_url() {
        // Python 那条正则的 `+` 要求协议后至少有一个字符
        assert!(!is_url("https://"));
        assert!(!is_url("http:// 夜曲"));
        assert_eq!(split_intake_text("https:// 夜曲", 50).0, vec!["https:// 夜曲"]);
    }

    #[test]
    fn trailing_punctuation_is_not_swallowed_into_the_url() {
        // 单行输入先按 `，` 拆，所以尾巴会成为独立的一条关键词——
        // 链接本身不能把标点吃进去，这才是这条要盯的
        let (entries, _) = split_intake_text("看这个 https://b23.tv/abc，还有别的", 50);
        assert_eq!(entries, vec!["https://b23.tv/abc", "还有别的"]);
    }
}
