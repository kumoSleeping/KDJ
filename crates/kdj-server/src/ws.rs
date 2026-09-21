//! WebSocket：把事件总线上的消息推给前端。

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use tokio::sync::broadcast::error::RecvError;

use crate::state::AppState;
use crate::{origin_allowed, AuthToken};

const WS_PROTOCOL: &str = "kdj-v1";
const AUTH_PROTOCOL_PREFIX: &str = "kdj-auth.";

fn protocol_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
        .find_map(|value| value.strip_prefix(AUTH_PROTOCOL_PREFIX))
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<AuthToken>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let trusted_origin = headers.get(header::ORIGIN).is_some_and(origin_allowed);
    let authenticated = protocol_token(&headers).is_some_and(|value| token.matches(value));
    if !trusted_origin {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !authenticated {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    upgrade
        .protocols([WS_PROTOCOL])
        .on_upgrade(move |socket| pump(socket, state))
}

async fn pump(mut socket: WebSocket, state: Arc<AppState>) {
    let (mut events, snapshot) = state.hub.subscribe_with_progress();
    if socket.send(Message::Text(snapshot.into())).await.is_err() {
        return;
    }
    loop {
        let event = tokio::select! {
            event = events.recv() => event,
            incoming = socket.recv() => {
                match incoming {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    _ => continue,
                }
            }
        };
        match event {
            Ok(message) => {
                if socket.send(Message::Text(message.into())).await.is_err() {
                    // 对端断开，收工
                    break;
                }
            }
            // A gap can include a final task event, so restore authoritative progress
            // and ask the client to refresh its durable lists instead of silently skipping.
            Err(RecvError::Lagged(dropped)) => {
                tracing::debug!("WS 落后 {dropped} 条事件");
                let (fresh, snapshot) = state.hub.subscribe_with_progress();
                events = fresh;
                if socket.send(Message::Text(snapshot.into())).await.is_err() {
                    break;
                }
                if socket
                    .send(Message::Text(
                        r#"{"type":"connection.resync","payload":{}}"#.into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(RecvError::Closed) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_the_dedicated_auth_subprotocol() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            "kdj-v1, kdj-auth.abc123".parse().unwrap(),
        );
        assert_eq!(protocol_token(&headers), Some("abc123"));
    }
}
