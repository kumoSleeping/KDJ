use crate::LibraryService;
use anyhow::{Context, Result};
use kdj_analysis::rhythm::{RhythmAnalysis, REVISION};
use rusqlite::{params, OptionalExtension};
use std::path::Path;
pub fn signature(path: &Path) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    Ok(format!(
        "{}:{}",
        meta.len(),
        meta.modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ))
}
impl LibraryService {
    pub fn rhythm(&self, id: i64) -> Result<Option<RhythmAnalysis>> {
        let conn = self.db().conn()?;
        let row: Option<(String, String, String)> = conn.query_row(
            "SELECT r.signature, r.result_json, t.path FROM track_rhythm_v4 r JOIN tracks t ON t.id=r.track_id WHERE r.track_id=? AND r.revision=?",
            params![id, REVISION], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((sig, json, path)) = row else {
            return Ok(None);
        };
        if signature(Path::new(&path)).ok().as_ref() != Some(&sig) {
            return Ok(None);
        }
        Ok(Some(serde_json::from_str(&json)?))
    }
    pub fn save_rhythm(
        &self,
        id: i64,
        expected_signature: &str,
        result: &RhythmAnalysis,
    ) -> Result<()> {
        let mut conn = self.db().conn()?;
        let tx = conn.transaction()?;
        let path: String =
            tx.query_row("SELECT path FROM tracks WHERE id=?", [id], |r| r.get(0))?;
        anyhow::ensure!(
            signature(Path::new(&path))? == expected_signature,
            "分析期间素材发生变化"
        );
        tx.execute("INSERT INTO track_rhythm_v4(track_id,revision,signature,precise,bpm,confidence,file_mtime,result_json)
            SELECT id,?2,?3,?4,?5,?6,file_mtime,?7 FROM tracks WHERE id=?1
            ON CONFLICT(track_id) DO UPDATE SET revision=excluded.revision,signature=excluded.signature,
            precise=excluded.precise,bpm=excluded.bpm,confidence=excluded.confidence,file_mtime=excluded.file_mtime,result_json=excluded.result_json",
            params![id,REVISION,expected_signature,result.precise,result.bpm,result.confidence,serde_json::to_string(result)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn pending_rhythm_ids(
        &self,
        ids: Option<&[i64]>,
        force: bool,
        limit: Option<usize>,
        folder: &str,
    ) -> Result<Vec<i64>> {
        let conn = self.db().conn()?;
        let mut stmt = conn.prepare("SELECT t.id,t.path,r.revision,r.file_mtime,t.file_mtime FROM tracks t LEFT JOIN track_rhythm_v4 r ON r.track_id=t.id ORDER BY t.id")?;
        let mut found = Vec::new();
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<f64>>(3)?,
                r.get::<_, Option<f64>>(4)?,
            ))
        })? {
            let (id, path, rev, old, new) = row?;
            if ids.is_some_and(|ids| !ids.contains(&id))
                || (!folder.is_empty() && !Path::new(&path).starts_with(folder))
            {
                continue;
            }
            if kdj_providers::workshop_images::is_image_path(Path::new(&path)) {
                continue;
            }
            if force || rev.as_deref() != Some(REVISION) || old != new {
                found.push(id);
            }
            if ids.is_none() && limit.is_some_and(|limit| found.len() >= limit.max(1)) {
                break;
            }
        }
        Ok(found)
    }
    pub(crate) fn overlay_rhythm(
        &self,
        conn: &crate::db::Conn,
        tracks: &mut [kdj_core::models::Track],
    ) -> Result<()> {
        for chunk in tracks.chunks_mut(900) {
            let ids: Vec<_> = chunk.iter().map(|t| t.id).collect();
            let sql=format!("SELECT track_id,result_json FROM track_rhythm_v4 WHERE revision=?1 AND file_mtime IS (SELECT file_mtime FROM tracks WHERE tracks.id=track_rhythm_v4.track_id) AND track_id IN ({})",vec!["?";ids.len()].join(","));
            let mut args = vec![rusqlite::types::Value::Text(REVISION.into())];
            args.extend(ids.iter().map(|&id| rusqlite::types::Value::Integer(id)));
            let mut stmt = conn.prepare(&sql)?;
            for row in stmt.query_map(rusqlite::params_from_iter(args), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })? {
                let (id, json) = row?;
                let r: RhythmAnalysis = serde_json::from_str(&json).context("读取 V4 节奏")?;
                if let Some(t) = chunk.iter_mut().find(|t| t.id == id) {
                    t.bpm = r.bpm.or(t.bpm);
                    t.bpm_confidence = Some(r.confidence);
                    t.bpm_v2 = false;
                    t.bpm_v3 = false;
                    t.beat_times = r.beats;
                    t.downbeats = r.downbeats;
                    t.downbeat_confidence = Some(r.downbeat_confidence);
                    let constant = r.segments.len() == 1;
                    t.first_beat = if constant {
                        t.downbeats.first().or(t.beat_times.first()).copied()
                    } else {
                        None
                    };
                    t.beat_origin = if constant {
                        t.beat_times.first().copied()
                    } else {
                        None
                    };
                    t.downbeat_origin = if constant {
                        t.downbeats.first().copied()
                    } else {
                        None
                    };
                    t.beat_grid_revision = REVISION.into();
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v4_roundtrip_stale_write_and_cache_cleanup() {
        let library = LibraryService::new(crate::Database::open_in_memory().unwrap());
        let path = std::env::current_exe().unwrap();
        let sig = signature(&path).unwrap();
        library.db().conn().unwrap().execute("INSERT INTO tracks(id,path,filename,added_at,modified_at,bpm,music_key) VALUES(1,?,'fixture','now','now',100,'Am')",[path.to_string_lossy().as_ref()]).unwrap();
        let analysis = RhythmAnalysis {
            revision: REVISION.into(),
            bpm: Some(128.),
            duration: 10.,
            confidence: 0.9,
            beats: vec![0.1, 0.56875, 1.0375],
            ..Default::default()
        };
        library.save_rhythm(1, &sig, &analysis).unwrap();
        assert_eq!(library.rhythm(1).unwrap().unwrap().bpm, Some(128.));
        let track = library.get(1).unwrap().unwrap();
        assert_eq!(track.bpm, Some(128.));
        assert_eq!(track.music_key, "Am");
        assert_eq!(track.beat_times.len(), 3);
        let summaries = library
            .track_summaries(&crate::service::TrackQuery::default(), &[1])
            .unwrap();
        assert_eq!(summaries[0].bpm, Some(128.));
        let page=library.list_track_summaries(&crate::service::TrackQuery{sort:"bpm".into(),bpm_min:Some(127.),..Default::default()}).unwrap();
        assert_eq!(page.items.len(),1);
        assert_eq!(summaries[0].beat_grid_revision, REVISION);
        assert_eq!(summaries[0].beat_origin, None);
        assert!(!summaries[0].bpm_v3 && !summaries[0].bpm_v2);
        assert!(library
            .save_rhythm(1, "old-source", &RhythmAnalysis::default())
            .is_err());
        assert_eq!(library.rhythm(1).unwrap().unwrap().bpm, Some(128.));
        assert!(library.basic_analysis_cache_usage().unwrap().bytes > 0);
        // An algorithm revision invalidates detail, summary, filtering and pending-work
        // views together; no SQL path may keep a hard-coded previous revision alive.
        library.db().conn().unwrap().execute(
            "UPDATE track_rhythm_v4 SET revision='obsolete-rhythm' WHERE track_id=1", [],
        ).unwrap();
        assert!(library.rhythm(1).unwrap().is_none());
        assert_eq!(library.get(1).unwrap().unwrap().bpm, Some(100.));
        let summaries = library.track_summaries(&crate::service::TrackQuery::default(), &[1]).unwrap();
        assert_eq!(summaries[0].bpm, Some(100.));
        let page = library.list_track_summaries(&crate::service::TrackQuery {
            bpm_min: Some(127.), ..Default::default()
        }).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(library.pending_rhythm_ids(Some(&[1]), false, None, "").unwrap(), vec![1]);
        library.clear_basic_analysis_cache().unwrap();
        assert!(library.rhythm(1).unwrap().is_none());
    }
}
