//! LibraryService：曲库的查询 / 过滤 / 入库 / 和声推荐 / 统计。
//!
//! 所有 SQL 都收在这一层，上面的 server 只跟契约模型打交道。

use std::collections::{BTreeMap, HashMap};
#[cfg(not(any(target_os = "macos", target_os = "android", target_os = "ios")))]
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kdj_analysis::engine::AnalysisResult;
use kdj_core::models::{
    HarmonicMatch, HarmonicRelation, LibraryStats, Track, TrackPage, TrackPatch,
};
use kdj_providers::tags::{read_tags, write_cover, write_metadata, MetadataEdit};
use rusqlite::types::Value as SqlValue;
use rusqlite::{OptionalExtension, Row};

use crate::camelot::{
    best_tempo, bpm_bucket, camelot_relations, parse_key_filter, relation_distance, relation_label,
    BPM_BUCKET_ORDER, CAMELOT_TO_KEY,
};
use crate::db::{Conn, Database};

/// BPM/Key 第二代元数据当前使用的算法修订。
///
/// v2 表与旧 tracks 分析列物理隔离；以后更换算法时只需提升这个值，所有旧修订
/// 就会重新进入渐进回填队列，同时 v1 仍可作为读取兜底。
pub const BPM_KEY_V2_REVISION: &str = "kdj-rust-bpm-key-v2.0.0";

/// 平台路径分隔符。曲库过滤按前缀匹配要用。
const SEP: char = std::path::MAIN_SEPARATOR;

/// 删除曲目时怎么处置文件本体。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileDisposal {
    /// 只删库记录，文件留在原地。
    Keep,
    /// 移到系统回收站——能反悔的删除。安卓/iOS 没有回收站，会返回错误。
    Trash,
    /// 直接从磁盘删掉，不可恢复。回收站不可用的平台走这条（前端会先确认）。
    Remove,
}

/// 删除后用于应用内撤回的文件定位信息。
///
/// 回收站里的文件可能被系统改名，不能只靠原文件名找；桌面平台分别保存
/// macOS 返回的实际目标路径，或 Linux/Windows 回收站条目的稳定 id。
#[derive(Debug, Clone)]
pub enum TrashHandle {
    #[cfg(target_os = "macos")]
    Mac(PathBuf),
    #[cfg(not(any(target_os = "macos", target_os = "android", target_os = "ios")))]
    Os(OsString),
}

/// 删除后保留的曲库快照。撤回时按原 id/路径写回，避免重新扫描丢掉分析结果和人工标记。
#[derive(Debug, Clone)]
pub struct DeletedTrack {
    pub track: Track,
    pub playlist_items: Vec<(i64, i64)>,
    pub trash: Option<TrashHandle>,
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> Result<Option<TrashHandle>> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let path_text = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("文件路径不是有效的 UTF-8：{}", path.display()))?;
    let path_string = NSString::from_str(path_text);
    let url = NSURL::fileURLWithPath(&path_string);
    let file_manager = NSFileManager::defaultManager();
    let mut resulting_url = None;
    file_manager
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting_url))
        .map_err(|err| anyhow::anyhow!("移入回收站失败：{err}"))?;
    let resulting_path = resulting_url
        .and_then(|url| url.path())
        .map(|path| path.to_string())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| anyhow::anyhow!("移入回收站后拿不到文件位置"))?;
    Ok(Some(TrashHandle::Mac(PathBuf::from(resulting_path))))
}

#[cfg(not(any(target_os = "macos", target_os = "android", target_os = "ios")))]
fn move_to_trash(path: &Path) -> Result<Option<TrashHandle>> {
    // 先记住已有条目，避免回收站里恰好有一个同原路径的旧文件时误认它。
    let before = trash::os_limited::list().ok();
    trash::delete(path).map_err(|err| anyhow::anyhow!("移入回收站失败：{err}"))?;
    let Some(before) = before else {
        tracing::warn!(
            "文件已移入回收站，但无法读取删除前的回收站清单，撤回不可用：{}",
            path.display()
        );
        return Ok(None);
    };
    let after = match trash::os_limited::list() {
        Ok(items) => items,
        Err(err) => {
            tracing::warn!("文件已移入回收站，但无法读取删除后的回收站清单，撤回不可用：{err}");
            return Ok(None);
        }
    };
    let original = normalize_path(path);
    let item = after
        .into_iter()
        .filter(|item| !before.contains(item) && normalize_path(&item.original_path()) == original)
        .max_by_key(|item| item.time_deleted);
    Ok(item.map(|item| TrashHandle::Os(item.id)))
}

/// 见 Cargo.toml：这两个平台没有系统回收站，trash crate 压根没编进来。
/// 正常流程走不到这儿（前端按 health.platform 改用「直接删除+确认」），
/// 留这个桩是防旧客户端/手写请求打进来时静默丢文件。
#[cfg(any(target_os = "android", target_os = "ios"))]
fn move_to_trash(_path: &Path) -> Result<Option<TrashHandle>> {
    anyhow::bail!("这个平台没有系统回收站，请改用直接删除")
}

