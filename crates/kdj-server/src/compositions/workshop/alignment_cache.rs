//! Independently cached, overlapping recording blocks. Index descriptors keep
//! active files pinned, but neither PCM nor all spectra stay resident in memory.
use super::*;
use kdj_analysis::alignment::{
    AudioFeatures, AudioSummary, FEATURE_BLOCK_SECONDS, FEATURE_GUARD_SECONDS,
    FEATURE_MEMORY_BUDGET, FEATURE_REVISION,
};
use std::{
    collections::VecDeque,
    io::{BufReader, BufWriter, Write},
};

pub(super) type FeatureCache = VecDeque<(String, Arc<AudioFeatures>)>;

pub(super) struct FeatureBlock {
    pub clip: Clip,
    pub start_ms: f64,
    pub core_start_ms: f64,
    pub core_end_ms: f64,
    key: String,
    signature: String,
    path: PathBuf,
    // Also prevents the ordinary cache trimmer from evicting an active index.
    lock: Arc<tokio::sync::Mutex<()>>,
}

pub(super) struct RecordingIndex {
    pub blocks: Vec<FeatureBlock>,
    pub duration_ms: f64,
    source_id: String,
    signature: String,
}

impl RecordingIndex {
    pub fn verify(&self, p: &CompositionProject) -> Result<()> {
        let source = p.source(&self.source_id).context("素材不存在")?;
        anyhow::ensure!(
            signature(Path::new(&source.path))? == self.signature,
            "分析期间素材已变化：{}，请重新添加",
            source.title
        );
        Ok(())
    }
}

impl Workshop {
    pub(super) async fn alignment_index(
        &self,
        p: &CompositionProject,
        clip: &Clip,
        cancel: &CancellationToken,
    ) -> Result<RecordingIndex> {
        let started = std::time::Instant::now();
        let source = p.source(&clip.source_id).context("素材不存在")?;
        let signature_before = signature(Path::new(&source.path))?;
        check_source(source, &signature_before)?;
        let duration_ms = clip.duration();
        anyhow::ensure!(duration_ms.is_finite() && duration_ms > 0., "音频区间无效");
        let step = FEATURE_BLOCK_SECONDS as f64 * 1000.;
        let guard = FEATURE_GUARD_SECONDS as f64 * 1000.;
        let mut blocks = vec![];
        let mut core_start_ms = 0.;
        while core_start_ms < duration_ms {
            if cancel.is_cancelled() {
                bail!("匹配已取消")
            }
            let core_end_ms = (core_start_ms + step).min(duration_ms);
            let start_ms = (core_start_ms - guard).max(0.);
            let end_ms = (core_end_ms + guard).min(duration_ms);
            let slice = render::slice(clip, start_ms, end_ms);
            let key = render::key(&(
                "alignment-block-v2",
                FEATURE_REVISION,
                &source.path,
                &signature_before,
                source.video,
                slice.source_in_ms,
                slice.source_out_ms,
                &slice.speed,
                slice.display_duration_ms,
                slice.animation_offset_ms,
            ))?;
            let block = FeatureBlock {
                clip: slice,
                start_ms,
                core_start_ms,
                core_end_ms,
                signature: signature_before.clone(),
                path: self.cache.join(format!("{key}.afp")),
                lock: self.cache_lock(&key).await,
                key,
            };
            // A warm index reads only its small retrieval features. A missing or
            // damaged block is rebuilt on its own, never the entire recording.
            self.alignment_summary(p, &block, cancel).await?;
            blocks.push(block);
            core_start_ms = core_end_ms;
        }
        anyhow::ensure!(
            signature(Path::new(&source.path))? == signature_before,
            "分析期间素材已变化：{}，请重新添加",
            source.title
        );
        tracing::debug!(source = %source.id, blocks = blocks.len(), duration_ms,
            elapsed_ms = started.elapsed().as_millis() as u64, "workshop alignment index ready");
        Ok(RecordingIndex {
            blocks,
            duration_ms,
            source_id: source.id.clone(),
            signature: signature_before,
        })
    }

