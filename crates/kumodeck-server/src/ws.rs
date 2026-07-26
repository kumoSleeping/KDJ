//! WebSocket：把事件总线上的消息推给前端。

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::token_matches;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct WsParams {
    #[serde(default)]
    token: String,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<WsParams>,
    upgrade: WebSocketUpgrade,
) -> Response {
    // WS 握手带不了自定义头，token 只能走 query
    if !token_matches(&params.token, &state.config.token) {
        return (axum::http::StatusCode::UNAUTHORIZED, "未授权").into_response();
    }
    upgrade.on_upgrade(move |socket| pump(socket, state))
}

async fn pump(mut socket: WebSocket, state: Arc<AppState>) {
    let mut events = state.hub.subscribe();
    loop {
        match events.recv().await {
            Ok(message) => {
                if socket.send(Message::Text(message.into())).await.is_err() {
                    // 对端断开，收工
                    break;
                }
            }
            // 慢客户端落后了：跳到最新继续，不要断线。
            // 进度类事件天然是后一条覆盖前一条，丢旧的是对的。
            Err(RecvError::Lagged(dropped)) => {
                tracing::debug!("WS 落后 {dropped} 条事件");
            }
            Err(RecvError::Closed) => break,
        }
    }
}
