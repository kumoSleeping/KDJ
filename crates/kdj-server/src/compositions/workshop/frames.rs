use super::*;
use std::time::Duration;
impl Workshop {
    /// Source frames are independent of preview tickets: trimming must work while a revision is edited.
    pub async fn source_frame(&self, pid: &str, sid: &str, ms: f64, width: u32) -> Result<Vec<u8>> {
        if !ms.is_finite() || ms < 0. || ![160, 320, 960].contains(&width) {
            bail!("画面位置或尺寸无效")
        }
        let source = {
            let journal = self.journal.lock().unwrap();
            journal
                .projects
                .iter()
                .find(|p| p.id == pid)
                .and_then(|p| p.source(sid))
                .cloned()
                .context("素材不存在")?
        };
        if source.image() {
            let index = kdj_providers::workshop_images::frame_index(&source.frame_ends_ms, ms);
            let path = self.image_frame(&source, index, width).await?;
            return Ok(tokio::fs::read(path).await?);
        }
        if !source.video {
            bail!("该素材没有视频画面")
        }
        if !source.signature.is_empty() && signature(Path::new(&source.path))? != source.signature {
            bail!("素材已变化，请重新添加")
        }
        let fps = source.fps.max(1.);
        let frame =
            ((ms.min((source.duration_ms - 1000. / fps).max(0.)) * fps / 1000.).floor()) as u64;
        let key = render::key(&("frame-v1", &source.signature, &source.path, frame, width))?;
        let path = self.cache.join(format!("{key}.jpg"));
        let lock = self.cache_lock(&key).await;
        let _lock = lock.lock().await;
        if path.is_file() {
            return Ok(tokio::fs::read(path).await?);
        }
        let _slot = self.frame_slots.acquire().await?;
        let cancel = CancellationToken::new();
        let _guard = cancel.clone().drop_guard();
        let args = vec![
            "-nostdin".into(),
            "-v".into(),
            "error".into(),
            "-filter_threads".into(),
            "1".into(),
            "-threads".into(),
            "1".into(),
            "-ss".into(),
            format!("{:.9}", frame as f64 / fps),
            "-i".into(),
            source.path,
            "-an".into(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            format!(
                "scale={width}:{width}:force_original_aspect_ratio=decrease:force_divisible_by=2"
            ),
            "-threads".into(),
            "1".into(),
            "-c:v".into(),
            "mjpeg".into(),
            "-q:v".into(),
            "4".into(),
            "-f".into(),
            "image2pipe".into(),
            "pipe:1".into(),
        ];
        let bytes = media::capture(
            &kdj_providers::ffmpeg::binary()?,
            &args,
            4 * 1024 * 1024,
            Duration::from_secs(30),
            &cancel,
        )
        .await?;
        if !bytes.starts_with(&[0xff, 0xd8]) {
            bail!("无法读取该帧")
        }
        let temp = path.with_extension("part");
        tokio::fs::write(&temp, &bytes).await?;
        tokio::fs::rename(temp, path).await?;
        self.trim_cache();
        Ok(bytes)
    }
}

impl Workshop {
    pub(super) async fn image_frame(&self, source: &Source, index: usize, width: u32) -> Result<PathBuf> {
        if signature(Path::new(&source.path))? != source.signature { bail!("素材已变化：{}，请重新添加", source.title) }
        let key = render::key(&("picture-v1", &source.signature, &source.path, index, width))?;
        let path = self.cache.join(format!("{key}.png"));
        let lock = self.cache_lock(&key).await; let _lock = lock.lock().await;
        if path.is_file() { return Ok(path) }
        let _slot = self.frame_slots.acquire().await?;
        let source = source.clone();
        let bytes = tokio::task::spawn_blocking(move || kdj_providers::workshop_images::frame_png(Path::new(&source.path), source.kind == "gif", index, width)).await??;
        let temp = path.with_extension("part");
        tokio::fs::write(&temp, bytes).await?;
        tokio::fs::rename(&temp, &path).await?;
        self.trim_cache(); Ok(path)
    }
}
