//! Preview proxies of a project's video sources (docs/kdjv.md "预览代理"): the live preview
//! seeks its sources all the time — each play, each jump, each cue — and a source keyed every few
//! seconds makes every seek decode seconds of frames first. A proxy is the same picture keyed every
//! half second, without B-frames, at most 720 high and silent, made once per file in the
//! background and kept in the render cache by the file and its signature. Only the live preview
//! reads it; renders and exports read the source.
use super::{signature, Workshop};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

/// Keyframes this far apart in a proxy, in seconds.
const KEY_SEC: f64 = 0.5;
/// A proxy is this high at most, in pixels.
const PROXY_HEIGHT: u32 = 720;

impl Workshop {
    /// Where the proxy of `source` is kept: named by the file and what it is now.
    fn proxy_path(&self, source: &Path) -> Option<PathBuf> {
        use sha2::Digest;
        let sig = signature(source).ok()?;
        let digest = sha2::Sha256::digest(format!("{}\0{sig}", source.display()).as_bytes());
        let name: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
        Some(self.cache.join(format!("proxy-{name}.mp4")))
    }

    /// The proxy of `source`, once it has been made.
    pub fn kdjv_proxy(&self, source: &Path) -> Option<PathBuf> {
        self.proxy_path(source).filter(|path| path.is_file())
    }

    /// Makes the proxies of `sources` not made yet, one after another in the background, and
    /// says `kdjv.proxy` with each source's path as one is ready. A source already being made or
    /// waiting is not asked again.
    pub fn kdjv_make_proxies(&self, sources: Vec<(PathBuf, f64)>) {
        let Some(me) = self.me.upgrade() else { return };
        for (source, fps) in sources {
            if self.kdjv_proxy(&source).is_some() || !self.proxies_wanted.lock().unwrap().insert(source.clone()) {
                continue;
            }
            let worker = me.clone();
            tokio::spawn(async move {
                let made = async {
                    let _slot = worker.proxy_slots.acquire().await?;
                    worker.make_proxy(&source, fps).await
                }
                .await;
                worker.proxies_wanted.lock().unwrap().remove(&source);
                match made {
                    Ok(()) => worker.state.hub.publish("kdjv.proxy", &serde_json::json!({"source": source.to_string_lossy()})),
                    Err(error) => tracing::warn!("预览代理没做成：{}：{error:#}", source.display()),
                }
            });
        }
    }

    /// A project's live preview as the window gets it: each video source says whether its proxy
    /// is there to load (`proxy`), and those without one are made meanwhile.
    pub fn live_shown(&self, p: &kdj_core::workshop::CompositionProject) -> super::kdjv::Live {
        let mut shown = super::kdjv::live(p);
        let mut wanted = vec![];
        // Only the sources seen: a video giving only its sound is never drawn.
        let drawn: std::collections::HashSet<usize> = shown.clips.iter().map(|c| c.source).collect();
        for (n, (s, out)) in p.sources.iter().zip(shown.sources.iter_mut()).enumerate() {
            if !s.video || s.image() || !drawn.contains(&n) {
                continue;
            }
            let path = PathBuf::from(&s.path);
            out.proxy = self.kdjv_proxy(&path).is_some();
            if !out.proxy {
                wanted.push((path, s.fps));
            }
        }
        self.kdjv_make_proxies(wanted);
        shown
    }

    async fn make_proxy(&self, source: &Path, fps: f64) -> Result<()> {
        let target = self.proxy_path(source).context("读不到素材")?;
        if target.is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.cache)?;
        // `.part` files are cleared when the workshop starts; the log goes with it.
        let partial = target.with_extension(format!("{}.part", super::id()));
        let log = partial.with_extension("log");
        let key = ((fps.max(1.) * KEY_SEC).round() as u32).max(1).to_string();
        let args: Vec<String> = [
            "-y", "-i", &source.to_string_lossy(), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-vf", &format!("scale=-2:'min({PROXY_HEIGHT},ih)'"),
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "fastdecode", "-crf", "27",
            "-g", &key, "-keyint_min", &key, "-sc_threshold", "0", "-bf", "0",
            "-pix_fmt", "yuv420p", "-threads", "2", "-movflags", "+faststart", "-f", "mp4",
            &partial.to_string_lossy(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let made = kdj_providers::ffmpeg::run(&args, &log, &CancellationToken::new()).await;
        let _ = std::fs::remove_file(&log);
        if let Err(error) = made {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        std::fs::rename(&partial, &target)?;
        self.trim_cache();
        Ok(())
    }
}
