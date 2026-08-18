//! EventHub：把后台任务产生的事件广播给所有 WebSocket 连接。
//!
//! Python 版这里有一整段关于"工作线程不能直接碰 asyncio.Queue、必须走
//! `loop.call_soon_threadsafe`"的注意事项。Rust 这边整个问题不存在：
//! `tokio::sync::broadcast` 本身就是跨线程安全的，任何线程/任务都能 `send`。
//!
//! 保留的语义有两条：
//! 1. **没人订阅时不做序列化**——扫描/分析进度每秒几十条，白烧 CPU。
//!    broadcast 的 `receiver_count() == 0` 就是这个判断。
//! 2. **慢客户端丢最旧的**——broadcast 的 ring buffer 满了会让慢接收方收到
//!    `RecvError::Lagged(n)` 并跳到最新位置，正好是"丢旧留新"。进度类事件
//!    天然是后一条覆盖前一条，丢旧的才对。

use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast;

pub const DEFAULT_QUEUE_SIZE: usize = 512;

/// WS 事件的线路格式：`{"type": ..., "payload": ...}`。
/// 对应 `src/types.ts` 的 `WsEvent` 联合类型。
#[derive(Debug, Clone)]
pub struct EventHub {
    sender: broadcast::Sender<String>,
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new(DEFAULT_QUEUE_SIZE)
    }
}

impl EventHub {
    pub fn new(queue_size: usize) -> Self {
        let (sender, _) = broadcast::channel(queue_size.max(1));
        EventHub { sender }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.sender.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }

    /// 任何线程都能调。没有 WS 连接时是廉价的空操作。
    pub fn publish<T: Serialize>(&self, type_: &str, payload: &T) {
        if self.sender.receiver_count() == 0 {
            return;
        }
        // 用具名结构体而不是 `json!` 宏：serde_json 的 Map 默认按键排序，
        // `json!` 会把线路格式变成 `{"payload":...,"type":...}`。JSON 解析不在乎顺序，
        // 但日志/抓包时 type 在前才读得下去。
        #[derive(Serialize)]
        struct Envelope<'a, T> {
            #[serde(rename = "type")]
            type_: &'a str,
            payload: &'a T,
        }
        let message = match serde_json::to_string(&Envelope { type_, payload }) {
            Ok(message) => message,
            Err(err) => {
                tracing::warn!("事件 {type_} 序列化失败：{err}");
                return;
            }
        };
        // Err 只意味着"这一刻没有接收者"，不是错误。
        let _ = self.sender.send(message);
    }

    /// `library.updated` 出现在多处，统一在这里拼，避免 payload 形状漂移。
    pub fn publish_library_updated(&self, track_ids: &[i64]) {
        self.publish("library.updated", &json!({ "track_ids": track_ids }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_reaches_every_subscriber() {
        let hub = EventHub::new(8);
        let mut a = hub.subscribe();
        let mut b = hub.subscribe();
        hub.publish("toast", &json!({"level": "info", "text": "hi"}));

        let want = r#"{"type":"toast","payload":{"level":"info","text":"hi"}}"#;
        assert_eq!(a.recv().await.unwrap(), want);
        assert_eq!(b.recv().await.unwrap(), want);
    }

    #[tokio::test]
    async fn no_subscribers_is_a_cheap_noop() {
        let hub = EventHub::new(8);
        hub.publish("scan.progress", &json!({"done": 1}));
        // 订阅是在 publish 之后才建立的，所以收不到刚才那条——正是我们要的
        let mut late = hub.subscribe();
        assert!(late.try_recv().is_err());
    }

    #[tokio::test]
    async fn slow_subscriber_loses_the_oldest_not_the_newest() {
        let hub = EventHub::new(2);
        let mut slow = hub.subscribe();
        for i in 0..5 {
            hub.publish("analyze.progress", &json!({ "done": i }));
        }
        // 落后的接收方先拿到 Lagged，再从最新的位置继续读
        match slow.recv().await {
            Err(broadcast::error::RecvError::Lagged(n)) => assert_eq!(n, 3),
            other => panic!("期望 Lagged，实际 {other:?}"),
        }
        let next = slow.recv().await.unwrap();
        assert!(
            next.contains("\"done\":3"),
            "应当续在最新事件上，实际 {next}"
        );
    }
}
