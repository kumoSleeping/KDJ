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
    "album version",
    "single version",
    "remastered",
    "remaster",
    "instrumental",
    "official audio",
    "official video",
    "official mv",
    "lyric video",
    "audio",
    "hd",
    "hq",
    "mv",
    "live",
    "cover",
    "feat",
    "ft",
    "高音质",
    "无损",
    "官方",
    "完整版",
    "试听",
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

/// 全角 → 半角。中文平台的标题里全角括号/空格非常常见。
fn to_halfwidth(text: &str) -> String {
    text.chars()
        .map(|ch| {
            let code = ch as u32;
            if code == 0x3000 {
                ' '
            } else if (0xFF01..=0xFF5E).contains(&code) {
                char::from_u32(code - 0xFEE0).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect()
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x309F | 0x30A0..=0x30FF | 0xAC00..=0xD7AF)
}

/// 小写 + 全角转半角 + 去括号噪声 + 去散落噪声词，**保留空格**（分词还要用）。
fn clean(text: &str) -> String {
    let lowered = to_halfwidth(text).to_lowercase();
    let unbracketed = drop_brackets(&lowered);
    let denoised = strip_noise(&unbracketed);
    denoised.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 括号里含噪声词 → 整段丢掉；否则只脱掉括号，保留内容。
///
/// `(Part 2)` 这种是内容不是噪声，丢了会把两首不同的歌合并。
fn drop_brackets(text: &str) -> String {
    const PAIRS: [(char, char); 4] = [('(', ')'), ('（', '）'), ('[', ']'), ('【', '】')];
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let Some((_, close)) = PAIRS.iter().find(|(open, _)| *open == chars[index]) else {
            out.push(chars[index]);
            index += 1;
            continue;
        };
        let Some(end) = chars[index + 1..].iter().position(|ch| ch == close) else {
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

fn contains_noise(text: &str) -> bool {
    NOISE_PHRASES.iter().any(|phrase| text.contains(phrase))
}

fn strip_noise(text: &str) -> String {
    let mut out = text.to_string();
    for phrase in NOISE_PHRASES {
        out = out.replace(phrase, " ");
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

    let mut flush = |chunk: &str, cjk: bool, tokens: &mut BTreeSet<String>| {
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

/// 艺人列表 → 归一化名字集合（拆 `/ 、 & , feat. ft.` 等分隔符）。
pub fn normalize_artists(artists: &[String]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for raw in artists {
        let base = to_halfwidth(raw).to_lowercase();
        for piece in base.split(['/', '、', '&', ',', ';', '，', '；']) {
            let piece = piece
                .replace("feat.", " ")
                .replace("feat", " ")
                .replace("ft.", " ")
                .replace(" ft ", " ");
            let name: String = piece
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || is_cjk(*ch))
                .collect();
            if !name.is_empty() && !UNKNOWN_ARTISTS.contains(&name.as_str()) {
                out.insert(name);
            }
        }
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

/// 最长公共子序列比，等价 Python `SequenceMatcher.ratio()` 的量级。
fn sequence_ratio(a: &str, b: &str) -> f64 {
    let left: Vec<char> = a.chars().collect();
    let right: Vec<char> = b.chars().collect();
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    // 滚动数组的 LCS，长度封顶避免超长标题拖慢搜索
    let (left, right) = (
        &left[..left.len().min(200)],
        &right[..right.len().min(200)],
    );
    let mut prev = vec![0usize; right.len() + 1];
    let mut current = vec![0usize; right.len() + 1];
    for i in 0..left.len() {
        for j in 0..right.len() {
            current[j + 1] = if left[i] == right[j] {
                prev[j] + 1
            } else {
                current[j].max(prev[j + 1])
            };
        }
        std::mem::swap(&mut prev, &mut current);
        current.iter_mut().for_each(|slot| *slot = 0);
    }
    2.0 * prev[right.len()] as f64 / (left.len() + right.len()) as f64
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

    let groups = if payload.merge {
        merge_results(&payload.query, &per_platform, &targets)
    } else {
        Vec::new()
    };

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
        assert_eq!(to_halfwidth("（Ａ）"), "(A)");
        assert_eq!(normalize_title("（Ａ Ｂ）"), "ab");
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
}
