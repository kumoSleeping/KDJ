//! 拿用户真实曲库（1379 首）跑一遍查询层。
//!
//! 单元测试用的是造出来的几行数据，覆盖不到"真实数据的形状"——
//! 空 camelot、NULL bpm、同一首歌在多个 set 里各有一份，这些只有真库里才有。
//!
//! 库文件路径由 `KUMODECK_TEST_DB` 指定；没设就跳过（CI 上没有这个文件）。
//! **只读**：测试前会先拷一份到临时目录，绝不碰用户的原始数据。

use std::path::PathBuf;

use kumodeck_library::service::{LibraryService, TrackQuery};
use kumodeck_library::Database;

fn open_real_library() -> Option<LibraryService> {
    let source = PathBuf::from(std::env::var("KUMODECK_TEST_DB").ok()?);
    if !source.is_file() {
        return None;
    }
    // 拷贝而不是直接开：WAL 模式会写 -wal/-shm，绝不能碰用户的原库
    let scratch = std::env::temp_dir().join(format!(
        "kumodeck-real-lib-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&scratch).ok()?;
    let target = scratch.join("copy.db");
    std::fs::copy(&source, &target).ok()?;
    Some(LibraryService::new(Database::open(&target).ok()?))
}

macro_rules! real_library {
    () => {
        match open_real_library() {
            Some(service) => service,
            None => {
                eprintln!("跳过：没有设置 KUMODECK_TEST_DB");
                return;
            }
        }
    };
}

fn base_query() -> TrackQuery {
    TrackQuery {
        limit: 200,
        sort: "added_at".into(),
        order: "desc".into(),
        ..Default::default()
    }
}

#[test]
fn opening_a_real_database_does_not_migrate_data_away() {
    let service = real_library!();
    let stats = service.stats().unwrap();
    assert!(stats.total > 1000, "曲目数 {}", stats.total);
    assert!(stats.analyzed > 0, "已分析 {}", stats.analyzed);
    assert!(stats.total_duration > 0.0);
    // 真库里各种调号都有
    assert!(
        stats.by_camelot.len() > 10,
        "调号分布 {:?}",
        stats.by_camelot
    );
    assert!(!stats.by_bpm_bucket.is_empty());
}

#[test]
fn listing_paginates_consistently() {
    let service = real_library!();
    let mut query = base_query();
    query.limit = 50;
    let first = service.list_tracks(&query).unwrap();
    assert_eq!(first.items.len(), 50);
    assert!(first.total > 1000);

    query.offset = 50;
    let second = service.list_tracks(&query).unwrap();
    // 分页不能重复：第二页的 id 不应该出现在第一页里
    let first_ids: std::collections::HashSet<i64> =
        first.items.iter().map(|track| track.id).collect();
    assert!(
        second
            .items
            .iter()
            .all(|track| !first_ids.contains(&track.id)),
        "分页出现重复曲目"
    );
}

#[test]
fn camelot_sort_puts_10a_after_9a_not_before_8a() {
    let service = real_library!();
    let mut query = base_query();
    query.sort = "camelot".into();
    query.order = "asc".into();
    query.limit = 2000;
    let page = service.list_tracks(&query).unwrap();

    // 取出有调号的那些，检查排序键是单调的
    let keys: Vec<(u32, char)> = page
        .items
        .iter()
        .filter(|track| !track.camelot.is_empty())
        .filter_map(|track| kumodeck_library::camelot::split_camelot(&track.camelot))
        .collect();
    assert!(keys.len() > 100, "有调号的曲目太少：{}", keys.len());

    let ranks: Vec<u32> = keys
        .iter()
        .map(|(number, letter)| number * 2 + u32::from(*letter == 'B'))
        .collect();
    assert!(
        ranks.windows(2).all(|pair| pair[0] <= pair[1]),
        "调号排序不是单调的——字符串排序会把 10A 排到 8A 前面"
    );
}

#[test]
fn key_filter_accepts_both_camelot_and_key_names() {
    let service = real_library!();
    let mut query = base_query();
    query.limit = 2000;

    query.key = "8A".into();
    let by_code = service.list_tracks(&query).unwrap();
    query.key = "A minor".into();
    let by_name = service.list_tracks(&query).unwrap();

    assert!(by_code.total > 0, "真库里应当有 8A 的曲目");
    assert_eq!(
        by_code.total, by_name.total,
        "「8A」和「A minor」必须命中同一批"
    );
    assert!(by_code.items.iter().all(|track| track.camelot == "8A"));
}

#[test]
fn bpm_and_energy_filters_narrow_the_result() {
    let service = real_library!();
    let mut query = base_query();
    query.limit = 2000;
    let all = service.list_tracks(&query).unwrap().total;

    query.bpm_min = Some(120.0);
    query.bpm_max = Some(130.0);
    let ranged = service.list_tracks(&query).unwrap();
    assert!(ranged.total > 0 && ranged.total < all);
    assert!(ranged
        .items
        .iter()
        .all(|track| track.bpm.is_some_and(|bpm| (120.0..=130.0).contains(&bpm))));

    query.energy_min = Some(9);
    let energetic = service.list_tracks(&query).unwrap();
    assert!(energetic.total <= ranged.total);
    assert!(energetic
        .items
        .iter()
        .all(|track| track.energy.is_some_and(|energy| energy >= 9)));
}

#[test]
fn analyzed_filter_splits_the_library_exactly() {
    let service = real_library!();
    let mut query = base_query();
    query.limit = 1;

    let total = service.list_tracks(&query).unwrap().total;
    query.analyzed = Some(true);
    let analyzed = service.list_tracks(&query).unwrap().total;
    query.analyzed = Some(false);
    let pending = service.list_tracks(&query).unwrap().total;

    assert_eq!(analyzed + pending, total, "两边加起来必须是全部");
    assert!(analyzed > 0, "真库里一首分析过的都没有，库不对");

    // 不断言 `pending > 0`：用户已经放行「重新分析全部」，真库随时可能是 1420/1420，
    // 那时这条会红——而红的是环境不是代码。要测的是**筛选语义**，
    // 所以改成看返回的行本身对不对，两边为空时这一段自然什么也不查。
    query.limit = 50;
    for (want_analyzed, expect) in [(true, true), (false, false)] {
        query.analyzed = Some(want_analyzed);
        for track in service.list_tracks(&query).unwrap().items {
            assert_eq!(
                track.analyzed_at.is_some(),
                expect,
                "analyzed={want_analyzed} 却筛出了 analyzed_at={:?} 的「{}」",
                track.analyzed_at,
                track.filename
            );
        }
    }
}

#[test]
fn text_search_matches_across_title_artist_album_and_filename() {
    let service = real_library!();
    let mut query = base_query();
    query.limit = 2000;
    query.q = "a".into();
    let page = service.list_tracks(&query).unwrap();
    assert!(page.total > 0);
    // 每条结果至少有一个字段命中
    for track in page.items.iter().take(50) {
        let hit = [&track.title, &track.artist, &track.album, &track.filename]
            .iter()
            .any(|field| field.to_lowercase().contains('a'));
        assert!(hit, "「{}」没有任何字段命中 a", track.filename);
    }
}

#[test]
fn a_percent_sign_in_the_query_is_not_a_wildcard() {
    let service = real_library!();
    let mut query = base_query();
    query.limit = 10;
    query.q = "%".into();
    let page = service.list_tracks(&query).unwrap();
    // 转义正确的话，"%" 只匹配文件名里真的有百分号的曲目——绝不该是全部
    let total = {
        let mut all = base_query();
        all.limit = 1;
        service.list_tracks(&all).unwrap().total
    };
    assert!(
        page.total < total,
        "「%」被当成通配符了：命中 {} / 总数 {total}",
        page.total
    );
}

#[test]
fn harmonic_matches_are_compatible_sorted_and_deduped() {
    let service = real_library!();
    // 找一首既有调号又有 BPM 的
    let mut query = base_query();
    query.analyzed = Some(true);
    query.limit = 200;
    let page = service.list_tracks(&query).unwrap();
    let Some(source) = page
        .items
        .iter()
        .find(|track| !track.camelot.is_empty() && track.bpm.is_some())
    else {
        panic!("真库里应当有已分析的曲目");
    };

    let matches = service.harmonic_matches(source.id, 6.0, 50, true).unwrap();
    assert!(!matches.is_empty(), "「{}」一条推荐都没有", source.filename);

    let allowed: std::collections::HashSet<String> =
        kumodeck_library::camelot::camelot_relations(&source.camelot, true)
            .into_iter()
            .map(|(code, _)| code)
            .collect();

    let mut last_score = f64::INFINITY;
    let mut seen: std::collections::HashSet<(String, String)> = Default::default();
    for item in &matches {
        assert!(
            allowed.contains(&item.track.camelot),
            "{} 不在 {} 的兼容调里",
            item.track.camelot,
            source.camelot
        );
        assert_ne!(item.track.id, source.id, "不能把自己推荐给自己");
        assert!(item.score <= last_score + 1e-9, "推荐没有按 score 降序");
        last_score = item.score;

        // 同一首歌在多个 set 里各有一份，去重之后不该连着出现
        let ident = (
            item.track.title.to_lowercase(),
            item.track.artist.to_lowercase(),
        );
        assert!(seen.insert(ident), "推荐列表里出现了重复的歌");

        // BPM 必须能对上（同速 / 半速 / 倍速之一）
        if let (Some(source_bpm), Some(candidate_bpm)) = (source.bpm, item.track.bpm) {
            let aligned = candidate_bpm * item.tempo_ratio;
            assert!(
                (aligned - source_bpm).abs() <= 6.0 + 1e-6,
                "{} × {} = {aligned} 对不上 {source_bpm}",
                candidate_bpm,
                item.tempo_ratio
            );
        }
    }
}

#[test]
fn pending_analysis_defaults_to_only_unanalysed_tracks() {
    let service = real_library!();
    // 这条是硬约束：重算已分析的曲目会把用户的和声推荐打乱
    let pending = service.pending_analysis_ids(None, false).unwrap();
    let forced = service.pending_analysis_ids(None, true).unwrap();
    assert!(
        pending.len() < forced.len(),
        "默认不该把已分析的也排进队列：pending={} forced={}",
        pending.len(),
        forced.len()
    );

    // 抽查：pending 里的每一首都确实没分析过
    for id in pending.iter().take(20) {
        let track = service.get(*id).unwrap().expect("曲目应当存在");
        assert!(
            track.analyzed_at.is_none(),
            "「{}」已经分析过却还在队列里",
            track.filename
        );
    }
}

#[test]
fn folder_filter_separates_shallow_from_deep() {
    let service = real_library!();
    let paths = service.all_paths().unwrap();
    assert!(!paths.is_empty());

    // 挑一个既有直接子文件、又有子目录的目录
    let mut by_parent: std::collections::HashMap<String, usize> = Default::default();
    for path in &paths {
        if let Some(parent) = std::path::Path::new(path).parent() {
            *by_parent
                .entry(parent.to_string_lossy().into_owned())
                .or_insert(0) += 1;
        }
    }
    let Some((folder, _)) = by_parent.iter().max_by_key(|(_, count)| **count) else {
        return;
    };

    let mut query = base_query();
    query.limit = 2000;
    query.folder = folder.clone();
    let shallow = service.list_tracks(&query).unwrap();
    query.folder_deep = true;
    let deep = service.list_tracks(&query).unwrap();

    assert!(shallow.total > 0, "「{folder}」下应当有曲目");
    assert!(deep.total >= shallow.total, "深度模式只会更多不会更少");
    // 浅层结果里不能出现子目录里的曲目
    let prefix = format!("{folder}{}", std::path::MAIN_SEPARATOR);
    for track in &shallow.items {
        let rest = &track.path[prefix.len()..];
        assert!(
            !rest.contains(std::path::MAIN_SEPARATOR),
            "「{}」在子目录里，不该出现在浅层结果",
            track.path
        );
    }
}