fn restore_from_trash(handle: &TrashHandle, original: &Path) -> Result<()> {
    anyhow::ensure!(
        !original.exists(),
        "恢复目标位置已有文件：{}",
        original.display()
    );
    if let Some(parent) = original.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建原文件夹失败：{}", parent.display()))?;
    }

    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString, NSURL};

        let TrashHandle::Mac(trash_path) = handle;
        let trash_text = trash_path.to_str().ok_or_else(|| {
            anyhow::anyhow!("回收站路径不是有效的 UTF-8：{}", trash_path.display())
        })?;
        let original_text = original
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("原文件路径不是有效的 UTF-8：{}", original.display()))?;
        let trash_url = NSURL::fileURLWithPath(&NSString::from_str(trash_text));
        let original_url = NSURL::fileURLWithPath(&NSString::from_str(original_text));
        NSFileManager::defaultManager()
            .moveItemAtURL_toURL_error(&trash_url, &original_url)
            .map_err(|err| anyhow::anyhow!("从回收站恢复失败：{err}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "android", target_os = "ios")))]
    {
        let TrashHandle::Os(id) = handle;
        let item = trash::os_limited::list()
            .map_err(|err| anyhow::anyhow!("读取回收站失败：{err}"))?
            .into_iter()
            .find(|item| item.id == *id)
            .with_context(|| format!("回收站里找不到待恢复的文件：{}", original.display()))?;
        anyhow::ensure!(
            normalize_path(&item.original_path()) == normalize_path(original),
            "回收站文件原路径已变化，拒绝恢复：{}",
            original.display()
        );
        trash::os_limited::restore_all([item])
            .map_err(|err| anyhow::anyhow!("从回收站恢复失败：{err}"))?;
        return Ok(());
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (handle, original);
        anyhow::bail!("这个平台没有系统回收站")
    }
}

/// sort 白名单：绝对不能把 query string 直接拼进 ORDER BY（SQL 注入），
/// 也不能只做转义——SQLite 的标识符引用规则太松，白名单映射是唯一安全的做法。
fn effective_bpm_key_column(column: &str) -> String {
    format!(
        "COALESCE((SELECT v2.{column} FROM track_bpm_key_analysis_v2 v2 \
         WHERE v2.track_id = tracks.id AND v2.analyzer_revision = '{}'), tracks.{column})",
        BPM_KEY_V2_REVISION
    )
}

fn sort_column(key: &str) -> String {
    match key {
        "modified_at" => "tracks.modified_at".into(),
        "analyzed_at" => "tracks.analyzed_at".into(),
        "title" => "tracks.title".into(),
        "artist" => "tracks.artist".into(),
        "album" => "tracks.album".into(),
        "genre" => "tracks.genre".into(),
        "year" => "tracks.year".into(),
        "filename" => "tracks.filename".into(),
        "duration" => "tracks.duration".into(),
        "bpm" => effective_bpm_key_column("bpm"),
        "energy" => "tracks.energy".into(),
        "rating" => "tracks.rating".into(),
        "size" => "tracks.size".into(),
        // Camelot 直接按字符串排会得到 "10A" < "8A"，必须拆成 数字*2 + 字母
        "camelot" | "key" => {
            let camelot = effective_bpm_key_column("camelot");
            format!(
                "(CASE WHEN ({camelot}) IS NULL OR ({camelot}) = '' THEN NULL ELSE \
                 CAST(SUBSTR(({camelot}), 1, LENGTH(({camelot})) - 1) AS INTEGER) * 2 \
                 + (CASE WHEN UPPER(SUBSTR(({camelot}), -1)) = 'B' THEN 1 ELSE 0 END) END)"
            )
        }
        _ => "tracks.added_at".into(),
    }
}

/// LIKE 通配符转义。用户搜 "50%" 不该变成匹配一切。
fn escape_like(term: &str) -> String {
    term.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn like_contains(term: &str) -> String {
    format!("%{}%", escape_like(&term.to_lowercase()))
}

/// 入库的 path 是 UNIQUE 键，写入和查询必须用同一套归一化规则。
///
/// 只做 expanduser + absolute + normalize，**不做 realpath**：
/// 符号链接解析会让下载器传进来的路径和扫描出来的路径对不上。
pub fn normalize_path(path: &Path) -> String {
    let expanded = kdj_core::config::expand_user(&path.to_string_lossy());
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(expanded)
    };
    kdj_core::paths::normalize_path(&absolute)
        .to_string_lossy()
        .into_owned()
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn order_direction(order: &str) -> &'static str {
    if order.trim().eq_ignore_ascii_case("asc") {
        "ASC"
    } else {
        "DESC"
    }
}

#[derive(Debug, Clone, Default)]
pub struct TrackQuery {
    pub q: String,
    pub key: String,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    pub energy_min: Option<i64>,
    pub analyzed: Option<bool>,
    pub folder: String,
    pub folder_deep: bool,
    /// 非空时只返回路径不在这些根目录之下的曲目（侧栏「其他」）。
    /// 由路由在识别 `__kd_outside__` 哨兵后填入；与 `folder` 前缀过滤互斥。
    pub exclude_under: Vec<String>,
    pub sort: String,
    pub order: String,
    /// 副排序键。空 = 只按主键排。
    ///
    /// 用途：主键相同的那一撮再按它排。DJ 排 set 时常要「先按 BPM，
    /// 同 BPM 里再按调号」——只有一个排序键的话，同 BPM 的那十几首是
    /// 乱序的，得靠眼睛在里面找能接的调。
    pub sort2: String,
    pub order2: String,
    pub limit: i64,
    pub offset: i64,
}

pub struct LibraryService {
    db: Database,
}

impl LibraryService {
    pub fn new(db: Database) -> Self {
        LibraryService { db }
    }

    pub fn db(&self) -> &Database {
        &self.db
    }

    // ------------------------------------------------------------ 读

    /// 组 WHERE 子句。返回 `(sql 片段, 参数)`。
    fn build_where(&self, query: &TrackQuery) -> (String, Vec<SqlValue>) {
        let mut where_parts: Vec<String> = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();

        let folder = query.folder.trim().trim_end_matches('/');
        if !query.exclude_under.is_empty() {
            // 「其他」：路径不落在任一曲库根下。根本身与 root/… 都排除。
            for root in &query.exclude_under {
                let normalized = normalize_path(Path::new(root));
                let prefix = format!("{normalized}{SEP}");
                let escaped = escape_like(&prefix);
                where_parts.push("path NOT LIKE ? ESCAPE '\\'".into());
                params.push(SqlValue::Text(format!("{escaped}%")));
                where_parts.push("path != ?".into());
                params.push(SqlValue::Text(normalized));
            }
        } else if !folder.is_empty() {
            // 按路径前缀过滤。folder_deep=false 时再排掉"还有下一层分隔符"的，
            // 这样点开一个文件夹看到的就是它本层的东西，和访达一致。
            let prefix = format!("{}{SEP}", normalize_path(Path::new(folder)));
            let escaped = escape_like(&prefix);
            where_parts.push("path LIKE ? ESCAPE '\\'".into());
            params.push(SqlValue::Text(format!("{escaped}%")));
            if !query.folder_deep {
                // os.sep **必须过转义**：Windows 的分隔符恰好是 LIKE 的转义符 '\'，
                // 裸拼出来的 `%\%` 意思是"字面百分号"，子目录一个都排不掉。
                // 这是 v0.1.0 在 Windows 上修过的真 bug。
                where_parts.push("path NOT LIKE ? ESCAPE '\\'".into());
                params.push(SqlValue::Text(format!(
                    "{escaped}%{}%",
                    escape_like(&SEP.to_string())
                )));
            }
        }

        let q = query.q.trim();
        if !q.is_empty() {
            let needle = like_contains(q);
            where_parts.push(
                "(LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\'\
                 OR LOWER(COALESCE(artist, '')) LIKE ? ESCAPE '\\'\
                 OR LOWER(COALESCE(album, '')) LIKE ? ESCAPE '\\'\
                 OR LOWER(COALESCE(filename, '')) LIKE ? ESCAPE '\\')"
                    .into(),
            );
            for _ in 0..4 {
                params.push(SqlValue::Text(needle.clone()));
            }
        }

        let (camelot, raw_key) = parse_key_filter(&query.key);
        if !camelot.is_empty() {
            where_parts.push(format!(
                "UPPER(COALESCE({}, '')) = ?",
                effective_bpm_key_column("camelot")
            ));
            params.push(SqlValue::Text(camelot));
        } else if !raw_key.is_empty() {
            where_parts.push(format!(
                "LOWER(COALESCE({}, '')) LIKE ? ESCAPE '\\'",
                effective_bpm_key_column("music_key")
            ));
            params.push(SqlValue::Text(like_contains(&raw_key)));
        }

        if let Some(bpm_min) = query.bpm_min {
            let bpm = effective_bpm_key_column("bpm");
            where_parts.push(format!("({bpm}) IS NOT NULL AND ({bpm}) >= ?"));
            params.push(SqlValue::Real(bpm_min));
        }
        if let Some(bpm_max) = query.bpm_max {
            let bpm = effective_bpm_key_column("bpm");
            where_parts.push(format!("({bpm}) IS NOT NULL AND ({bpm}) <= ?"));
            params.push(SqlValue::Real(bpm_max));
        }
        if let Some(energy_min) = query.energy_min {
            where_parts.push("energy IS NOT NULL AND energy >= ?".into());
            params.push(SqlValue::Integer(energy_min));
        }
        match query.analyzed {
            Some(true) => where_parts.push("analyzed_at IS NOT NULL".into()),
            Some(false) => where_parts.push("analyzed_at IS NULL".into()),
            None => {}
        }

        let clause = if where_parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", where_parts.join(" AND "))
        };
        (clause, params)
    }

    pub fn list_tracks(&self, query: &TrackQuery) -> Result<TrackPage> {
        let conn = self.db.conn()?;
        let (clause, params) = self.build_where(query);
        // limit=0 当"没传"，退回默认 200（v0.1.0 是 `limit or 200`）。
        // 夹成 1 的话，没显式给 limit 的调用只会回一条，看着像曲库空了。
        let limit = if query.limit == 0 {
            200
        } else {
            query.limit.clamp(1, 2000)
        };
        let offset = query.offset.max(0);

        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM tracks{clause}"),
            rusqlite::params_from_iter(params.iter()),
            |row| row.get(0),
        )?;

        let sort_key = query.sort.trim().to_lowercase();
        let folder = query.folder.trim().trim_end_matches('/');

        // 手排模式：顺序在这个文件夹自己的 .kdj/manifest.json 里（兼容旧 .kdj.json）。
        // 单个 set 文件夹最多几百首，全取出来按清单排再切页，
        // 比往 SQL 里拼几百个 WHEN 的 CASE 干净，也复用同一套 WHERE。
        if sort_key == "custom" && !folder.is_empty() && !query.folder_deep {
            let mut stmt = conn.prepare(&format!("SELECT * FROM tracks{clause}"))?;
            let mut rows: Vec<Track> = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok(row_to_track(row))
                })?
                .collect::<std::result::Result<_, _>>()?;

            let listed = crate::folders::read_manifest_order(Path::new(folder));
            let position: HashMap<&str, usize> = listed
                .iter()
                .enumerate()
                .map(|(index, name)| (name.as_str(), index))
                .collect();
            let tail = position.len();
            // 清单里没有的（新扫进来的）按文件名排在后面，和文件夹树同一条规则
            rows.sort_by(|a, b| {
                let pa = position.get(a.filename.as_str()).copied().unwrap_or(tail);
                let pb = position.get(b.filename.as_str()).copied().unwrap_or(tail);
                pa.cmp(&pb)
                    .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()))
            });
            let page: Vec<Track> = rows
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect();
            return Ok(TrackPage {
                items: self.attach_tags(&conn, self.apply_bpm_key_v2(&conn, page)?)?,
                total,
                offset,
                limit,
            });
        }

        let column = sort_column(&sort_key);
        let direction = order_direction(&query.order);
        // `<col> IS NULL` 放第一排序键 = 空值永远垫底（升序降序都一样），
        // 再拿 id 兜底保证分页稳定不重复
        //
        // 副键夹在主键和 id 之间。它同样要带自己的 IS NULL，
        // 否则同一个主键值里"没分析出调号的"会插在中间而不是垫底。
        let secondary = {
            let key = query.sort2.trim();
            if key.is_empty() || key == sort_key {
                // 和主键相同就没有意义，直接忽略——比报错友好，
                // 而前端点两下同一列时确实会短暂出现这种状态
                String::new()
            } else {
                let col2 = sort_column(key);
                let dir2 = order_direction(&query.order2);
                format!(" ({col2}) IS NULL, ({col2}) {dir2},")
            }
        };
        let sql = format!(
            "SELECT * FROM tracks{clause} ORDER BY ({column}) IS NULL, ({column}) {direction},\
            {secondary} id DESC LIMIT ? OFFSET ?"
        );
        let mut all_params = params;
        all_params.push(SqlValue::Integer(limit));
        all_params.push(SqlValue::Integer(offset));

        let mut stmt = conn.prepare(&sql)?;
        let rows: Vec<Track> = stmt
            .query_map(rusqlite::params_from_iter(all_params.iter()), |row| {
                Ok(row_to_track(row))
            })?
            .collect::<std::result::Result<_, _>>()?;

        Ok(TrackPage {
            items: self.attach_tags(&conn, self.apply_bpm_key_v2(&conn, rows)?)?,
            total,
            offset,
            limit,
        })
    }

    pub fn get(&self, track_id: i64) -> Result<Option<Track>> {
        let conn = self.db.conn()?;
        let mut stmt = conn.prepare("SELECT * FROM tracks WHERE id = ?")?;
        let mut rows = stmt.query_map([track_id], |row| Ok(row_to_track(row)))?;
        let Some(track) = rows.next().transpose()? else {
            return Ok(None);
        };
        Ok(self
            .attach_tags(&conn, self.apply_bpm_key_v2(&conn, vec![track])?)?
            .into_iter()
            .next())
    }

    pub fn get_by_path(&self, path: &Path) -> Result<Option<Track>> {
        let conn = self.db.conn()?;
        let key = normalize_path(path);
        let mut stmt = conn.prepare("SELECT * FROM tracks WHERE path = ?")?;
        let mut rows = stmt.query_map([key], |row| Ok(row_to_track(row)))?;
        let Some(track) = rows.next().transpose()? else {
            return Ok(None);
        };
        Ok(self
            .attach_tags(&conn, self.apply_bpm_key_v2(&conn, vec![track])?)?
            .into_iter()
            .next())
    }

    /// 把当前修订的 v2 BPM/Key 覆盖到 API 返回对象上，但不改 tracks 里的 v1。
    ///
    /// 每个字段独立回退：例如 v2 只算出了 Key，BPM 仍沿用 v1；解码失败产生的
    /// 空 v2 行也不会把一条原本完整的 v1 曲目显示成空白。
    fn apply_bpm_key_v2(&self, conn: &Conn, mut tracks: Vec<Track>) -> Result<Vec<Track>> {
        if tracks.is_empty() {
            return Ok(tracks);
        }
        let mut by_id: HashMap<
            i64,
            (
                Option<f64>,
                Option<f64>,
                Option<f64>,
                String,
                String,
                String,
                Option<f64>,
            ),
        > = HashMap::new();
        for chunk in tracks.chunks(900) {
            let ids: Vec<i64> = chunk.iter().map(|track| track.id).collect();
            let placeholders = vec!["?"; ids.len()].join(",");
            let sql = format!(
                "SELECT track_id, bpm, bpm_confidence, first_beat, music_key, camelot, open_key, \
                 key_confidence FROM track_bpm_key_analysis_v2 \
                 WHERE analyzer_revision = ? AND track_id IN ({placeholders})"
            );
            let mut params = Vec::with_capacity(ids.len() + 1);
            params.push(SqlValue::Text(BPM_KEY_V2_REVISION.to_string()));
            params.extend(ids.into_iter().map(SqlValue::Integer));
            let mut stmt = conn.prepare(&sql)?;
            for row in stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    (
                        row.get::<_, Option<f64>>(1)?,
                        row.get::<_, Option<f64>>(2)?,
                        row.get::<_, Option<f64>>(3)?,
                        row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        row.get::<_, Option<f64>>(7)?,
                    ),
                ))
            })? {
                let (id, values) = row?;
                by_id.insert(id, values);
            }
        }
        for track in &mut tracks {
            let Some((bpm, bpm_confidence, first_beat, key, camelot, open_key, key_confidence)) =
                by_id.remove(&track.id)
            else {
                continue;
            };
            if bpm.is_some() {
                track.bpm = bpm;
                track.bpm_v2 = true;
                track.bpm_confidence = bpm_confidence;
                track.first_beat = first_beat;
            }
            if !key.is_empty() {
                track.music_key = key;
                track.camelot = camelot.to_uppercase();
                track.open_key = open_key;
                track.key_confidence = key_confidence;
            }
        }
        Ok(tracks)
    }

    /// 一次查完整页的 tags，避免 N+1。
    fn attach_tags(&self, conn: &Conn, mut tracks: Vec<Track>) -> Result<Vec<Track>> {
        if tracks.is_empty() {
            return Ok(tracks);
        }
        let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
        // SQLite 的 IN (...) 有参数个数上限（默认 999），大列表必须切块
        for chunk in tracks.chunks(900) {
            let ids: Vec<i64> = chunk.iter().map(|track| track.id).collect();
            let placeholders = vec!["?"; ids.len()].join(",");
            let mut stmt = conn.prepare(&format!(
                "SELECT track_id, tag FROM tags WHERE track_id IN ({placeholders}) ORDER BY tag"
            ))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, tag) = row?;
                by_id.entry(id).or_default().push(tag);
            }
        }
        for track in tracks.iter_mut() {
            if let Some(tags) = by_id.remove(&track.id) {
                track.tags = tags;
            }
        }
        Ok(tracks)
    }

    // ------------------------------------------------------------ 写

    pub fn patch(&self, track_id: i64, patch: &TrackPatch) -> Result<Track> {
        let conn = self.db.conn()?;
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE id = ?",
            [track_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(exists > 0, "曲目不存在：{track_id}");

        // 列名全是这里写死的字面量，不来自外部输入
        let mut assignments: Vec<&str> = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();
        if let Some(rating) = patch.rating {
            assignments.push("rating = ?");
            values.push(SqlValue::Integer(rating.clamp(0, 5)));
        }
        for (name, value) in [
            ("color = ?", patch.color.as_ref()),
            ("comment = ?", patch.comment.as_ref()),
            ("title = ?", patch.title.as_ref()),
            ("artist = ?", patch.artist.as_ref()),
            ("album = ?", patch.album.as_ref()),
            ("genre = ?", patch.genre.as_ref()),
            ("year = ?", patch.year.as_ref()),
        ] {
            if let Some(value) = value {
                assignments.push(name);
                values.push(SqlValue::Text(value.clone()));
            }
        }
        if let Some(cue_ms) = patch.cue_ms {
            assignments.push("cue_ms = ?");
            values.push(SqlValue::Integer(cue_ms));
        }
        if let Some(end_ms) = patch.end_ms {
            assignments.push("end_ms = ?");
            values.push(SqlValue::Integer(end_ms));
        }

        let stamp = now_iso();
        if !assignments.is_empty() {
            assignments.push("modified_at = ?");
            values.push(SqlValue::Text(stamp.clone()));
            values.push(SqlValue::Integer(track_id));
            conn.execute(
                &format!("UPDATE tracks SET {} WHERE id = ?", assignments.join(", ")),
                rusqlite::params_from_iter(values.iter()),
            )?;
        }
        if let Some(tags) = &patch.tags {
            conn.execute("DELETE FROM tags WHERE track_id = ?", [track_id])?;
            let mut cleaned: Vec<&str> = tags
                .iter()
                .map(|tag| tag.trim())
                .filter(|tag| !tag.is_empty())
                .collect();
            cleaned.sort();
            cleaned.dedup();
            for tag in cleaned {
                conn.execute(
                    "INSERT OR IGNORE INTO tags (track_id, tag) VALUES (?, ?)",
                    rusqlite::params![track_id, tag],
                )?;
            }
            if assignments.is_empty() {
                conn.execute(
                    "UPDATE tracks SET modified_at = ? WHERE id = ?",
                    rusqlite::params![stamp, track_id],
                )?;
            }
        }

        // 先还连接再读回：`get` 要从池里再借一条，握着不放的话
        // 并发的 patch 会把池占满，表现是随机的"获取曲库连接失败"
        drop(conn);
        self.get(track_id)?.context("刚更新的曲目查不到了")
    }

    /// 重新 stat 文件，把 `file_mtime` / `size` 对齐到磁盘上的现状。
    ///
    /// **凡是我们自己动过音频文件的地方（写标签、换封面）都必须调它。**
    /// `upsert_file` 拿 `(file_mtime, size)` 做增量跳过：库里还是写之前那份 mtime 的话，
    /// 下一次扫描会认定"文件被外部改过"，于是重读标签、按文件里的值覆盖回库里——
    /// 用户刚改的东西要么被冲掉，要么每次扫描都白重读一遍。
    pub fn sync_file_stat(&self, track_id: i64) -> Result<()> {
        let conn = self.db.conn()?;
        let path: String =
            conn.query_row("SELECT path FROM tracks WHERE id = ?", [track_id], |row| {
                row.get(0)
            })?;
        let meta = std::fs::metadata(&path).with_context(|| format!("无法读取文件: {path}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        conn.execute(
            "UPDATE tracks SET file_mtime = ?, size = ? WHERE id = ?",
            rusqlite::params![mtime, meta.len() as i64, track_id],
        )?;
        Ok(())
    }

    /// 把这次 patch 里用户动过的文本字段写回文件标签。
    ///
    /// 只写 patch 里出现过的字段，不拿库里那份整体覆盖：库里读标签失败退化成空串的
    /// 字段（怪文件很常见）会把文件里好好的标签清掉。
    /// 备注 / 评分 / 颜色 / cue 是这个 App 自己的东西，不往文件里写。
    pub fn write_patch_to_file(&self, track_id: i64, patch: &TrackPatch) -> Result<()> {
        let edit = MetadataEdit {
            title: patch.title.as_deref(),
            artist: patch.artist.as_deref(),
            album: patch.album.as_deref(),
            genre: patch.genre.as_deref(),
            year: patch.year.as_deref(),
        };
        if edit.is_empty() {
            return Ok(());
        }
        let track = self.get(track_id)?.context("曲目不存在")?;
        self.after_file_write(track_id, write_metadata(Path::new(&track.path), &edit))
    }

    /// 换封面。返回后 `GET /api/library/cover/{id}` 立刻就是新图。
    pub fn write_cover_to_file(&self, track_id: i64, data: &[u8]) -> Result<()> {
        let track = self.get(track_id)?.context("曲目不存在")?;
        self.after_file_write(track_id, write_cover(Path::new(&track.path), data))
    }

    /// 按文件里现存的标签刷新库里那条记录。
    ///
    /// 为什么单独要这个：`upsert_file` 拿 `(file_mtime, size)` 做增量跳过，
    /// 所以"文件里有标签、库里是空的"这种记录（早年入库时读标签失败、
    /// 或者用别的软件改过标签但 mtime 恰好没变）再扫多少遍都不会好——
    /// 库里那份错值就是那次跳过的结果，跳过本身又是靠它自己维持的。
    ///
    /// 实现上不另写一套 UPDATE，而是把库里的 `file_mtime` 先清零、逼 `upsert_file`
    /// 走"文件变了"那条分支：覆盖规则（只在读到非空值时才盖、不清空分析结果）
    /// 必须和扫描完全一致，抄一份迟早会跑偏。清零后中途失败也是安全方向——
    /// 最坏结果只是下次扫描多读一次标签。
    pub fn reread_tags_from_file(&self, track_id: i64) -> Result<Track> {
        let conn = self.db.conn()?;
        let path: String = conn
            .query_row("SELECT path FROM tracks WHERE id = ?", [track_id], |row| {
                row.get(0)
            })
            .with_context(|| format!("曲目不存在：{track_id}"))?;
        anyhow::ensure!(Path::new(&path).exists(), "文件不在了，读不到标签：{path}");
        // 0 不会等于任何一个真实 mtime，增量比对必然不成立
        conn.execute("UPDATE tracks SET file_mtime = 0 WHERE id = ?", [track_id])?;
        // `upsert_file` 自己要借连接，握着不放会把池占满
        drop(conn);

        // source_platform / source_key 传空 = 这次不动来源信息
        self.upsert_file(Path::new(&path), "", "")?;
        self.get(track_id)?.context("刚重读的曲目查不到了")
    }

    /// 写文件之后一律同步一次 stat，**哪怕写失败**：
    /// lofty 是"改完再落盘"，失败点可能在落盘之后，那时 mtime 已经变了。
    /// 只在成功路径上同步的话，这条失败会留下一个错的 mtime 埋在库里。
    ///
    /// 成功写入还要更新时间戳：列表封面 URL 用 `modified_at` 做缓存破坏值，
    /// 否则事件虽然会触发列表重拉，WebView 仍会命中旧的缩略图缓存。
    fn after_file_write(&self, track_id: i64, outcome: Result<()>) -> Result<()> {
        let synced = self.sync_file_stat(track_id);
        outcome.and(synced)?;
        let conn = self.db.conn()?;
        conn.execute(
            "UPDATE tracks SET modified_at = ? WHERE id = ?",
            rusqlite::params![now_iso(), track_id],
        )?;
        Ok(())
    }

    pub fn delete(&self, track_id: i64, disposal: FileDisposal) -> Result<bool> {
        let Some(track) = self.get(track_id)? else {
            return Ok(false);
        };
        // 回收站失败必须发生在删库记录**之前**：trash 挂了（比如文件在
        // 不支持回收站的网络盘上）就原样报错、什么都不动，用户看到的是
        // "没删成"而不是"库里没了文件还在"的半截状态。
        // 文件已经不在原地则视作无事可做——记录照删，这正是清理死条目的场景。
        if disposal == FileDisposal::Trash {
            let file = Path::new(&track.path);
            if file.exists() {
                let _ = move_to_trash(file)?;
            }
        }
        self.delete_rows(&track, disposal)
    }

    /// 删除并保留一份可撤回快照。
    ///
    /// `Keep` 和 `Trash` 都能进入撤回栈；`Remove` 明确不可恢复，返回的快照为 None。
    /// 回收站条目定位失败不会把已经成功的删除伪装成失败，只是这次删除没有应用内撤回。
    pub fn delete_for_undo(
        &self,
        track_id: i64,
        disposal: FileDisposal,
    ) -> Result<(bool, Option<DeletedTrack>)> {
        let Some(track) = self.get(track_id)? else {
            return Ok((false, None));
        };
        let playlist_items = self.playlist_items(track_id)?;
        let trash = if disposal == FileDisposal::Trash && Path::new(&track.path).exists() {
            move_to_trash(Path::new(&track.path))?
        } else {
            None
        };
        self.delete_rows(&track, disposal)?;

        let undo = if disposal != FileDisposal::Remove
            && (trash.is_some() || Path::new(&track.path).is_file())
        {
            Some(DeletedTrack {
                track,
                playlist_items,
                trash,
            })
        } else {
            None
        };
        Ok((true, undo))
    }

    fn playlist_items(&self, track_id: i64) -> Result<Vec<(i64, i64)>> {
        let conn = self.db.conn()?;
        let mut stmt = conn.prepare(
            "SELECT playlist_id, position FROM playlist_items WHERE track_id = ? ORDER BY playlist_id",
        )?;
        let rows = stmt.query_map([track_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn delete_rows(&self, track: &Track, disposal: FileDisposal) -> Result<bool> {
        let conn = self.db.conn()?;
        conn.execute("DELETE FROM tracks WHERE id = ?", [track.id])?;
        conn.execute("DELETE FROM tags WHERE track_id = ?", [track.id])?;
        conn.execute("DELETE FROM playlist_items WHERE track_id = ?", [track.id])?;
        if disposal == FileDisposal::Remove {
            // 直接删除维持宽容语义：文件删不掉（权限/已被移走）不该让接口失败，
            // 记录已从库里移除即可
            let _ = std::fs::remove_file(&track.path);
        }
        Ok(true)
    }

    /// 把删除快照和文件一起恢复。数据库里的 id、分析结果、人工标记、标签及歌单位置
    /// 都按删除前写回，不走重新扫描，避免一次撤回变成一首"新导入"的歌。
    pub fn restore_deleted(&self, deleted: &DeletedTrack) -> Result<Track> {
        let track = &deleted.track;
        let original = Path::new(&track.path);
        anyhow::ensure!(
            self.get(track.id)?.is_none(),
            "恢复曲目 id 已被重新占用：{}",
            track.id
        );
        let key_path = normalize_path(original);
        {
            let conn = self.db.conn()?;
            let existing: Option<i64> = conn
                .query_row("SELECT id FROM tracks WHERE path = ?", [&key_path], |row| {
                    row.get(0)
                })
                .optional()?;
            anyhow::ensure!(
                existing.is_none(),
                "恢复目标路径已被重新登记：{}",
                original.display()
            );
        }

        if let Some(handle) = &deleted.trash {
            restore_from_trash(handle, original)?;
        } else {
            anyhow::ensure!(original.is_file(), "恢复文件不存在：{}", original.display());
        }

        let insert_result = (|| -> Result<()> {
            let mut conn = self.db.conn()?;
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO tracks (
                    id, path, filename, title, artist, album, genre, year, duration,
                    bitrate, samplerate, channels, format, size, bpm, bpm_confidence,
                    first_beat, music_key, camelot, open_key, key_confidence, energy,
                    rms_db, peak_db, rating, color, comment, cue_ms, end_ms,
                    source_platform, source_key, analyzed_at, added_at, modified_at,
                    analysis_error
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )",
                rusqlite::params![
                    track.id,
                    key_path,
                    track.filename,
                    track.title,
                    track.artist,
                    track.album,
                    track.genre,
                    track.year,
                    track.duration,
                    track.bitrate,
                    track.samplerate,
                    track.channels,
                    track.format,
                    track.size,
                    track.bpm,
                    track.bpm_confidence,
                    track.first_beat,
                    track.music_key,
                    track.camelot,
                    track.open_key,
                    track.key_confidence,
                    track.energy,
                    track.rms_db,
                    track.peak_db,
                    track.rating,
                    track.color,
                    track.comment,
                    track.cue_ms,
                    track.end_ms,
                    track.source_platform,
                    track.source_key,
                    track.analyzed_at,
                    track.added_at,
                    track.modified_at,
                    track.analysis_error,
                ],
            )?;
            for tag in &track.tags {
                tx.execute(
                    "INSERT OR IGNORE INTO tags (track_id, tag) VALUES (?, ?)",
                    rusqlite::params![track.id, tag],
                )?;
            }
            for (playlist_id, position) in &deleted.playlist_items {
                tx.execute(
                    "INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, ?)",
                    rusqlite::params![playlist_id, track.id, position],
                )?;
            }
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = insert_result {
            // 数据库写回失败时尽量把文件放回回收站，保留这条撤回操作的可重试性。
            if deleted.trash.is_some() && original.is_file() {
                if let Err(rollback) = move_to_trash(original) {
                    tracing::warn!(
                        "撤回曲目数据库写回失败，且无法回滚回收站文件 {}：{rollback:#}",
                        original.display()
                    );
                }
            }
            return Err(error);
        }
        self.get(track.id)?.context("撤回后查不到曲目记录")
    }

    /// 把某个目录（含子目录）下的曲目从库里摘掉，**不动磁盘文件**。
    ///
    /// 「移出曲库根 / 移出此文件夹」走这条：用户只是不想再在软件里看到这批歌，
    /// 不是要清盘。返回被摘掉的 track id，方便广播 `library.updated`。
    pub fn forget_under(&self, dir: &Path) -> Result<Vec<i64>> {
        let prefix = format!("{}{SEP}", normalize_path(dir));
        let like = format!("{}%", escape_like(&prefix));
        let conn = self.db.conn()?;
        let mut stmt = conn.prepare("SELECT id FROM tracks WHERE path LIKE ? ESCAPE '\\'")?;
        let ids: Vec<i64> = stmt
            .query_map([&like], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        if ids.is_empty() {
            return Ok(ids);
        }
        conn.execute(
            "DELETE FROM tags WHERE track_id IN \
             (SELECT id FROM tracks WHERE path LIKE ? ESCAPE '\\')",
            [&like],
        )?;
        conn.execute(
            "DELETE FROM playlist_items WHERE track_id IN \
             (SELECT id FROM tracks WHERE path LIKE ? ESCAPE '\\')",
            [&like],
        )?;
        conn.execute("DELETE FROM tracks WHERE path LIKE ? ESCAPE '\\'", [&like])?;
        Ok(ids)
    }

    /// 把一个音频文件写进库，返回 track id。同一路径重复调用是幂等的。
    pub fn upsert_file(&self, path: &Path, source_platform: &str, source_key: &str) -> Result<i64> {
        let key_path = normalize_path(path);
        let file_path = PathBuf::from(&key_path);
        let meta =
            std::fs::metadata(&file_path).with_context(|| format!("无法读取文件: {key_path}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let size = meta.len() as i64;

        let conn = self.db.conn()?;
        let existing: Option<(i64, Option<f64>, i64, String, String, bool)> = conn
            .query_row(
                "SELECT id, file_mtime, COALESCE(size, 0), COALESCE(source_platform, ''), \
                 COALESCE(source_key, ''), \
                 (COALESCE(artist, '') = '' AND COALESCE(album, '') = '') \
                 FROM tracks WHERE path = ?",
                [&key_path],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .ok();

        if let Some((id, old_mtime, old_size, old_platform, old_key, tags_missing)) = &existing {
            // 增量：mtime + size 都没变就直接返回，省掉读标签（扫描里最贵的一步）。
            // 例外：库里艺人+专辑双空的行不许走快路径（`file_index` 的注释有全文），
            // 逼它落到下面的重读分支——覆盖规则"只在读到非空值时才盖"在那边，
            // 所以真没标签的文件重读之后也只是原地踏步，不会被清掉别的字段。
            let unchanged = old_mtime
                .map(|value| (value - mtime).abs() < 1e-6)
                .unwrap_or(false)
                && *old_size == size
                && !*tags_missing;
            if unchanged {
                // 唯一例外：来源信息是调用方带进来的（下载完成时补登记），
                // 文件没变也要认，否则重复下载的曲目会一直挂着 local
                self.touch_source(
                    &conn,
                    *id,
                    old_platform,
                    old_key,
                    source_platform,
                    source_key,
                )?;
                return Ok(*id);
            }
        }

        let tags = read_tags(&file_path);
        let title = if tags.title.is_empty() {
            file_path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            tags.title.clone()
        };
        let now = now_iso();
        let filename = file_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();

        let Some((track_id, ..)) = existing else {
            let inserted = conn.execute(
                "INSERT INTO tracks (path, filename, title, artist, album, genre, year,\
                 duration, bitrate, samplerate, channels, format, size,\
                 source_platform, source_key, added_at, modified_at, file_mtime,\
                 rating, analysis_error)\
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')",
                rusqlite::params![
                    key_path,
                    filename,
                    title,
                    tags.artist,
                    tags.album,
                    tags.genre,
                    tags.year,
                    tags.duration,
                    tags.bitrate,
                    tags.samplerate,
                    tags.channels,
                    tags.format,
                    size,
                    if source_platform.is_empty() {
                        "local"
                    } else {
                        source_platform
                    },
                    source_key,
                    now,
                    now,
                    mtime,
                ],
            );
            return match inserted {
                Ok(_) => Ok(conn.last_insert_rowid()),
                // 两个扫描线程同时撞到同一个文件：UNIQUE(path) 拦下后回读即可
                Err(_) => conn
                    .query_row("SELECT id FROM tracks WHERE path = ?", [&key_path], |row| {
                        row.get(0)
                    })
                    .context("并发插入后回读失败"),
            };
        };

        // 文件内容变了：技术字段一定更新；文本标签只在**读到非空值**时覆盖，
        // 避免标签被清空或读失败时把库里已有的信息（含用户手改过的）抹掉。
        let mut assignments: Vec<&str> = vec![
            "filename = ?",
            "size = ?",
            "file_mtime = ?",
            "modified_at = ?",
        ];
        let mut values: Vec<SqlValue> = vec![
            SqlValue::Text(filename),
            SqlValue::Integer(size),
            SqlValue::Real(mtime),
            SqlValue::Text(now),
        ];
        for (assignment, value) in [
            ("artist = ?", &tags.artist),
            ("album = ?", &tags.album),
            ("genre = ?", &tags.genre),
            ("year = ?", &tags.year),
            ("format = ?", &tags.format),
        ] {
            if !value.is_empty() {
                assignments.push(assignment);
                values.push(SqlValue::Text(value.clone()));
            }
        }
        if !tags.title.is_empty() {
            assignments.push("title = ?");
            values.push(SqlValue::Text(tags.title.clone()));
        }
        for (assignment, value) in [
            ("duration = ?", tags.duration.map(SqlValue::Real)),
            ("bitrate = ?", tags.bitrate.map(SqlValue::Integer)),
            ("samplerate = ?", tags.samplerate.map(SqlValue::Integer)),
            ("channels = ?", tags.channels.map(SqlValue::Integer)),
        ] {
            if let Some(value) = value {
                assignments.push(assignment);
                values.push(value);
            }
        }
        if !source_platform.is_empty() && source_platform != "local" {
            assignments.push("source_platform = ?");
            values.push(SqlValue::Text(source_platform.to_string()));
        }
        if !source_key.is_empty() {
            assignments.push("source_key = ?");
            values.push(SqlValue::Text(source_key.to_string()));
        }
        values.push(SqlValue::Integer(track_id));

        // 注意：**不清空**分析结果。写回标签本身会改 mtime，
        // 若这里把 analyzed_at 置空，每次写完标签再扫描就会无限重分析。
        conn.execute(
            &format!("UPDATE tracks SET {} WHERE id = ?", assignments.join(", ")),
            rusqlite::params_from_iter(values.iter()),
        )?;
        Ok(track_id)
    }

    fn touch_source(
        &self,
        conn: &Conn,
        track_id: i64,
        old_platform: &str,
        old_key: &str,
        source_platform: &str,
        source_key: &str,
    ) -> Result<()> {
        let mut assignments: Vec<&str> = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();
        if !source_platform.is_empty()
            && source_platform != "local"
            && old_platform != source_platform
        {
            assignments.push("source_platform = ?");
            values.push(SqlValue::Text(source_platform.to_string()));
        }
        if !source_key.is_empty() && old_key != source_key {
            assignments.push("source_key = ?");
            values.push(SqlValue::Text(source_key.to_string()));
        }
        if assignments.is_empty() {
            return Ok(());
        }
        values.push(SqlValue::Integer(track_id));
        conn.execute(
            &format!("UPDATE tracks SET {} WHERE id = ?", assignments.join(", ")),
            rusqlite::params_from_iter(values.iter()),
        )?;
        Ok(())
    }

    pub fn save_analysis(&self, track_id: i64, result: &AnalysisResult) -> Result<()> {
        let conn = self.db.conn()?;
        let now = now_iso();
        conn.execute(
            "UPDATE tracks SET bpm = ?, bpm_confidence = ?, first_beat = ?, music_key = ?, \
             camelot = ?, open_key = ?, key_confidence = ?, energy = ?, rms_db = ?, peak_db = ?, \
             analyzed_at = ?, modified_at = ?, analysis_error = ? WHERE id = ?",
            rusqlite::params![
                result.bpm,
                result.bpm_confidence,
                result.first_beat,
                result.key,
                result.camelot.to_uppercase(),
                result.open_key,
                result.key_confidence,
                result.energy,
                result.rms_db,
                result.peak_db,
                // 即使子分析失败也要盖上 analyzed_at，否则 pending 队列永远清不空、
                // 每次「分析未分析曲目」都会把坏文件重跑一遍。想重试用 force。
                now,
                now,
                result.errors.join("; "),
                track_id,
            ],
        )?;
        if result.duration > 0.0 {
            // 解码出来的时长比容器头里的更准，但只在库里没有时补
            conn.execute(
                "UPDATE tracks SET duration = ? WHERE id = ? AND (duration IS NULL OR duration <= 0)",
                rusqlite::params![result.duration, track_id],
            )?;
        }
        Ok(())
    }

    /// 保存 BPM/Key v2，并在对应字段成功产出后退役 tracks 中的 v1 副本。
    pub fn save_bpm_key_analysis_v2(&self, track_id: i64, result: &AnalysisResult) -> Result<()> {
        let mut conn = self.db.conn()?;
        let beat_times = serde_json::to_string(&result.beat_times).context("序列化 v2 拍点失败")?;
        let chroma = serde_json::to_string(&result.chroma).context("序列化 v2 chroma 失败")?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO track_bpm_key_analysis_v2 (
               track_id, analyzer_revision, bpm, bpm_raw, bpm_confidence, first_beat,
               beat_times_json, music_key, key_short, camelot, open_key, key_confidence,
               chroma_json, analyzed_at, analysis_error
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(track_id) DO UPDATE SET
               analyzer_revision = excluded.analyzer_revision,
               bpm = excluded.bpm,
               bpm_raw = excluded.bpm_raw,
               bpm_confidence = excluded.bpm_confidence,
               first_beat = excluded.first_beat,
               beat_times_json = excluded.beat_times_json,
               music_key = excluded.music_key,
               key_short = excluded.key_short,
               camelot = excluded.camelot,
               open_key = excluded.open_key,
               key_confidence = excluded.key_confidence,
               chroma_json = excluded.chroma_json,
               analyzed_at = excluded.analyzed_at,
               analysis_error = excluded.analysis_error",
            rusqlite::params![
                track_id,
                BPM_KEY_V2_REVISION,
                result.bpm,
                result.bpm_raw,
                result.bpm_confidence,
                result.first_beat,
                beat_times,
                result.key,
                result.key_short,
                result.camelot.to_uppercase(),
                result.open_key,
                result.key_confidence,
                chroma,
                now_iso(),
                result.errors.join("; "),
            ],
        )?;
        // v1 只是迁移兜底。v2 某一类结果成功产出后，清掉对应旧列，避免永久保存两份。
        // BPM 与 Key 分开判断，部分分析成功时仍保留另一类的 v1 兜底。
        if result.bpm.is_some() {
            tx.execute(
                "UPDATE tracks SET bpm = NULL, bpm_confidence = NULL, first_beat = NULL WHERE id = ?",
                [track_id],
            )?;
        }
        if !result.key.is_empty() {
            tx.execute(
                "UPDATE tracks SET music_key = NULL, camelot = NULL, open_key = NULL, \
                 key_confidence = NULL WHERE id = ?",
                [track_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 返回需要分析的 track id。
    ///
    /// **默认只挑 `analyzed_at IS NULL` 的**——这条是硬约束：Rust 版和 Python 版的
    /// BPM 在约 10% 的曲子上会选到不同的倍数，重算就会把用户已有的和声推荐打乱。
    /// 只有用户显式点「强制重新分析」（force=true）才覆盖。
    pub fn pending_analysis_ids(&self, track_ids: Option<&[i64]>, force: bool) -> Result<Vec<i64>> {
        let conn = self.db.conn()?;
        let condition = if force {
            ""
        } else {
            " WHERE analyzed_at IS NULL"
        };

        let Some(wanted) = track_ids else {
            let mut stmt =
                conn.prepare(&format!("SELECT id FROM tracks{condition} ORDER BY id"))?;
            let ids = stmt
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            return Ok(ids);
        };
        if wanted.is_empty() {
            return Ok(Vec::new());
        }

        let mut found: std::collections::HashSet<i64> = Default::default();
        for chunk in wanted.chunks(900) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let extra = if force {
                ""
            } else {
                " AND analyzed_at IS NULL"
            };
            let mut stmt = conn.prepare(&format!(
                "SELECT id FROM tracks WHERE id IN ({placeholders}){extra}"
            ))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                row.get::<_, i64>(0)
            })?;
            for row in rows {
                found.insert(row?);
            }
        }
        // 保持调用方给的顺序（前端选中的顺序 = 用户期望的分析顺序），并去重
        let mut seen: std::collections::HashSet<i64> = Default::default();
        Ok(wanted
            .iter()
            .copied()
            .filter(|id| found.contains(id) && seen.insert(*id))
            .collect())
    }

    /// 返回需要生成当前 BPM/Key v2 修订的曲目 id。
    ///
    /// 和 v1 队列完全独立：已有 analyzed_at 的旧曲也会进入这里；成功写入当前修订
    /// 后才退出。没传 id 时可限量，并从最近加入的曲目开始渐进回填。
    pub fn pending_bpm_key_analysis_v2_ids(
        &self,
        track_ids: Option<&[i64]>,
        force: bool,
        limit: Option<usize>,
        folder: Option<&str>,
    ) -> Result<Vec<i64>> {
        let conn = self.db.conn()?;
        let needs_v2 = if force {
            ""
        } else {
            " AND (v2.track_id IS NULL OR v2.analyzer_revision != ?)"
        };

        let Some(wanted) = track_ids else {
            let folder = folder.map(str::trim).filter(|value| !value.is_empty());
            let folder_clause = if folder.is_some() {
                " AND tracks.path LIKE ? ESCAPE '\\'"
            } else {
                ""
            };
            let sql = format!(
                "SELECT tracks.id FROM tracks
                 LEFT JOIN track_bpm_key_analysis_v2 v2 ON v2.track_id = tracks.id
                 WHERE 1 = 1{needs_v2}{folder_clause}
                 ORDER BY tracks.added_at DESC, tracks.id DESC{}",
                if limit.is_some() { " LIMIT ?" } else { "" }
            );
            let mut params: Vec<SqlValue> = Vec::new();
            if !force {
                params.push(SqlValue::Text(BPM_KEY_V2_REVISION.to_string()));
            }
            if let Some(folder) = folder {
                let prefix = format!("{}{SEP}", normalize_path(Path::new(folder)));
                params.push(SqlValue::Text(format!("{}%", escape_like(&prefix))));
            }
            if let Some(limit) = limit {
                params.push(SqlValue::Integer(limit.clamp(1, 2000) as i64));
            }
            let mut stmt = conn.prepare(&sql)?;
            return stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |row| row.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into);
        };
        if wanted.is_empty() {
            return Ok(Vec::new());
        }

        let mut found: std::collections::HashSet<i64> = Default::default();
        for chunk in wanted.chunks(899) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT tracks.id FROM tracks
                 LEFT JOIN track_bpm_key_analysis_v2 v2 ON v2.track_id = tracks.id
                 WHERE tracks.id IN ({placeholders}){needs_v2}"
            );
            let mut params: Vec<SqlValue> = chunk.iter().copied().map(SqlValue::Integer).collect();
            if !force {
                params.push(SqlValue::Text(BPM_KEY_V2_REVISION.to_string()));
            }
            let mut stmt = conn.prepare(&sql)?;
            for row in
                stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| row.get(0))?
            {
                found.insert(row?);
            }
        }
        let max = limit.unwrap_or(usize::MAX);
        let mut seen: std::collections::HashSet<i64> = Default::default();
        Ok(wanted
            .iter()
            .copied()
            .filter(|id| found.contains(id) && seen.insert(*id))
            .take(max)
            .collect())
    }

    // ------------------------------------------------------------ 和声推荐

    /// Camelot 兼容 + BPM 接近的候选，score 越大越靠前。
    ///
    /// 默认走 wide：宁可多列几首让人自己挑，也不要因为规则太紧而空手。
    /// 排序把稳妥的选项放前面，所以"更多"不会变成"更差"。
    /// `folder` 非空时只在这个目录（含子目录）里找候选——「接下一首」的
    /// 范围开关用它：现场演出常常是"这个歌单文件夹内接歌"，跨包推荐会把
    /// 准备之外的曲目接进来。空串 = 全库，和 v0.1.0 一致。
    pub fn harmonic_matches(
        &self,
        track_id: i64,
        bpm_tolerance: f64,
        limit: usize,
        wide: bool,
        folder: &str,
    ) -> Result<Vec<HarmonicMatch>> {
        let Some(source) = self.get(track_id)? else {
            return Ok(Vec::new());
        };
        if source.camelot.is_empty() {
            return Ok(Vec::new());
        }
        let relations = camelot_relations(&source.camelot, wide);
        if relations.is_empty() {
            return Ok(Vec::new());
        }
        let tolerance = if bpm_tolerance > 0.0 {
            bpm_tolerance
        } else {
            6.0
        };
        // limit=0 当"没传"，退回默认 50（和 v0.1.0 的 `limit or 50` 一致）；
        // 夹成 1 会让传 0 的客户端只拿到一首，看着像推荐算法坏了
        let limit = if limit == 0 { 50 } else { limit.min(500) };

        let conn = self.db.conn()?;
        let placeholders = vec!["?"; relations.len()].join(",");
        let mut params: Vec<SqlValue> = relations
            .iter()
            .map(|(code, _)| SqlValue::Text(code.clone()))
            .collect();
        params.push(SqlValue::Integer(track_id));

        let mut bpm_clause = String::new();
        if let Some(bpm) = source.bpm.filter(|value| *value > 0.0) {
            // BPM 范围下推到 SQL，别把整个兼容调的曲目都拉进内存再筛。
            // BETWEEN 遇到 NULL 为假，顺带把没分析出 BPM 的候选也挡掉了。
            let (low, high) = (bpm - tolerance, bpm + tolerance);
            let ranges = [
                (low, high),
                (low * 2.0, high * 2.0),
                (low / 2.0, high / 2.0),
            ];
            let candidate_bpm = effective_bpm_key_column("bpm");
            bpm_clause = format!(
                " AND ({})",
                vec![format!("({candidate_bpm}) BETWEEN ? AND ?"); ranges.len()].join(" OR ")
            );
            for (lo, hi) in ranges {
                params.push(SqlValue::Real(lo));
                params.push(SqlValue::Real(hi));
            }
        }

        // 目录过滤和 build_where 里同一套写法：前缀过 escape_like，深层包含
        let mut folder_clause = String::new();
        let folder = folder.trim().trim_end_matches('/');
        if !folder.is_empty() {
            let prefix = format!("{}{SEP}", normalize_path(Path::new(folder)));
            folder_clause = " AND path LIKE ? ESCAPE '\\'".into();
            params.push(SqlValue::Text(format!("{}%", escape_like(&prefix))));
        }

        let effective_camelot = effective_bpm_key_column("camelot");
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM tracks WHERE UPPER(COALESCE(({effective_camelot}), '')) IN ({placeholders}) \
             AND id != ?{bpm_clause}{folder_clause}"
        ))?;
        let candidates: Vec<Track> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(row_to_track(row))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let candidates = self.attach_tags(&conn, self.apply_bpm_key_v2(&conn, candidates)?)?;

        let relation_of: HashMap<&str, HarmonicRelation> = relations
            .iter()
            .map(|(code, relation)| (code.as_str(), *relation))
            .collect();

        let mut matches: Vec<HarmonicMatch> = Vec::new();
        for track in candidates {
            let Some(relation) = relation_of.get(track.camelot.as_str()).copied() else {
                continue;
            };
            let (ratio, delta) = match (source.bpm, track.bpm) {
                (Some(source_bpm), Some(candidate_bpm)) if source_bpm > 0.0 => {
                    match best_tempo(candidate_bpm, source_bpm, tolerance) {
                        Some(aligned) => aligned,
                        None => continue,
                    }
                }
                // 本曲有 BPM、候选没分析出 BPM：没法确认能不能对拍，直接排除
                (Some(source_bpm), None) if source_bpm > 0.0 => continue,
                _ => (1.0, 0.0),
            };
            let distance = delta.abs() / tolerance.max(0.5)
                + 0.5 * relation_distance(relation)
                // 半速/倍速能接，但不如同速自然
                + if ratio == 1.0 { 0.0 } else { 0.75 };
            matches.push(HarmonicMatch {
                relation,
                relation_label: relation_label(relation).to_string(),
                bpm_delta: (delta * 100.0).round() / 100.0,
                tempo_ratio: ratio,
                score: ((1.0 / (1.0 + distance)) * 10_000.0).round() / 10_000.0,
                track,
            });
        }

        matches.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.bpm_delta.abs().total_cmp(&b.bpm_delta.abs()))
                .then_with(|| {
                    a.track
                        .title
                        .to_lowercase()
                        .cmp(&b.track.title.to_lowercase())
                })
        });

        // 同一首歌常常在好几个 set 文件夹里各有一份复制文件，
        // 不去重的话推荐列表会连着四行同一首。按 标题+艺人 归一后只留分数最高的；
        // 没有标题的退回文件名，免得一堆未打标签的被并成一条。
        let mut seen: std::collections::HashSet<(String, String)> = Default::default();
        let mut unique = Vec::new();
        for item in matches {
            let title = if item.track.title.is_empty() {
                &item.track.filename
            } else {
                &item.track.title
            };
            let ident = (
                title.trim().to_lowercase(),
                item.track.artist.trim().to_lowercase(),
            );
            if seen.insert(ident) {
                unique.push(item);
            }
            if unique.len() >= limit {
                break;
            }
        }
        Ok(unique)
    }

    // ------------------------------------------------------------ 统计

    pub fn stats(&self) -> Result<LibraryStats> {
        let conn = self.db.conn()?;
        let (total, analyzed, bpm_key_v2_analyzed, total_duration, total_size): (
            i64,
            i64,
            i64,
            f64,
            i64,
        ) = conn.query_row(
            "SELECT COUNT(*), SUM(CASE WHEN tracks.analyzed_at IS NOT NULL THEN 1 ELSE 0 END),
             SUM(CASE WHEN v2.analyzer_revision = ? THEN 1 ELSE 0 END),
             COALESCE(SUM(tracks.duration), 0), COALESCE(SUM(tracks.size), 0)
             FROM tracks LEFT JOIN track_bpm_key_analysis_v2 v2 ON v2.track_id = tracks.id",
            [BPM_KEY_V2_REVISION],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;

        fn median(mut values: Vec<f64>) -> Option<f64> {
            values.retain(|value| value.is_finite());
            if values.is_empty() {
                return None;
            }
            values.sort_by(f64::total_cmp);
            let middle = values.len() / 2;
            Some(if values.len() % 2 == 0 {
                (values[middle - 1] + values[middle]) / 2.0
            } else {
                values[middle]
            })
        }

        let mut energies = Vec::new();
        let mut rms_values = Vec::new();
        let mut peak_values = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT energy, rms_db, peak_db FROM tracks WHERE analyzed_at IS NOT NULL",
            )?;
            for row in stmt.query_map([], |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                ))
            })? {
                let (energy, rms, peak) = row?;
                if let Some(value) = energy {
                    energies.push(value as f64);
                }
                if let Some(value) = rms {
                    rms_values.push(value);
                }
                if let Some(value) = peak {
                    peak_values.push(value);
                }
            }
        }
        let energy_median = median(energies);
        let rms_db_median = median(rms_values);
        let peak_db_median = median(peak_values);

        let mut raw_camelot: HashMap<String, i64> = HashMap::new();
        {
            let camelot = effective_bpm_key_column("camelot");
            let mut stmt = conn.prepare(&format!(
                "SELECT UPPER({camelot}), COUNT(*) FROM tracks \
                 WHERE ({camelot}) IS NOT NULL AND ({camelot}) != '' GROUP BY UPPER({camelot})"
            ))?;
            for row in stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })? {
                let (code, count) = row?;
                raw_camelot.insert(code, count);
            }
        }
        // 按轮盘顺序输出，前端画 Camelot 轮时不用再排。
        // BTreeMap 会按字典序，所以用带序号的键名保序不可行——
        // 这里靠 serde 的 BTreeMap 序列化，前端本来就按自己的轮盘顺序取值，不依赖 JSON 顺序。
        let by_camelot: BTreeMap<String, i64> = CAMELOT_TO_KEY
            .iter()
            .filter_map(|(code, _)| {
                raw_camelot
                    .get(*code)
                    .map(|count| ((*code).to_string(), *count))
            })
            .collect();

        let mut buckets: HashMap<String, i64> = HashMap::new();
        {
            let bpm = effective_bpm_key_column("bpm");
            let mut stmt = conn.prepare(&format!(
                "SELECT {bpm} FROM tracks WHERE ({bpm}) IS NOT NULL AND ({bpm}) > 0"
            ))?;
            for row in stmt.query_map([], |row| row.get::<_, f64>(0))? {
                *buckets.entry(bpm_bucket(row?)).or_insert(0) += 1;
            }
        }
        let by_bpm_bucket: BTreeMap<String, i64> = BPM_BUCKET_ORDER
            .iter()
            .filter_map(|name| {
                buckets
                    .get(*name)
                    .map(|count| ((*name).to_string(), *count))
            })
            .collect();

        let mut by_platform: BTreeMap<String, i64> = BTreeMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT COALESCE(NULLIF(source_platform, ''), 'local'), COUNT(*) \
                 FROM tracks GROUP BY 1",
            )?;
            for row in stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })? {
                let (platform, count) = row?;
                by_platform.insert(platform, count);
            }
        }

        Ok(LibraryStats {
            total,
            analyzed,
            bpm_key_v2_analyzed,
            bpm_key_v2_pending: total.saturating_sub(bpm_key_v2_analyzed),
            bpm_key_v2_revision: BPM_KEY_V2_REVISION.to_string(),
            total_duration,
            total_size,
            energy_median,
            rms_db_median,
            peak_db_median,
            by_camelot,
            by_bpm_bucket,
            by_platform,
        })
    }

    // ------------------------------------------------------------ 路径维护

    /// 全部曲目路径。文件夹树按它统计每个目录下有几首。
    pub fn all_paths(&self) -> Result<Vec<String>> {
        let conn = self.db.conn()?;
        let mut stmt = conn.prepare("SELECT path FROM tracks")?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(paths)
    }

    /// 只返回没有当前 canonical 波形、生成失败或源文件已变动的已分析曲目。
    /// 第一轮升级会为旧 JSON 缓存补状态；之后启动不再遍历整个缓存目录。
    pub fn waveform_candidates(&self, profile: &str, revision: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.db.conn()?;
        let mut stmt = conn.prepare(
            "SELECT tracks.id, tracks.path FROM tracks \
             LEFT JOIN waveform_assets ON waveform_assets.track_id = tracks.id \
             WHERE tracks.analyzed_at IS NOT NULL AND (\
               waveform_assets.track_id IS NULL OR waveform_assets.profile != ? OR \
               waveform_assets.revision != ? OR waveform_assets.error IS NOT NULL OR \
               (tracks.file_mtime IS NOT NULL AND \
                waveform_assets.file_mtime != CAST(tracks.file_mtime AS INTEGER))\
             ) ORDER BY tracks.id",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![profile, revision], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 波形正文仍在文件系统；这里仅记录“哪一版资产已经能直接播放使用”。
    /// upsert 让分析预热、旧库补齐和播放器请求可以安全地重复确认同一状态。
    pub fn record_waveform_asset(
        &self,
        track_id: i64,
        profile: &str,
        revision: i64,
        file_mtime: u64,
        error: Option<&str>,
    ) -> Result<()> {
        let conn = self.db.conn()?;
        conn.execute(
            "INSERT INTO waveform_assets \
             (track_id, profile, revision, file_mtime, generated_at, error) \
             VALUES (?, ?, ?, ?, datetime('now'), ?) \
             ON CONFLICT(track_id) DO UPDATE SET \
               profile = excluded.profile, revision = excluded.revision, \
               file_mtime = excluded.file_mtime, generated_at = excluded.generated_at, \
               error = excluded.error",
            rusqlite::params![track_id, profile, revision, file_mtime as i64, error],
        )?;
        Ok(())
    }

    /// 曲目文件被移动之后，把库里的 path/filename 跟着改掉。
    ///
    /// 不重新读标签：移动不改内容，重读一遍是纯浪费；
    /// 分析结果、评分、备注全都原样保留——这正是"移动"和"删了再扫"的区别。
    pub fn relocate(&self, track_id: i64, new_path: &Path) -> Result<Track> {
        let conn = self.db.conn()?;
        let key_path = normalize_path(new_path);
        let filename = Path::new(&key_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        conn.execute(
            "UPDATE tracks SET path = ?, filename = ?, modified_at = ? WHERE id = ?",
            rusqlite::params![key_path, filename, now_iso(), track_id],
        )?;
        // 同 patch：读回之前先把连接还回池里
        drop(conn);
        self.get(track_id)?.context("曲目不存在")
    }

    /// 目录改名后，把该目录下所有曲目的 path 前缀整体换掉，返回受影响的 id。
    ///
    /// 用代码改而不是一条 `UPDATE ... replace(path, ?, ?)`：SQL 的 replace
    /// 会替换字符串里**每一处**匹配，路径里恰好出现两次同名片段时就会改错
    /// （`/Music/set1/set1/a.mp3` 这种目录并不罕见）。
    pub fn rebase_paths(&self, old_dir: &Path, new_dir: &Path) -> Result<Vec<i64>> {
        let old_prefix = format!("{}{SEP}", normalize_path(old_dir));
        let new_prefix = format!("{}{SEP}", normalize_path(new_dir));
        let conn = self.db.conn()?;

        let mut stmt = conn.prepare("SELECT id, path FROM tracks WHERE path LIKE ? ESCAPE '\\'")?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([format!("{}%", escape_like(&old_prefix))], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let stamp = now_iso();
        for (id, path) in &rows {
            let rebased = format!("{new_prefix}{}", &path[old_prefix.len()..]);
            conn.execute(
                "UPDATE tracks SET path = ?, modified_at = ? WHERE id = ?",
                rusqlite::params![rebased, stamp, id],
            )?;
        }
        Ok(rows.into_iter().map(|(id, _)| id).collect())
    }

    /// 把分析结果和人工标记复制到复制出来的本地文件上。
    ///
    /// 复制文件的音频内容相同，重新分析没有必要；评分和备注也一并带过去，
    /// 让文件夹分类不会丢失用户已经整理好的信息。
    pub fn clone_metadata(&self, source_id: i64, target_id: i64) -> Result<()> {
        const COLUMNS: &str = "title, artist, album, genre, year, duration, bitrate, \
             samplerate, channels, format, bpm, bpm_confidence, first_beat, music_key, camelot, \
             open_key, key_confidence, energy, rms_db, peak_db, rating, color, comment, cue_ms, \
             end_ms, source_platform, source_key, analyzed_at, analysis_error";
        let assignments: Vec<String> = COLUMNS
            .split(',')
            .map(|name| format!("{} = ?", name.trim()))
            .collect();

        let conn = self.db.conn()?;
        let values: Vec<SqlValue> = {
            let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM tracks WHERE id = ?"))?;
            let mut rows = stmt.query([source_id])?;
            let Some(row) = rows.next()? else {
                return Ok(());
            };
            (0..assignments.len())
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<std::result::Result<_, _>>()?
        };

        let mut params = values;
        params.push(SqlValue::Text(now_iso()));
        params.push(SqlValue::Integer(target_id));
        conn.execute(
            &format!(
                "UPDATE tracks SET {}, modified_at = ? WHERE id = ?",
                assignments.join(", ")
            ),
            rusqlite::params_from_iter(params.iter()),
        )?;
        conn.execute(
            "INSERT INTO track_bpm_key_analysis_v2 (
               track_id, analyzer_revision, bpm, bpm_raw, bpm_confidence, first_beat,
               beat_times_json, music_key, key_short, camelot, open_key, key_confidence,
               chroma_json, analyzed_at, analysis_error
             )
             SELECT ?, analyzer_revision, bpm, bpm_raw, bpm_confidence, first_beat,
               beat_times_json, music_key, key_short, camelot, open_key, key_confidence,
               chroma_json, analyzed_at, analysis_error
             FROM track_bpm_key_analysis_v2 WHERE track_id = ?
             ON CONFLICT(track_id) DO UPDATE SET
               analyzer_revision = excluded.analyzer_revision,
               bpm = excluded.bpm, bpm_raw = excluded.bpm_raw,
               bpm_confidence = excluded.bpm_confidence, first_beat = excluded.first_beat,
               beat_times_json = excluded.beat_times_json, music_key = excluded.music_key,
               key_short = excluded.key_short, camelot = excluded.camelot,
               open_key = excluded.open_key, key_confidence = excluded.key_confidence,
               chroma_json = excluded.chroma_json, analyzed_at = excluded.analyzed_at,
               analysis_error = excluded.analysis_error",
            rusqlite::params![target_id, source_id],
        )?;
        conn.execute("DELETE FROM tags WHERE track_id = ?", [target_id])?;
        conn.execute(
            "INSERT OR IGNORE INTO tags (track_id, tag) SELECT ?, tag FROM tags WHERE track_id = ?",
            rusqlite::params![target_id, source_id],
        )?;
        Ok(())
    }

    /// path → (id, file_mtime, 标签可疑地空)。扫描前一次性拉出来做增量比对，
    /// 比每个文件查一次库快一个数量级。
    ///
    /// 第三个布尔是给增量跳过用的例外：艺人和专辑**双双为空**的行多半是
    /// 早年入库时读标签失败留下的（文件里其实有），mtime 又恰好没变，
    /// 光靠"文件动过才重读"永远修不好——所以这种行不许走快路径。
    /// 真没标签的文件会因此每次扫描都被多读一遍标签，代价是每个文件几毫秒，
    /// 换来的是坏行自动愈合，不用用户挨个点「重读标签」。
    pub fn file_index(&self) -> Result<HashMap<String, (i64, f64, bool)>> {
        let conn = self.db.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, path, file_mtime, \
             (COALESCE(artist, '') = '' AND COALESCE(album, '') = '') FROM tracks",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                (
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    row.get::<_, bool>(3)?,
                ),
            ))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

// ---------------------------------------------------------------- 行映射

fn text(row: &Row, name: &str) -> String {
    row.get::<_, Option<String>>(name)
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn row_to_track(row: &Row) -> Track {
    let path = text(row, "path");
    Track {
        id: row.get("id").unwrap_or(0),
        folder: Path::new(&path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default(),
        filename: text(row, "filename"),
        title: text(row, "title"),
        artist: text(row, "artist"),
        album: text(row, "album"),
        genre: text(row, "genre"),
        year: text(row, "year"),
        duration: row.get("duration").ok().flatten(),
        bitrate: row.get("bitrate").ok().flatten(),
        samplerate: row.get("samplerate").ok().flatten(),
        channels: row.get("channels").ok().flatten(),
        format: text(row, "format"),
        size: row
            .get::<_, Option<i64>>("size")
            .ok()
            .flatten()
            .unwrap_or(0),
        bpm: row.get("bpm").ok().flatten(),
        bpm_v2: false,
        bpm_confidence: row.get("bpm_confidence").ok().flatten(),
        first_beat: row.get("first_beat").ok().flatten(),
        music_key: text(row, "music_key"),
        camelot: text(row, "camelot").to_uppercase(),
        open_key: text(row, "open_key"),
        key_confidence: row.get("key_confidence").ok().flatten(),
        energy: row.get("energy").ok().flatten(),
        rms_db: row.get("rms_db").ok().flatten(),
        peak_db: row.get("peak_db").ok().flatten(),
        rating: row
            .get::<_, Option<i64>>("rating")
            .ok()
            .flatten()
            .unwrap_or(0),
        color: text(row, "color"),
        comment: text(row, "comment"),
        cue_ms: row.get("cue_ms").ok().flatten(),
        end_ms: row.get("end_ms").ok().flatten(),
        source_platform: {
            let value = text(row, "source_platform");
            if value.is_empty() {
                "local".to_string()
            } else {
                value
            }
        },
        source_key: text(row, "source_key"),
        analyzed_at: row.get::<_, Option<String>>("analyzed_at").ok().flatten(),
        added_at: text(row, "added_at"),
        modified_at: text(row, "modified_at"),
        analysis_error: text(row, "analysis_error"),
        tags: Vec::new(),
        path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kdj_core::models::HarmonicRelation;

    /// 伪造曲库根。**必须带盘符**，`/lib` 或 `\lib` 都不行。
    ///
    /// Windows 上 `\lib` 只有 root 没有 prefix，`Path::is_absolute()` 是 false，
    /// 于是 `normalize_path` 会把当前工作目录的盘符拼上去变成 `D:\lib`；
    /// 而下面的 `insert` 是把裸路径直接写进库的（存的还是 `\lib\...`），
    /// 前缀就永远对不上，folder 过滤和 rebase 一条都查不出来。
    /// Unix 上 `/lib` 本身已经是绝对路径，所以这个坑只在 Windows 上炸。
    #[cfg(windows)]
    const ROOT: &str = r"C:\lib";
    #[cfg(not(windows))]
    const ROOT: &str = "/lib";

    /// 直接写行，不碰文件系统：这一层要验的是 SQL 和排序规则，
    /// 走 `upsert_file` 反而会把测试绑在标签解析上。
    struct Row<'a> {
        path: &'a str,
        title: &'a str,
        camelot: &'a str,
        bpm: Option<f64>,
        analyzed: bool,
    }

    impl Default for Row<'_> {
        fn default() -> Self {
            Row {
                path: "/lib/a.mp3",
                title: "",
                camelot: "",
                bpm: None,
                analyzed: false,
            }
        }
    }

    fn service() -> LibraryService {
        LibraryService::new(Database::open_in_memory().unwrap())
    }

    fn insert(service: &LibraryService, row: Row<'_>) -> i64 {
        let conn = service.db().conn().unwrap();
        let filename = Path::new(row.path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        conn.execute(
            "INSERT INTO tracks (path, filename, title, camelot, bpm, analyzed_at, added_at, \
             modified_at) VALUES (?, ?, ?, ?, ?, ?, 'now', 'now')",
            rusqlite::params![
                row.path,
                filename,
                row.title,
                row.camelot,
                row.bpm,
                if row.analyzed {
                    Some("2024-01-01T00:00:00Z")
                } else {
                    None
                },
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn query(folder: &str, deep: bool) -> TrackQuery {
        TrackQuery {
            folder: folder.to_string(),
            folder_deep: deep,
            limit: 200,
            ..Default::default()
        }
    }

    fn paths(page: &TrackPage) -> Vec<String> {
        page.items.iter().map(|t| t.path.clone()).collect()
    }

    #[test]
    fn delete_undo_restores_the_file_metadata_tags_and_playlist_position() {
        let base = std::env::temp_dir().join(format!("kdj-delete-undo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("song.mp3");
        std::fs::write(&path, b"audio").unwrap();
        let path_text = path.to_string_lossy().into_owned();
        let service = service();
        let id = insert(
            &service,
            Row {
                path: &path_text,
                title: "撤回测试",
                camelot: "8A",
                bpm: Some(128.0),
                analyzed: true,
            },
        );
        let conn = service.db().conn().unwrap();
        conn.execute(
            "INSERT INTO tags (track_id, tag) VALUES (?, ?)",
            rusqlite::params![id, "favorite"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, ?)",
            rusqlite::params![7, id, 3],
        )
        .unwrap();
        drop(conn);

        let (removed, snapshot) = service.delete_for_undo(id, FileDisposal::Keep).unwrap();
        assert!(removed);
        assert!(path.is_file(), "只移出曲库不应动文件");
        assert!(service.get(id).unwrap().is_none());

        let restored = service.restore_deleted(&snapshot.unwrap()).unwrap();
        assert_eq!(restored.id, id);
        assert_eq!(restored.title, "撤回测试");
        assert_eq!(restored.camelot, "8A");
        assert_eq!(restored.tags, vec!["favorite"]);
        let position: i64 = service
            .db()
            .conn()
            .unwrap()
            .query_row(
                "SELECT position FROM playlist_items WHERE playlist_id = ? AND track_id = ?",
                rusqlite::params![7, id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(position, 3);
        assert!(path.is_file());
        drop(service);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn trash_delete_undo_restores_the_original_file() {
        let base = std::env::temp_dir().join(format!("kdj-trash-undo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("song.mp3");
        std::fs::write(&path, b"audio").unwrap();
        let path_text = path.to_string_lossy().into_owned();
        let service = service();
        let id = insert(
            &service,
            Row {
                path: &path_text,
                title: "回收站撤回测试",
                ..Default::default()
            },
        );

        let (removed, snapshot) = service.delete_for_undo(id, FileDisposal::Trash).unwrap();
        assert!(removed);
        assert!(!path.exists());
        let snapshot = snapshot.expect("macOS 回收站应返回实际文件位置");
        service.restore_deleted(&snapshot).unwrap();
        assert!(path.is_file());
        assert_eq!(service.get(id).unwrap().unwrap().title, "回收站撤回测试");
        drop(service);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_filter_shows_only_this_level_unless_deep() {
        let service = service();
        let root = ROOT.to_string();
        insert(
            &service,
            Row {
                path: &format!("{root}{SEP}a.mp3"),
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: &format!("{root}{SEP}set1{SEP}b.mp3"),
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: &format!("{root}-evil{SEP}c.mp3"),
                ..Default::default()
            },
        );

        let shallow = service.list_tracks(&query(&root, false)).unwrap();
        assert_eq!(shallow.total, 1);
        assert!(
            paths(&shallow)[0].ends_with("a.mp3"),
            "子目录和同前缀兄弟目录都不算"
        );

        let deep = service.list_tracks(&query(&root, true)).unwrap();
        assert_eq!(deep.total, 2, "打开开关才连子目录一起看");
    }

    #[test]
    fn folder_filter_escapes_like_wildcards_in_the_path() {
        // 目录名里带 % / _ 是合法的，不转义的话 `%` 会匹配到任意别的目录
        let service = service();
        let tricky = format!("{ROOT}{SEP}100%_mix");
        insert(
            &service,
            Row {
                path: &format!("{tricky}{SEP}a.mp3"),
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: &format!("{ROOT}{SEP}100XYmix{SEP}b.mp3"),
                ..Default::default()
            },
        );

        let page = service.list_tracks(&query(&tricky, false)).unwrap();
        assert_eq!(page.total, 1);
        assert!(paths(&page)[0].ends_with("a.mp3"));
    }

    #[test]
    fn search_text_escapes_like_wildcards() {
        // 用户搜 "50%" 不该变成匹配一切
        let service = service();
        insert(
            &service,
            Row {
                path: "/lib/a.mp3",
                title: "50% off",
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: "/lib/b.mp3",
                title: "完全无关",
                ..Default::default()
            },
        );

        let page = service
            .list_tracks(&TrackQuery {
                q: "50%".into(),
                limit: 200,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 1);
    }

    #[test]
    fn analyzed_filter_splits_the_library_in_two() {
        let service = service();
        insert(
            &service,
            Row {
                path: "/lib/a.mp3",
                analyzed: true,
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: "/lib/b.mp3",
                ..Default::default()
            },
        );

        let done = service
            .list_tracks(&TrackQuery {
                analyzed: Some(true),
                limit: 200,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(done.total, 1);
        let todo = service
            .list_tracks(&TrackQuery {
                analyzed: Some(false),
                limit: 200,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(todo.total, 1);
        assert!(paths(&todo)[0].ends_with("b.mp3"));
    }

    #[test]
    fn camelot_sort_is_numeric_and_nulls_sink_in_both_directions() {
        let service = service();
        insert(
            &service,
            Row {
                path: "/lib/a.mp3",
                camelot: "10A",
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: "/lib/b.mp3",
                camelot: "8A",
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: "/lib/c.mp3",
                ..Default::default()
            },
        );

        let ascending = service
            .list_tracks(&TrackQuery {
                sort: "camelot".into(),
                order: "asc".into(),
                limit: 200,
                ..Default::default()
            })
            .unwrap();
        let codes: Vec<&str> = ascending.items.iter().map(|t| t.camelot.as_str()).collect();
        assert_eq!(
            codes,
            vec!["8A", "10A", ""],
            "字符串排序会把 10A 排到 8A 前面"
        );

        let descending = service
            .list_tracks(&TrackQuery {
                sort: "camelot".into(),
                order: "desc".into(),
                limit: 200,
                ..Default::default()
            })
            .unwrap();
        let codes: Vec<&str> = descending
            .items
            .iter()
            .map(|t| t.camelot.as_str())
            .collect();
        assert_eq!(codes, vec!["10A", "8A", ""], "空值升降序都垫底");
    }

    #[test]
    fn custom_sort_follows_the_folder_manifest() {
        let service = service();
        let dir = std::env::temp_dir().join(format!("kdj-custom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let folder = normalize_path(&dir);

        for name in ["a.mp3", "b.mp3", "c.mp3"] {
            insert(
                &service,
                Row {
                    path: &format!("{folder}{SEP}{name}"),
                    ..Default::default()
                },
            );
        }
        // 清单只列了两首，没列的那首按文件名排在后面
        crate::folders::write_manifest(Path::new(&folder), &["c.mp3".into(), "a.mp3".into()])
            .unwrap();

        let page = service
            .list_tracks(&TrackQuery {
                folder: folder.clone(),
                sort: "custom".into(),
                limit: 200,
                ..Default::default()
            })
            .unwrap();
        let names: Vec<&str> = page.items.iter().map(|t| t.filename.as_str()).collect();
        assert_eq!(names, vec!["c.mp3", "a.mp3", "b.mp3"]);
        assert_eq!(page.total, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_under_removes_db_rows_only() {
        let service = service();
        let keep = format!("{ROOT}{SEP}keep.mp3");
        let gone_a = format!("{ROOT}{SEP}set{SEP}a.mp3");
        let gone_b = format!("{ROOT}{SEP}set{SEP}nested{SEP}b.mp3");
        insert(
            &service,
            Row {
                path: &keep,
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: &gone_a,
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: &gone_b,
                ..Default::default()
            },
        );

        let folder = format!("{ROOT}{SEP}set");
        let removed = service.forget_under(Path::new(&folder)).unwrap();
        assert_eq!(removed.len(), 2);
        let left = service.all_paths().unwrap();
        assert_eq!(left, vec![keep], "只摘目标目录下的，别的根里的歌还在");
    }

    #[test]
    fn paging_clamps_limit_and_offset() {
        let service = service();
        for index in 0..5 {
            insert(
                &service,
                Row {
                    path: &format!("/lib/{index}.mp3"),
                    ..Default::default()
                },
            );
        }
        let page = service
            .list_tracks(&TrackQuery {
                limit: 2,
                offset: 4,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 5);
        assert_eq!(page.items.len(), 1, "最后一页只剩一条");
        assert_eq!(page.limit, 2);
        assert_eq!(page.offset, 4);

        let clamped = service
            .list_tracks(&TrackQuery {
                limit: 99_999,
                offset: -3,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(clamped.limit, 2000);
        assert_eq!(clamped.offset, 0);
    }

    #[test]
    fn a_secondary_sort_orders_within_ties_on_the_primary() {
        // DJ 排 set 的实际用法：先按 BPM，同 BPM 的那一撮里再按调号。
        // 只有一个排序键时，同 BPM 的十几首是乱序的，得靠眼睛在里面找能接的调。
        let service = service();
        for (name, bpm, camelot) in [
            ("b-128-8A", 128.0, "8A"),
            ("a-128-10A", 128.0, "10A"),
            ("c-128-1A", 128.0, "1A"),
            ("d-120-5A", 120.0, "5A"),
        ] {
            insert(
                &service,
                Row {
                    path: &format!("{ROOT}{SEP}{name}.mp3"),
                    title: name,
                    bpm: Some(bpm),
                    camelot,
                    analyzed: true,
                    ..Default::default()
                },
            );
        }

        let page = service
            .list_tracks(&TrackQuery {
                sort: "bpm".into(),
                order: "desc".into(),
                sort2: "camelot".into(),
                order2: "asc".into(),
                ..Default::default()
            })
            .unwrap();
        let titles: Vec<&str> = page.items.iter().map(|t| t.title.as_str()).collect();
        // 128 的三首排在前面（bpm desc），它们内部按 camelot 升序：1A < 8A < 10A。
        // 注意 10A 排在 8A **后面**——camelot 是拆成数字排的，不是字符串排的
        assert_eq!(
            titles,
            vec!["c-128-1A", "b-128-8A", "a-128-10A", "d-120-5A"]
        );

        // 副键和主键相同要被忽略，而不是拼出一条重复的 ORDER BY
        let same = service
            .list_tracks(&TrackQuery {
                sort: "bpm".into(),
                order: "desc".into(),
                sort2: "bpm".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(same.items.len(), 4);

        // 不给副键时行为和以前完全一致（只按主键 + id 兜底）
        let none = service
            .list_tracks(&TrackQuery {
                sort: "bpm".into(),
                order: "desc".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(none.items.first().unwrap().bpm, Some(128.0));
    }

    #[test]
    fn limit_zero_means_the_default_page_not_a_single_row() {
        // v0.1.0 是 `max(1, min(limit or 200, 2000))`：0 当"没传"。
        // 夹成 1 的话，没显式给 limit 的调用只回一条，看着像曲库空了
        let service = service();
        for index in 0..3 {
            insert(
                &service,
                Row {
                    path: &format!("/lib/{index}.mp3"),
                    ..Default::default()
                },
            );
        }
        let page = service.list_tracks(&TrackQuery::default()).unwrap();
        assert_eq!(page.limit, 200);
        assert_eq!(page.items.len(), 3);
    }

    #[test]
    fn patch_clamps_rating_and_normalizes_tags() {
        let service = service();
        let id = insert(&service, Row::default());
        let track = service
            .patch(
                id,
                &TrackPatch {
                    rating: Some(99),
                    tags: Some(vec![
                        "  house ".into(),
                        "house".into(),
                        "".into(),
                        "  ".into(),
                        "techno".into(),
                    ]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(track.rating, 5);
        assert_eq!(
            track.tags,
            vec!["house", "techno"],
            "去空白、去重、按字母排"
        );
        assert!(
            service.patch(id + 999, &TrackPatch::default()).is_err(),
            "不存在的 id 要报错"
        );
    }

    #[test]
    fn patch_writes_year_to_the_year_column() {
        // year 是后加进 TrackPatch 的字段；漏在 SQL 里的话前端存了不报错、刷新就没了
        let service = service();
        let id = insert(&service, Row::default());
        let track = service
            .patch(
                id,
                &TrackPatch {
                    year: Some("2021-05-17".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            track.year, "2021-05-17",
            "整串日期要原样存住，不能截成 2021"
        );
    }

    /// 造一个 2 秒静音 WAV，用来做"真的写标签"的测试。
    fn wav_bytes() -> Vec<u8> {
        const RATE: u32 = 8000;
        let data_len = RATE * 2;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
        out.extend_from_slice(&RATE.to_le_bytes());
        out.extend_from_slice(&RATE.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.resize(44 + data_len as usize, 128);
        out
    }

    fn scratch_track(name: &str) -> (LibraryService, i64, PathBuf) {
        let dir = std::env::temp_dir().join(format!("kdj-meta-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = std::fs::canonicalize(&dir).unwrap().join("song.wav");
        std::fs::write(&path, wav_bytes()).unwrap();

        let service = service();
        let id = service.upsert_file(&path, "local", "").unwrap();
        (service, id, path)
    }

    /// 库里记的 file_mtime。
    fn stored_mtime(service: &LibraryService, path: &Path) -> f64 {
        service.file_index().unwrap()[&normalize_path(path)].1
    }

    fn disk_mtime(path: &Path) -> f64 {
        std::fs::metadata(path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
    }

    #[test]
    fn writing_tags_back_keeps_the_stored_mtime_in_step_with_the_file() {
        let (service, id, path) = scratch_track("mtime");
        // Windows CI 偶发：创建与写标签落在同一 mtime tick，after == before。
        // 先把磁盘时间拨回过去，再 sync 进库，后面的写入就一定能推高 mtime。
        // 注意不能用 File::open()：Windows 上那是只读共享句柄，SetFileTime
        // 需要 FILE_WRITE_ATTRIBUTES，会报 Access is denied (os error 5)。
        let past = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(past)
            .unwrap();
        service.sync_file_stat(id).unwrap();
        let before = stored_mtime(&service, &path);

        let patch = TrackPatch {
            title: Some("手改的标题".into()),
            artist: Some("手改的艺人".into()),
            year: Some("2019".into()),
            // 备注是 App 自己的字段，不写文件，也不该因此触发一次文件重写
            comment: Some("三段前放".into()),
            ..Default::default()
        };
        service.patch(id, &patch).unwrap();
        service.write_patch_to_file(id, &patch).unwrap();

        let tags = read_tags(&path);
        assert_eq!(
            tags.title, "手改的标题",
            "文件里也得改了，不然 Rekordbox 那边看不到"
        );
        assert_eq!(tags.year, "2019");

        let after = stored_mtime(&service, &path);
        assert!(after > before, "写标签一定会改 mtime：{before} → {after}");
        assert!(
            (after - disk_mtime(&path)).abs() < 1e-6,
            "库里记的 mtime 必须等于磁盘上的现状，否则下次扫描会重读标签"
        );
        // size 也要跟上：增量跳过是 mtime + size 一起判的
        assert_eq!(
            service.get(id).unwrap().unwrap().size,
            std::fs::metadata(&path).unwrap().len() as i64
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_rescan_after_writing_tags_does_not_re_read_and_overwrite() {
        let (service, id, path) = scratch_track("rescan");
        let patch = TrackPatch {
            title: Some("手改的标题".into()),
            // 艺人必须非空：夹具默认艺人+专辑双空，那会命中"可疑行自动重读"
            // 的例外（见 file_index），照妖镜就照错了对象——这条测试要照的是
            // "一条**正常**记录在 mtime 同步后走不走增量跳过"
            artist: Some("正常的艺人".into()),
            ..Default::default()
        };
        service.patch(id, &patch).unwrap();
        service.write_patch_to_file(id, &patch).unwrap();

        // 埋一个只存在于库里的哨兵：`upsert_file` 走重读那条路时会拿文件里的
        // 标题把它盖掉，走增量跳过则原样留着。这就是 mtime 有没有同步的照妖镜。
        let conn = service.db().conn().unwrap();
        conn.execute("UPDATE tracks SET title = '库里的哨兵' WHERE id = ?", [id])
            .unwrap();
        drop(conn);

        assert_eq!(service.upsert_file(&path, "local", "").unwrap(), id);
        assert_eq!(
            service.get(id).unwrap().unwrap().title,
            "库里的哨兵",
            "mtime 同步过了就该走增量跳过，不该重读标签"
        );

        // 反证：把 mtime 拨回同步之前，同一次扫描就会把哨兵冲掉——
        // 说明上面那条断言不是碰巧成立的
        let conn = service.db().conn().unwrap();
        conn.execute("UPDATE tracks SET file_mtime = 1.0 WHERE id = ?", [id])
            .unwrap();
        drop(conn);
        service.upsert_file(&path, "local", "").unwrap();
        assert_eq!(service.get(id).unwrap().unwrap().title, "手改的标题");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_stale_empty_row_heals_itself_on_the_next_scan() {
        // 复现库里那 7 首 mp3：文件里有艺人/专辑，库里是空的，而 mtime 对得上。
        // 老行为是每次扫描都跳过、空值永远翻不了身；现在"艺人+专辑双空"
        // 不许走增量快路径，普通的一次 upsert 就能把它治好。
        let (service, id, path) = scratch_track("self-heal");
        kdj_providers::tags::write_metadata(
            &path,
            &MetadataEdit {
                artist: Some("文件里的艺人"),
                album: Some("文件里的专辑"),
                ..Default::default()
            },
        )
        .unwrap();
        service.sync_file_stat(id).unwrap();
        let conn = service.db().conn().unwrap();
        conn.execute(
            "UPDATE tracks SET artist = '', album = '' WHERE id = ?",
            [id],
        )
        .unwrap();
        drop(conn);

        // file_index 必须把这行标成可疑，扫描才知道别跳它。库里只有这一条。
        let index = service.file_index().unwrap();
        assert_eq!(index.len(), 1);
        let (_, _, suspect) = *index.values().next().unwrap();
        assert!(suspect, "艺人+专辑双空的行要被标成可疑");

        // 文件没动过（mtime/size 全对得上），一次普通 upsert 也要能治好
        service.upsert_file(&path, "local", "").unwrap();
        let track = service.get(id).unwrap().unwrap();
        assert_eq!(track.artist, "文件里的艺人");
        assert_eq!(track.album, "文件里的专辑");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rereading_tags_fixes_wrong_values_the_scan_cannot_see() {
        // 自动愈合只认"空"。库里存了**错但非空**的值（别的软件写坏的）
        // 增量扫描分不出来，这时才需要用户显式点「重读标签」。
        let (service, id, path) = scratch_track("reread");
        kdj_providers::tags::write_metadata(
            &path,
            &MetadataEdit {
                artist: Some("文件里的艺人"),
                album: Some("文件里的专辑"),
                ..Default::default()
            },
        )
        .unwrap();
        service.sync_file_stat(id).unwrap();
        let conn = service.db().conn().unwrap();
        conn.execute(
            "UPDATE tracks SET artist = '写错的艺人', album = '写错的专辑' WHERE id = ?",
            [id],
        )
        .unwrap();
        drop(conn);

        // 前提确认：非空的错值，扫一遍治不好（mtime 没变，跳过是对的）
        service.upsert_file(&path, "local", "").unwrap();
        assert_eq!(service.get(id).unwrap().unwrap().artist, "写错的艺人");

        let track = service.reread_tags_from_file(id).unwrap();
        assert_eq!(track.artist, "文件里的艺人");
        assert_eq!(track.album, "文件里的专辑");
        // 重读完 mtime 必须落回磁盘上的现状，不然下一次扫描又要白读一遍
        assert!((stored_mtime(&service, &path) - disk_mtime(&path)).abs() < 1e-6);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rereading_tags_of_a_missing_file_fails_before_touching_the_record() {
        let (service, id, path) = scratch_track("reread-gone");
        std::fs::remove_file(&path).unwrap();
        let before = stored_mtime(&service, &path);
        assert!(service.reread_tags_from_file(id).is_err());
        // 文件读不到时不能把 file_mtime 清零留在库里：那会让下次扫描
        // 对一个根本不存在的文件反复重试
        assert!((stored_mtime(&service, &path) - before).abs() < 1e-6);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn changing_the_cover_also_syncs_the_stored_mtime_and_cache_version() {
        let (service, id, path) = scratch_track("cover");
        service
            .db()
            .conn()
            .unwrap()
            .execute(
                "UPDATE tracks SET modified_at = ? WHERE id = ?",
                rusqlite::params!["2000-01-01T00:00:00Z", id],
            )
            .unwrap();
        let before_modified = service.get(id).unwrap().unwrap().modified_at;
        let before = stored_mtime(&service, &path);

        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        png.extend_from_slice(&[
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
        ]);
        png.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]);
        service.write_cover_to_file(id, &png).unwrap();

        assert_eq!(
            kdj_providers::tags::read_cover(&path).unwrap().0,
            png,
            "换完封面立刻就该能读回新图"
        );
        let after = stored_mtime(&service, &path);
        assert!(after > before && (after - disk_mtime(&path)).abs() < 1e-6);
        let after_modified = service.get(id).unwrap().unwrap().modified_at;
        assert_ne!(
            after_modified, before_modified,
            "换封面要让列表缩略图 URL 失效"
        );

        // 认不出格式的图要挡在写之前；此时文件没动过，mtime 和缓存版本也不该变
        let steady = stored_mtime(&service, &path);
        let steady_modified = service.get(id).unwrap().unwrap().modified_at;
        assert!(service.write_cover_to_file(id, b"GIF89a").is_err());
        assert!((stored_mtime(&service, &path) - steady).abs() < 1e-6);
        assert_eq!(
            service.get(id).unwrap().unwrap().modified_at,
            steady_modified
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_patch_without_file_backed_fields_never_touches_the_file() {
        // 打个星、写句备注就重写一遍音频文件的话，每次都要连带重算波形缓存，
        // 而且 mtime 一变，别的 DJ 软件也会跟着重扫
        let (service, id, path) = scratch_track("untouched");
        let before = disk_mtime(&path);
        let patch = TrackPatch {
            rating: Some(4),
            comment: Some("备注".into()),
            tags: Some(vec!["house".into()]),
            ..Default::default()
        };
        service.patch(id, &patch).unwrap();
        service.write_patch_to_file(id, &patch).unwrap();
        assert!((disk_mtime(&path) - before).abs() < 1e-6);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn pending_analysis_keeps_the_callers_order_and_skips_analyzed() {
        let service = service();
        let a = insert(
            &service,
            Row {
                path: "/lib/a.mp3",
                ..Default::default()
            },
        );
        let b = insert(
            &service,
            Row {
                path: "/lib/b.mp3",
                analyzed: true,
                ..Default::default()
            },
        );
        let c = insert(
            &service,
            Row {
                path: "/lib/c.mp3",
                ..Default::default()
            },
        );

        // 前端选中的顺序 = 用户期望的分析顺序；重复的 id 只算一次
        let pending = service
            .pending_analysis_ids(Some(&[c, a, b, c]), false)
            .unwrap();
        assert_eq!(pending, vec![c, a], "已分析的被挡在外面");

        let forced = service
            .pending_analysis_ids(Some(&[c, a, b]), true)
            .unwrap();
        assert_eq!(forced, vec![c, a, b], "force 时不看 analyzed_at");

        let all = service.pending_analysis_ids(None, false).unwrap();
        assert_eq!(all, vec![a, c], "不传 id 时按 id 排");
        assert!(service
            .pending_analysis_ids(Some(&[]), false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn bpm_key_v2_backfill_is_versioned_preferred_and_retires_matching_v1_fields() {
        let service = service();
        let a = insert(
            &service,
            Row {
                path: "/lib/v2-a.mp3",
                camelot: "8A",
                bpm: Some(120.0),
                analyzed: true,
                ..Default::default()
            },
        );
        let b = insert(
            &service,
            Row {
                path: "/lib/focus/v2-b.mp3",
                camelot: "8A",
                bpm: Some(121.0),
                analyzed: true,
                ..Default::default()
            },
        );
        let conn = service.db().conn().unwrap();
        conn.execute(
            "UPDATE tracks SET music_key = 'A minor', energy = 7 WHERE id IN (?, ?)",
            rusqlite::params![a, b],
        )
        .unwrap();
        drop(conn);

        assert_eq!(
            service
                .pending_bpm_key_analysis_v2_ids(None, false, Some(1), None)
                .unwrap(),
            vec![b],
            "全库回填应限量并优先最近加入的曲目"
        );
        assert_eq!(
            service
                .pending_bpm_key_analysis_v2_ids(None, false, Some(20), Some("/lib/focus"))
                .unwrap(),
            vec![b],
            "打开文件夹时应先只挑该目录子树里的 v2 待处理项"
        );

        let result = AnalysisResult {
            bpm: Some(126.25),
            bpm_raw: Some(126.247),
            bpm_confidence: Some(0.91),
            first_beat: Some(0.125),
            beat_times: vec![0.125, 0.6004],
            key: "E minor".into(),
            key_short: "Em".into(),
            camelot: "9A".into(),
            open_key: "4m".into(),
            key_confidence: Some(0.88),
            chroma: vec![0.1, 0.2, 0.3],
            ..Default::default()
        };
        service.save_bpm_key_analysis_v2(b, &result).unwrap();

        let conn = service.db().conn().unwrap();
        let raw_v1: (Option<f64>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT bpm, music_key, energy FROM tracks WHERE id = ?",
                [b],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            raw_v1,
            (None, None, Some(7)),
            "只退役旧 BPM/Key，不删响度能量"
        );
        let stored: (String, String, String) = conn
            .query_row(
                "SELECT analyzer_revision, beat_times_json, chroma_json
                 FROM track_bpm_key_analysis_v2 WHERE track_id = ?",
                [b],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored.0, BPM_KEY_V2_REVISION);
        assert_eq!(stored.1, "[0.125,0.6004]");
        assert_eq!(stored.2, "[0.1,0.2,0.3]");
        drop(conn);

        let effective = service.get(b).unwrap().unwrap();
        assert_eq!(effective.bpm, Some(126.25));
        assert!(effective.bpm_v2, "当前修订的 V2 BPM 覆盖后要显式标记来源");
        assert_eq!(effective.music_key, "E minor");
        assert_eq!(effective.camelot, "9A");
        assert_eq!(effective.energy, Some(7));

        let filtered = service
            .list_tracks(&TrackQuery {
                key: "9A".into(),
                bpm_min: Some(126.0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            filtered
                .items
                .iter()
                .map(|track| track.id)
                .collect::<Vec<_>>(),
            vec![b]
        );

        let stats = service.stats().unwrap();
        assert_eq!(stats.bpm_key_v2_analyzed, 1);
        assert_eq!(stats.bpm_key_v2_pending, 1);
        assert_eq!(stats.bpm_key_v2_revision, BPM_KEY_V2_REVISION);
        assert_eq!(stats.by_camelot.get("9A"), Some(&1));
        assert_eq!(stats.by_bpm_bucket.get("120-129"), Some(&2));
        assert_eq!(
            service
                .pending_bpm_key_analysis_v2_ids(Some(&[b, a, b]), false, None, None)
                .unwrap(),
            vec![a],
            "当前修订已经完成的曲目不能重复排队"
        );

        service
            .db()
            .conn()
            .unwrap()
            .execute(
                "UPDATE track_bpm_key_analysis_v2 SET analyzer_revision = 'old' WHERE track_id = ?",
                [b],
            )
            .unwrap();
        assert_eq!(
            service
                .pending_bpm_key_analysis_v2_ids(Some(&[a, b]), false, None, None)
                .unwrap(),
            vec![a, b],
            "算法修订变化后旧 v2 行必须重新进入回填"
        );
    }

    #[test]
    fn empty_v2_result_marks_completion_but_keeps_v1_fallback() {
        let service = service();
        let id = insert(
            &service,
            Row {
                path: "/lib/v2-error.mp3",
                camelot: "7B",
                bpm: Some(110.0),
                analyzed: true,
                ..Default::default()
            },
        );
        service
            .save_bpm_key_analysis_v2(
                id,
                &AnalysisResult {
                    errors: vec!["decode: broken".into()],
                    ..Default::default()
                },
            )
            .unwrap();

        let track = service.get(id).unwrap().unwrap();
        assert_eq!(track.bpm, Some(110.0));
        assert_eq!(track.camelot, "7B");
        assert!(service
            .pending_bpm_key_analysis_v2_ids(Some(&[id]), false, None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn waveform_readiness_tracks_profile_revision_mtime_and_errors() {
        let service = service();
        let id = insert(
            &service,
            Row {
                path: "/lib/ready.mp3",
                analyzed: true,
                ..Default::default()
            },
        );
        assert_eq!(service.waveform_candidates("v2-640", 2).unwrap().len(), 1);

        service
            .record_waveform_asset(id, "v2-640", 2, 123, None)
            .unwrap();
        assert!(service.waveform_candidates("v2-640", 2).unwrap().is_empty());
        assert_eq!(service.waveform_candidates("v3-640", 3).unwrap().len(), 1);

        service
            .db()
            .conn()
            .unwrap()
            .execute("UPDATE tracks SET file_mtime = 124 WHERE id = ?", [id])
            .unwrap();
        assert_eq!(service.waveform_candidates("v2-640", 2).unwrap().len(), 1);
        service
            .record_waveform_asset(id, "v2-640", 2, 124, Some("decode failed"))
            .unwrap();
        assert_eq!(service.waveform_candidates("v2-640", 2).unwrap().len(), 1);
        service
            .record_waveform_asset(id, "v2-640", 2, 124, None)
            .unwrap();
        assert!(service.waveform_candidates("v2-640", 2).unwrap().is_empty());

        service
            .db()
            .conn()
            .unwrap()
            .execute("DELETE FROM tracks WHERE id = ?", [id])
            .unwrap();
        let assets: i64 = service
            .db()
            .conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM waveform_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(assets, 0, "删曲目时不能留下假的 ready 状态");
    }

    #[test]
    fn harmonic_limit_zero_falls_back_to_the_default_instead_of_one() {
        let service = service();
        let source = insert(
            &service,
            Row {
                path: "/lib/src.mp3",
                camelot: "8A",
                bpm: Some(128.0),
                ..Default::default()
            },
        );
        for index in 0..3 {
            insert(
                &service,
                Row {
                    path: &format!("/lib/m{index}.mp3"),
                    title: &format!("m{index}"),
                    camelot: "8A",
                    bpm: Some(128.0),
                    analyzed: true,
                },
            );
        }
        let matches = service.harmonic_matches(source, 6.0, 0, true, "").unwrap();
        assert_eq!(matches.len(), 3, "limit=0 当没传，不该只给一首");
        assert!(matches.iter().all(|m| m.relation == HarmonicRelation::Same));
        assert_eq!(
            service
                .harmonic_matches(source, 6.0, 2, true, "")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn harmonic_drops_duplicates_and_candidates_without_a_bpm() {
        let service = service();
        let source = insert(
            &service,
            Row {
                path: "/lib/src.mp3",
                title: "src",
                camelot: "8A",
                bpm: Some(128.0),
                ..Default::default()
            },
        );
        // 同一首歌在两个 set 里各一份复制文件，推荐列表里只该出现一次
        insert(
            &service,
            Row {
                path: "/lib/set1/x.mp3",
                title: "EMOTION",
                camelot: "9A",
                bpm: Some(128.0),
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: "/lib/set2/x.mp3",
                title: "EMOTION",
                camelot: "9A",
                bpm: Some(128.0),
                ..Default::default()
            },
        );
        // 本曲有 BPM、候选没有：对不上拍，排除
        insert(
            &service,
            Row {
                path: "/lib/nobpm.mp3",
                title: "nobpm",
                camelot: "8A",
                ..Default::default()
            },
        );
        // 调号不兼容
        insert(
            &service,
            Row {
                path: "/lib/far.mp3",
                title: "far",
                camelot: "3B",
                bpm: Some(128.0),
                ..Default::default()
            },
        );

        let matches = service
            .harmonic_matches(source, 6.0, 50, false, "")
            .unwrap();
        let titles: Vec<&str> = matches.iter().map(|m| m.track.title.as_str()).collect();
        assert_eq!(titles, vec!["EMOTION"]);
        assert_eq!(matches[0].relation, HarmonicRelation::EnergyUp);

        // 半速也算能接：64 BPM 折算成 128
        insert(
            &service,
            Row {
                path: "/lib/half.mp3",
                title: "half",
                camelot: "8A",
                bpm: Some(64.0),
                ..Default::default()
            },
        );
        let matches = service
            .harmonic_matches(source, 6.0, 50, false, "")
            .unwrap();
        let half = matches.iter().find(|m| m.track.title == "half").unwrap();
        assert_eq!(half.tempo_ratio, 2.0);
        assert_eq!(half.bpm_delta, 0.0);
        // 同调同速排在倍速前面
        assert!(matches[0].track.title == "EMOTION" || matches[0].track.title == "half");
    }

    #[test]
    fn stats_group_by_wheel_and_bucket_order() {
        let service = service();
        let analyzed_id = insert(
            &service,
            Row {
                path: "/lib/a.mp3",
                camelot: "10a",
                bpm: Some(128.0),
                analyzed: true,
                ..Default::default()
            },
        );
        insert(
            &service,
            Row {
                path: "/lib/b.mp3",
                camelot: "8A",
                bpm: Some(60.0),
                ..Default::default()
            },
        );

        service
            .db()
            .conn()
            .unwrap()
            .execute(
                "UPDATE tracks SET energy = 6, rms_db = -12.0, peak_db = -1.0 WHERE id = ?",
                [analyzed_id],
            )
            .unwrap();
        let stats = service.stats().unwrap();
        assert_eq!(stats.total, 2);
        assert_eq!(stats.analyzed, 1);
        assert_eq!(stats.by_camelot.get("10A"), Some(&1), "小写也归到同一格");
        assert_eq!(stats.by_camelot.get("8A"), Some(&1));
        assert_eq!(stats.by_bpm_bucket.get("120-129"), Some(&1));
        assert_eq!(stats.by_bpm_bucket.get("<90"), Some(&1));
        assert_eq!(stats.by_platform.get("local"), Some(&2), "空来源算 local");
        assert_eq!(stats.energy_median, Some(6.0));
        assert_eq!(stats.rms_db_median, Some(-12.0));
        assert_eq!(stats.peak_db_median, Some(-1.0));
    }

    #[test]
    fn rebase_replaces_only_the_prefix() {
        // SQL 的 replace 会替换每一处匹配，`/lib/set1/set1/a.mp3` 就会被改坏
        let service = service();
        let id = insert(
            &service,
            Row {
                path: &format!("{ROOT}{SEP}set1{SEP}set1{SEP}a.mp3"),
                ..Default::default()
            },
        );
        let old = format!("{ROOT}{SEP}set1");
        let new = format!("{ROOT}{SEP}set2");
        let moved = service
            .rebase_paths(Path::new(&old), Path::new(&new))
            .unwrap();
        assert_eq!(moved, vec![id]);
        assert_eq!(
            service.get(id).unwrap().unwrap().path,
            format!("{ROOT}{SEP}set2{SEP}set1{SEP}a.mp3")
        );
    }
}
