//! Still and GIF frames for image clips (kdj_providers::workshop_images, pure Rust), decoded once
//! and kept in the cache: what an export draws for them (`/api/kdjv/image`).
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
}
