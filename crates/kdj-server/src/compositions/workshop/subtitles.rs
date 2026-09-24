//! System-font text is rasterized by the editing WebView. Keep its transparent
//! pixels as durable project media so reopening/export never substitutes fonts.
use super::*;

#[derive(Serialize)]
pub(super) struct SubtitleSource {
    snapshot: Snapshot,
    source_id: String,
}
impl Workshop {
    pub(super) async fn subtitle_source(&self, pid: &str, revision: u64, title: &str, bytes: Vec<u8>) -> Result<SubtitleSource> {
        self.project(pid, revision)?;
        if title.trim().is_empty() || title.chars().count() > 100 || bytes.len() > 2 * 1024 * 1024 {
            bail!("字幕素材无效")
        }
        let _slot = self.frame_slots.acquire().await?;
        let (width, height, png) = tokio::task::spawn_blocking(move ||
            kdj_providers::workshop_images::subtitle_png(&bytes)
        ).await??;
        // This is original project media, not an evictable preview cache.
        let directory = self.state.config.data_dir.join("workshop-subtitles");
        tokio::fs::create_dir_all(&directory).await?;
        let sid = id();
        let path = directory.join(format!("{sid}.png"));
        tokio::fs::write(&path, png).await?;
        let result = (|| {
            let source = Source {
                kind: "image".into(), frame_ends_ms: vec![], id: sid.clone(), track_id: 0,
                path: path.to_string_lossy().into_owned(), title: title.trim().into(),
                duration_ms: 5000., video: false, audio: false, width, height, fps: 30.,
                signature: signature(&path)?,
            };
            self.change(|j| {
                let p = j.projects.iter_mut().find(|p| p.id == pid).context("作品不存在")?;
                if p.revision != revision { bail!("作品已更新，请重试当前操作") }
                p.sources.push(source);
                p.validate().map_err(anyhow::Error::msg)?;
                p.revision += 1;
                Ok(())
            })
        })();
        match result {
            Ok(snapshot) => Ok(SubtitleSource { snapshot, source_id: sid }),
            Err(error) => { let _ = tokio::fs::remove_file(path).await; Err(error) }
        }
    }
}