    pub(super) async fn alignment_summary(
        &self,
        p: &CompositionProject,
        block: &FeatureBlock,
        cancel: &CancellationToken,
    ) -> Result<AudioSummary> {
        let guard = tokio::select! {
            _ = cancel.cancelled() => bail!("匹配已取消"),
            guard = block.lock.lock() => guard,
        };
        let path = block.path.clone();
        let summary = tokio::task::spawn_blocking(move || {
            read_cached(&path, |file| AudioSummary::read_from(BufReader::new(file)))
        })
        .await??;
        drop(guard);
        if cancel.is_cancelled() {
            bail!("匹配已取消")
        }
        match summary {
            Some(summary) => Ok(summary),
            None => Ok(self.alignment_block(p, block, cancel).await?.summary()),
        }
    }

    pub(super) async fn alignment_block(
        &self,
        p: &CompositionProject,
        block: &FeatureBlock,
        cancel: &CancellationToken,
    ) -> Result<Arc<AudioFeatures>> {
        let source = p.source(&block.clip.source_id).context("素材不存在")?;
        let signature_before = signature(Path::new(&source.path))?;
        check_source(source, &signature_before)?;
        anyhow::ensure!(
            signature_before == block.signature,
            "分析期间素材已变化：{}，请重新添加",
            source.title
        );
        let _guard = tokio::select! {
            _ = cancel.cancelled() => bail!("匹配已取消"),
            guard = block.lock.lock() => guard,
        };
        if cancel.is_cancelled() {
            bail!("匹配已取消")
        }
        {
            let mut memory = self.alignment_features.lock().unwrap();
            if let Some(index) = memory.iter().position(|(cached, _)| cached == &block.key) {
                let entry = memory.remove(index).unwrap();
                let features = entry.1.clone();
                memory.push_back(entry);
                return Ok(features);
            }
        }
        let path = block.path.clone();
        let cached = tokio::task::spawn_blocking(move || {
            read_cached(&path, |file| AudioFeatures::read_from(BufReader::new(file)))
        })
        .await??;
        if cancel.is_cancelled() {
            bail!("匹配已取消")
        }
        let features = if let Some(features) = cached {
            Arc::new(features)
        } else {
            let pcm = render::alignment_pcm(p, &block.clip, cancel).await?;
            let worker_cancel = cancel.clone();
            let features = Arc::new(
                tokio::task::spawn_blocking(move || {
                    kdj_core::thread_qos::prefer_background();
                    AudioFeatures::prepare(&pcm, || worker_cancel.is_cancelled())
                })
                .await??,
            );
            let temp = self.cache.join(format!("{}.part", block.key));
            let write_path = temp.clone();
            let output = features.clone();
            let result = async {
                tokio::task::spawn_blocking(move || -> Result<()> {
                    let mut writer = BufWriter::new(std::fs::File::create(write_path)?);
                    output.write_to(&mut writer)?;
                    writer.flush()?;
                    Ok(())
                })
                .await??;
                if cancel.is_cancelled() {
                    bail!("匹配已取消")
                }
                anyhow::ensure!(
                    signature(Path::new(&source.path))? == signature_before,
                    "分析期间素材已变化：{}，请重新添加",
                    source.title
                );
                tokio::fs::rename(&temp, &block.path).await?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if result.is_err() {
                let _ = tokio::fs::remove_file(&temp).await;
            }
            result?;
            self.trim_cache();
            features
        };
        if cancel.is_cancelled() {
            bail!("匹配已取消")
        }
        anyhow::ensure!(
            signature(Path::new(&source.path))? == signature_before,
            "分析期间素材已变化：{}，请重新添加",
            source.title
        );
        let mut memory = self.alignment_features.lock().unwrap();
        memory.push_back((block.key.clone(), features.clone()));
        let mut bytes: usize = memory.iter().map(|(_, f)| f.memory_bytes()).sum();
        while bytes > FEATURE_MEMORY_BUDGET {
            let Some((_, oldest)) = memory.pop_front() else {
                break;
            };
            bytes -= oldest.memory_bytes();
        }
        Ok(features)
    }
}

fn check_source(source: &Source, actual: &str) -> Result<()> {
    anyhow::ensure!(
        source.signature.is_empty() || source.signature == actual,
        "素材已变化：{}，请重新添加",
        source.title
    );
    Ok(())
}

fn read_cached<T>(path: &Path, read: impl FnOnce(std::fs::File) -> Result<T>) -> Result<Option<T>> {
    match std::fs::File::open(path) {
        Ok(file) => match read(file) {
            Ok(value) => Ok(Some(value)),
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "rebuilding invalid alignment block");
                std::fs::remove_file(path)?;
                Ok(None)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
