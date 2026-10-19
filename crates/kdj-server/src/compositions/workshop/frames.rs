//! Still and GIF frames for image clips, decoded once and kept in the render cache.
use super::*;
impl Workshop {
    /// Read under the key lock: trim_cache may evict the PNG as soon as it is released.
    pub(super) async fn image_frame(&self, source: &Source, index: usize, width: u32) -> Result<Vec<u8>> {
        if signature(Path::new(&source.path))? != source.signature { bail!("素材已变化：{}，请重新添加", source.title) }
        let key = render::key(&("picture-v1", &source.signature, &source.path, index, width))?;
        let path = self.cache.join(format!("{key}.png"));
        let lock = self.cache_lock(&key).await; let _lock = lock.lock().await;
        if path.is_file() { return Ok(tokio::fs::read(path).await?) }
        let _slot = self.frame_slots.acquire().await?;
        let source = source.clone();
        let bytes = tokio::task::spawn_blocking(move || kdj_providers::workshop_images::frame_png(Path::new(&source.path), source.kind == "gif", index, width)).await??;
        let temp = path.with_extension("part");
        tokio::fs::write(&temp, &bytes).await?;
        tokio::fs::rename(&temp, &path).await?;
        self.trim_cache(); Ok(bytes)
    }
    /// A render wants many full-size frames of one GIF: stage them all from one decode pass
    /// instead of replaying from frame 0 per frame. A cached frame is copied under its key
    /// lock and a decoded one is staged as it is written, so trim_cache cannot take a frame
    /// away before the render has it.
    pub(super) async fn gif_frames(&self, source: &Source, indices: &std::collections::BTreeSet<usize>, stage: &Path, n: usize, cancel: &CancellationToken) -> Result<()> {
        if signature(Path::new(&source.path))? != source.signature { bail!("素材已变化：{}，请重新添加", source.title) }
        // Same order as image_frame (key lock, then slot); indices ascend, so batches can't cross.
        let mut missing = std::collections::BTreeMap::new();
        for &index in indices {
            render::check(cancel)?;
            let key = render::key(&("picture-v1", &source.signature, &source.path, index, 0u32))?;
            let path = self.cache.join(format!("{key}.png"));
            let staged = stage.join(format!("image-{n}-{index}.png"));
            let lock = self.cache_lock(&key).await.lock_owned().await;
            // A cached frame that cannot be copied is decoded like a missing one.
            if !path.is_file() || tokio::fs::copy(&path, &staged).await.is_err() { missing.insert(index, (lock, path, staged)); }
        }
        if missing.is_empty() { return Ok(()) }
        let _slot = self.frame_slots.acquire().await?;
        let (wanted, path, cancel) = (missing.keys().copied().collect(), source.path.clone(), cancel.clone());
        tokio::task::spawn_blocking(move || kdj_providers::workshop_images::frame_pngs(Path::new(&path), &wanted, 0, |index, bytes| {
            render::check(&cancel)?;
            let (_, path, staged) = &missing[&index];
            std::fs::write(staged, &bytes)?;
            let temp = path.with_extension("part");
            let cached = std::fs::write(&temp, bytes).and_then(|()| std::fs::rename(&temp, path));
            if cached.is_err() { let _ = std::fs::remove_file(&temp); }
            Ok(cached?)
        })).await??;
        self.trim_cache(); Ok(())
    }
}
