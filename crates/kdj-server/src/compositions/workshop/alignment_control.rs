use super::*;

pub(super) struct AlignmentLease {
    manager: Arc<Workshop>,
    request: String,
    pub cancel: CancellationToken,
}
impl Drop for AlignmentLease {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.manager.alignments.lock().unwrap().remove(&self.request);
        self.manager.state.analysis.unregister(&self.request);
    }
}
fn valid_request(request: &str) -> Result<()> {
    if !request.starts_with("workshop-align-") || request.len() > 128 || !request.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        bail!("对齐任务编号无效")
    }
    Ok(())
}
impl Workshop {
    pub(super) fn begin_alignment(self: &Arc<Self>, request: &str) -> Result<AlignmentLease> {
        valid_request(request)?;
        let mut active = self.alignments.lock().unwrap();
        if active.get(request).is_some_and(|c| !c.is_cancelled()) { bail!("对齐任务已存在") }
        let cancel = self.state.analysis.register(request, 1, Arc::new(std::sync::atomic::AtomicUsize::new(0)), false);
        if active.get(request).is_some_and(CancellationToken::is_cancelled) { cancel.cancel(); }
        active.insert(request.into(), cancel.clone());
        Ok(AlignmentLease { manager: self.clone(), request: request.into(), cancel })
    }
    pub fn cancel_alignment(&self, request: &str) -> Result<()> {
        valid_request(request)?;
        let mut active = self.alignments.lock().unwrap();
        // Cancellation may reach the server before the analysis request is admitted.
        if active.len() > 1024 { active.retain(|_, token| !token.is_cancelled()); }
        active.entry(request.into()).or_default().cancel();
        Ok(())
    }
}
