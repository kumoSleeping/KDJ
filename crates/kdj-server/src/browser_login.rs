//! Cancellable browser authorizations, independent of the lifetime of an HTTP connection.
use anyhow::{Result, bail};
use std::{
    collections::HashMap,
    future::Future,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

static ATTEMPTS: LazyLock<Mutex<HashMap<String, (CancellationToken, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const LIMIT: Duration = Duration::from_secs(11 * 60);

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

// Retain early cancellations briefly: a close/unmount request can arrive before login starts.
pub fn cancel(id: &str) -> Result<()> {
    anyhow::ensure!(valid_id(id), "登录任务编号无效");
    let mut attempts = ATTEMPTS.lock().unwrap_or_else(|p| p.into_inner());
    attempts.retain(|_, (_, started)| started.elapsed() < LIMIT);
    anyhow::ensure!(
        attempts.contains_key(id) || attempts.len() < 128,
        "登录任务过多"
    );
    attempts
        .entry(id.to_owned())
        .or_insert_with(|| (CancellationToken::new(), Instant::now()))
        .0
        .cancel();
    Ok(())
}

struct Attempt(String);
impl Drop for Attempt {
    fn drop(&mut self) {
        ATTEMPTS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

pub async fn run<T>(id: Option<&str>, work: impl Future<Output = Result<T>>) -> Result<T> {
    run_with_limit(id, work, LIMIT).await
}

async fn run_with_limit<T>(
    id: Option<&str>,
    work: impl Future<Output = Result<T>>,
    limit: Duration,
) -> Result<T> {
    let (token, _guard) = if let Some(id) = id {
        anyhow::ensure!(valid_id(id), "登录任务编号无效");
        let mut attempts = ATTEMPTS.lock().unwrap_or_else(|p| p.into_inner());
        attempts.retain(|_, (_, started)| started.elapsed() < LIMIT);
        anyhow::ensure!(attempts.len() < 128, "登录任务过多");
        if let Some((token, _)) = attempts.get(id) {
            if token.is_cancelled() {
                bail!("浏览器登录已取消");
            }
            bail!("该浏览器登录任务已在进行");
        }
        let token = CancellationToken::new();
        attempts.insert(id.to_owned(), (token.clone(), Instant::now()));
        (token, Some(Attempt(id.to_owned())))
    } else {
        (CancellationToken::new(), None)
    };
    tokio::select! {
        biased;
        _ = token.cancelled() => bail!("浏览器登录已取消"),
        result = tokio::time::timeout(limit, work) => result.map_err(|_| anyhow::anyhow!("浏览器登录超时；可重新登录"))?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_drops_work_and_allows_a_new_attempt() {
        let id = "00000000-0000-0000-0000-000000000001";
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Release(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        let release = Release(dropped.clone());
        let (tx, rx) = tokio::sync::oneshot::channel();
        let work = tokio::spawn(run(Some(id), async move {
            let _release = release;
            let _ = tx.send(());
            std::future::pending::<Result<()>>().await
        }));
        rx.await.unwrap();
        cancel(id).unwrap();
        assert!(
            work.await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("已取消")
        );
        assert!(dropped.load(std::sync::atomic::Ordering::Relaxed));
        run(Some(id), async { Ok(()) }).await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_before_start_never_polls_work() {
        let id = "00000000-0000-0000-0000-000000000002";
        cancel(id).unwrap();
        assert!(
            run(Some(id), async {
                panic!("cancelled work was polled");
                #[allow(unreachable_code)]
                Ok::<_, anyhow::Error>(())
            })
            .await
            .is_err()
        );
        ATTEMPTS.lock().unwrap().remove(id);
    }
    #[tokio::test]
    async fn deadline_releases_attempt_and_other_cancellation_does_not_stop_it() {
        let id = "00000000-0000-0000-0000-000000000003";
        let other = "00000000-0000-0000-0000-000000000004";
        let result = run_with_limit(
            Some(id),
            async {
                cancel(other).unwrap();
                std::future::pending::<Result<()>>().await
            },
            Duration::from_millis(10),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("超时"));
        run(Some(id), async { Ok(()) }).await.unwrap();
        ATTEMPTS.lock().unwrap().remove(other);
    }
}
