//! LibraryService：曲库的查询 / 过滤 / 入库 / 和声推荐 / 统计。
//!
//! 所有 SQL 都收在这一层，上面的 server 只跟契约模型打交道。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kumodeck_analysis::engine::AnalysisResult;
use kumodeck_core::models::{
    HarmonicMatch, HarmonicRelation, LibraryStats, Track, TrackPage, TrackPatch,
};
use kumodeck_providers::tags::read_tags;
use rusqlite::types::Value as SqlValue;
use rusqlite::Row;

use crate::camelot::{
    best_tempo, bpm_bucket, camelot_relations, parse_key_filter, relation_distance, relation_label,
    BPM_BUCKET_ORDER, CAMELOT_TO_KEY,
};
use crate::db::{Conn, Database};

/// 平台路径分隔符。曲库过滤按前缀匹配要用。
const SEP: char = std::path::MAIN_SEPARATOR;

/// sort 白名单：绝对不能把 query string 直接拼进 ORDER BY（SQL 注入），
/// 也不能只做转义——SQLite 的标识符引用规则太松，白名单映射是唯一安全的做法。
fn sort_column(key: &str) -> &'static str {
    match key {
        "modified_at" => "modified_at",
        "analyzed_at" => "analyzed_at",
        "title" => "title",
        "artist" => "artist",
        "album" => "album",
        "genre" => "genre",
        "year" => "year",
        "filename" => "filename",
        "duration" => "duration",
        "bpm" => "bpm",
        "energy" => "energy",
        "rating" => "rating",
        "size" => "size",
        // Camelot 直接按字符串排会得到 "10A" < "8A"，必须拆成 数字*2 + 字母
        "camelot" | "key" => {
            "(CASE WHEN camelot IS NULL OR camelot = '' THEN NULL ELSE \
             CAST(SUBSTR(camelot, 1, LENGTH(camelot) - 1) AS INTEGER) * 2 \
             + (CASE WHEN UPPER(SUBSTR(camelot, -1)) = 'B' THEN 1 ELSE 0 END) END)"
        }
        _ => "added_at",
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
    let expanded = kumodeck_core::config::expand_user(&path.to_string_lossy());
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(expanded)
    };
    kumodeck_core::paths::normalize_path(&absolute)
        .to_string_lossy()
        .into_owned()
}

pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
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
    pub sort: String,
    pub order: String,
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
        if !folder.is_empty() {
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
            where_parts.push("UPPER(COALESCE(camelot, '')) = ?".into());
            params.push(SqlValue::Text(camelot));
        } else if !raw_key.is_empty() {
            where_parts.push("LOWER(COALESCE(music_key, '')) LIKE ? ESCAPE '\\'".into());
            params.push(SqlValue::Text(like_contains(&raw_key)));
        }

        if let Some(bpm_min) = query.bpm_min {
            where_parts.push("bpm IS NOT NULL AND bpm >= ?".into());
            params.push(SqlValue::Real(bpm_min));
        }
        if let Some(bpm_max) = query.bpm_max {
            where_parts.push("bpm IS NOT NULL AND bpm <= ?".into());
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
        let limit = query.limit.clamp(1, 2000);
        let offset = query.offset.max(0);

        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM tracks{clause}"),
            rusqlite::params_from_iter(params.iter()),
            |row| row.get(0),
        )?;

        let sort_key = query.sort.trim().to_lowercase();
        let folder = query.folder.trim().trim_end_matches('/');

        // 手排模式：顺序在这个文件夹自己的 .kumodeck.json 里（文件名列表）。
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
                items: self.attach_tags(&conn, page)?,
                total,
                offset,
                limit,
            });
        }

        let column = sort_column(&sort_key);
        let direction = if query.order.trim().eq_ignore_ascii_case("asc") {
            "ASC"
        } else {
            "DESC"
        };
        // `<col> IS NULL` 放第一排序键 = 空值永远垫底（升序降序都一样），
        // 再拿 id 兜底保证分页稳定不重复
        let sql = format!(
            "SELECT * FROM tracks{clause} ORDER BY ({column}) IS NULL, ({column}) {direction}, \
             id DESC LIMIT ? OFFSET ?"
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
            items: self.attach_tags(&conn, rows)?,
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
        Ok(self.attach_tags(&conn, vec![track])?.into_iter().next())
    }

    pub fn get_by_path(&self, path: &Path) -> Result<Option<Track>> {
        let conn = self.db.conn()?;
        let key = normalize_path(path);
        let mut stmt = conn.prepare("SELECT * FROM tracks WHERE path = ?")?;
        let mut rows = stmt.query_map([key], |row| Ok(row_to_track(row)))?;
        let Some(track) = rows.next().transpose()? else {
            return Ok(None);
        };
        Ok(self.attach_tags(&conn, vec![track])?.into_iter().next())
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

        self.get(track_id)?.context("刚更新的曲目查不到了")
    }

    pub fn delete(&self, track_id: i64, delete_file: bool) -> Result<bool> {
        let conn = self.db.conn()?;
        let path: Option<String> = conn
            .query_row("SELECT path FROM tracks WHERE id = ?", [track_id], |row| {
                row.get(0)
            })
            .ok();
        let Some(path) = path else {
            return Ok(false);
        };
        conn.execute("DELETE FROM tracks WHERE id = ?", [track_id])?;
        conn.execute("DELETE FROM tags WHERE track_id = ?", [track_id])?;
        conn.execute("DELETE FROM playlist_items WHERE track_id = ?", [track_id])?;
        if delete_file {
            // 文件删不掉（权限/已被移走）不该让接口失败，记录已从库里移除即可
            let _ = std::fs::remove_file(&path);
        }
        Ok(true)
    }

    /// 把一个音频文件写进库，返回 track id。同一路径重复调用是幂等的。
    pub fn upsert_file(
        &self,
        path: &Path,
        source_platform: &str,
        source_key: &str,
    ) -> Result<i64> {
        let key_path = normalize_path(path);
        let file_path = PathBuf::from(&key_path);
        let meta = std::fs::metadata(&file_path)
            .with_context(|| format!("无法读取文件: {key_path}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let size = meta.len() as i64;

        let conn = self.db.conn()?;
        let existing: Option<(i64, Option<f64>, i64, String, String)> = conn
            .query_row(
                "SELECT id, file_mtime, COALESCE(size, 0), COALESCE(source_platform, ''), \
                 COALESCE(source_key, '') FROM tracks WHERE path = ?",
                [&key_path],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .ok();

        if let Some((id, old_mtime, old_size, old_platform, old_key)) = &existing {
            // 增量：mtime + size 都没变就直接返回，省掉读标签（扫描里最贵的一步）
            let unchanged = old_mtime
                .map(|value| (value - mtime).abs() < 1e-6)
                .unwrap_or(false)
                && *old_size == size;
            if unchanged {
                // 唯一例外：来源信息是调用方带进来的（下载完成时补登记），
                // 文件没变也要认，否则重复下载的曲目会一直挂着 local
                self.touch_source(&conn, *id, old_platform, old_key, source_platform, source_key)?;
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
                    if source_platform.is_empty() { "local" } else { source_platform },
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

    /// 返回需要分析的 track id。
    ///
    /// **默认只挑 `analyzed_at IS NULL` 的**——这条是硬约束：Rust 版和 Python 版的
    /// BPM 在约 10% 的曲子上会选到不同的倍数，重算就会把用户已有的和声推荐打乱。
    /// 只有用户显式点「强制重新分析」（force=true）才覆盖。
    pub fn pending_analysis_ids(&self, track_ids: Option<&[i64]>, force: bool) -> Result<Vec<i64>> {
        let conn = self.db.conn()?;
        let condition = if force { "" } else { " WHERE analyzed_at IS NULL" };

        let Some(wanted) = track_ids else {
            let mut stmt = conn.prepare(&format!("SELECT id FROM tracks{condition} ORDER BY id"))?;
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
            let extra = if force { "" } else { " AND analyzed_at IS NULL" };
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

    // ------------------------------------------------------------ 和声推荐

    /// Camelot 兼容 + BPM 接近的候选，score 越大越靠前。
    ///
    /// 默认走 wide：宁可多列几首让人自己挑，也不要因为规则太紧而空手。
    /// 排序把稳妥的选项放前面，所以"更多"不会变成"更差"。
    pub fn harmonic_matches(
        &self,
        track_id: i64,
        bpm_tolerance: f64,
        limit: usize,
        wide: bool,
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
        let tolerance = if bpm_tolerance > 0.0 { bpm_tolerance } else { 6.0 };
        let limit = limit.clamp(1, 500);

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
            let ranges = [(low, high), (low * 2.0, high * 2.0), (low / 2.0, high / 2.0)];
            bpm_clause = format!(
                " AND ({})",
                vec!["bpm BETWEEN ? AND ?"; ranges.len()].join(" OR ")
            );
            for (lo, hi) in ranges {
                params.push(SqlValue::Real(lo));
                params.push(SqlValue::Real(hi));
            }
        }

        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM tracks WHERE UPPER(COALESCE(camelot, '')) IN ({placeholders}) \
             AND id != ?{bpm_clause}"
        ))?;
        let candidates: Vec<Track> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(row_to_track(row))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let candidates = self.attach_tags(&conn, candidates)?;

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
                .then_with(|| a.track.title.to_lowercase().cmp(&b.track.title.to_lowercase()))
        });

        // 同一首歌常常在好几个 set 文件夹里各有一份（硬链接/拷贝），
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
        let (total, analyzed, total_duration, total_size): (i64, i64, f64, i64) = conn.query_row(
            "SELECT COUNT(*), SUM(CASE WHEN analyzed_at IS NOT NULL THEN 1 ELSE 0 END), \
             COALESCE(SUM(duration), 0), COALESCE(SUM(size), 0) FROM tracks",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get(2)?,
                    row.get(3)?,
                ))
            },
        )?;

        let mut raw_camelot: HashMap<String, i64> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT UPPER(camelot), COUNT(*) FROM tracks \
                 WHERE camelot IS NOT NULL AND camelot != '' GROUP BY UPPER(camelot)",
            )?;
            for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
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
            let mut stmt =
                conn.prepare("SELECT bpm FROM tracks WHERE bpm IS NOT NULL AND bpm > 0")?;
            for row in stmt.query_map([], |row| row.get::<_, f64>(0))? {
                *buckets.entry(bpm_bucket(row?)).or_insert(0) += 1;
            }
        }
        let by_bpm_bucket: BTreeMap<String, i64> = BPM_BUCKET_ORDER
            .iter()
            .filter_map(|name| buckets.get(*name).map(|count| ((*name).to_string(), *count)))
            .collect();

        let mut by_platform: BTreeMap<String, i64> = BTreeMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT COALESCE(NULLIF(source_platform, ''), 'local'), COUNT(*) \
                 FROM tracks GROUP BY 1",
            )?;
            for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
                let (platform, count) = row?;
                by_platform.insert(platform, count);
            }
        }

        Ok(LibraryStats {
            total,
            analyzed,
            total_duration,
            total_size,
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

    /// 把分析结果和人工标记复制到链接出来的那一份上。
    ///
    /// 链接的两端是同一份音频，重新分析必然得到同样的 BPM / 调号，
    /// 让用户为了一个链接再等一次分析没有道理。评分和备注一并带过去，
    /// 因为在 DJ 眼里那就是"同一首歌"。
    pub fn clone_metadata(&self, source_id: i64, target_id: i64) -> Result<()> {
        const COLUMNS: &str = "title, artist, album, genre, year, duration, bitrate, \
             samplerate, channels, format, bpm, bpm_confidence, first_beat, music_key, camelot, \
             open_key, key_confidence, energy, rms_db, peak_db, rating, color, comment, cue_ms, \
             source_platform, source_key, analyzed_at, analysis_error";
        let assignments: Vec<String> = COLUMNS
            .split(',')
            .map(|name| format!("{} = ?", name.trim()))
            .collect();

        let conn = self.db.conn()?;
        let values: Vec<SqlValue> = {
            let mut stmt =
                conn.prepare(&format!("SELECT {COLUMNS} FROM tracks WHERE id = ?"))?;
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
        conn.execute("DELETE FROM tags WHERE track_id = ?", [target_id])?;
        conn.execute(
            "INSERT OR IGNORE INTO tags (track_id, tag) SELECT ?, tag FROM tags WHERE track_id = ?",
            rusqlite::params![target_id, source_id],
        )?;
        Ok(())
    }

    /// path → (id, file_mtime)。扫描前一次性拉出来做增量比对，
    /// 比每个文件查一次库快一个数量级。
    pub fn file_index(&self) -> Result<HashMap<String, (i64, f64)>> {
        let conn = self.db.conn()?;
        let mut stmt = conn.prepare("SELECT id, path, file_mtime FROM tracks")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                (row.get::<_, i64>(0)?, row.get::<_, Option<f64>>(2)?.unwrap_or(0.0)),
            ))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

// ---------------------------------------------------------------- 行映射

fn text(row: &Row, name: &str) -> String {
    row.get::<_, Option<String>>(name).ok().flatten().unwrap_or_default()
}

fn row_to_track(row: &Row) -> Track {
    let path = text(row, "path");
    Track {
        id: row.get("id").unwrap_or(0),
        folder: Path::new(&path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default(),
        link: crate::folders::link_state(Path::new(&path)),
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
        size: row.get::<_, Option<i64>>("size").ok().flatten().unwrap_or(0),
        bpm: row.get("bpm").ok().flatten(),
        bpm_confidence: row.get("bpm_confidence").ok().flatten(),
        first_beat: row.get("first_beat").ok().flatten(),
        music_key: text(row, "music_key"),
        camelot: text(row, "camelot").to_uppercase(),
        open_key: text(row, "open_key"),
        key_confidence: row.get("key_confidence").ok().flatten(),
        energy: row.get("energy").ok().flatten(),
        rms_db: row.get("rms_db").ok().flatten(),
        peak_db: row.get("peak_db").ok().flatten(),
        rating: row.get::<_, Option<i64>>("rating").ok().flatten().unwrap_or(0),
        color: text(row, "color"),
        comment: text(row, "comment"),
        cue_ms: row.get("cue_ms").ok().flatten(),
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
