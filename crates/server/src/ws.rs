//! The WebSocket endpoint. Authenticates the first frame, joins the room, then pumps frames
//! both ways with size, rate and liveness limits.

use crate::AppState;
use crate::links;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use mapcro_engine::wire::{CloseReason, WireIn, WireOut};
use std::time::Duration;
use tokio::time::{Instant, interval, timeout};

const MAX_FRAME: usize = 256 * 1024;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(15);
const DEAD_AFTER: Duration = Duration::from_secs(40);
/// Token bucket for inbound frames: sustained rate and burst.
const RATE_PER_SEC: f64 = 60.0;
const BURST: f64 = 300.0;

pub async fn upgrade(State(app): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    // Cross-site WebSocket hijacking: browsers always send Origin on upgrades; refuse others.
    let origin = headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !app.config.allowed_origins.iter().any(|o| o == origin) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    ws.max_message_size(MAX_FRAME).max_frame_size(MAX_FRAME).on_upgrade(move |socket| session(app, socket))
}

fn frame(out: &WireOut) -> Message {
    Message::Text(serde_json::to_string(out).unwrap_or_default().into())
}

async fn send_closed(socket: &mut WebSocket, reason: CloseReason) {
    let _ = socket.send(frame(&WireOut::Closed { reason })).await;
    let _ = socket.close().await;
}

async fn session(app: AppState, mut socket: WebSocket) {
    // 1. Authenticate.
    let first = match timeout(AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => t,
        _ => return send_closed(&mut socket, CloseReason::Unauthorized).await,
    };
    let Ok(WireIn::Auth { board, token, known_seq }) = serde_json::from_str::<WireIn>(&first) else {
        return send_closed(&mut socket, CloseReason::Unauthorized).await;
    };
    if !links::plausible_board_id(&board) || !links::plausible_token(&token) {
        return send_closed(&mut socket, CloseReason::Unauthorized).await;
    }
    let hash = links::hash(&token);
    let link = match app.store.link(hash.clone()).await {
        Ok(Some(l)) if l.board == board && !l.revoked => l,
        Ok(_) => return send_closed(&mut socket, CloseReason::Unauthorized).await,
        Err(e) => {
            tracing::error!(error = %e, "link lookup failed");
            return send_closed(&mut socket, CloseReason::StorageFailure).await;
        }
    };

    // 2. Join the room.
    let (room, (conn, mut outbox, base)) =
        match app.rooms.join(&board, hash, link.role.engine_role(), known_seq.is_none()).await {
            Ok(j) => j,
            Err(e) => {
                tracing::error!(board, error = %e, "room failed to open");
                return send_closed(&mut socket, CloseReason::StorageFailure).await;
            }
        };
    if socket.send(frame(&WireOut::Ready { role: link.role, base })).await.is_err() {
        let _ = room.send(crate::room::RoomCmd::Leave { conn }).await;
        return;
    }

    // 3. Pump.
    let (mut sink, mut stream) = socket.split();
    let mut ping = interval(PING_EVERY);
    let mut last_heard = Instant::now();
    let mut tokens = BURST;
    let mut refilled = Instant::now();
    let reason = loop {
        tokio::select! {
            out = outbox.recv() => match out {
                Some(out) => {
                    let closing = matches!(out, WireOut::Closed { .. });
                    if sink.send(frame(&out)).await.is_err() { break None; }
                    if closing { break None; }
                }
                None => break Some(CloseReason::ShuttingDown),
            },
            incoming = stream.next() => {
                last_heard = Instant::now();
                match incoming {
                    Some(Ok(Message::Text(t))) => {
                        let now = Instant::now();
                        tokens = (tokens + now.duration_since(refilled).as_secs_f64() * RATE_PER_SEC).min(BURST);
                        refilled = now;
                        if tokens < 1.0 { break Some(CloseReason::Abuse); }
                        tokens -= 1.0;
                        match serde_json::from_str::<WireIn>(&t) {
                            Ok(WireIn::Msg { msg }) => {
                                if room.send(crate::room::RoomCmd::Msg { conn, msg }).await.is_err() {
                                    break Some(CloseReason::StorageFailure);
                                }
                            }
                            _ => break Some(CloseReason::Abuse),
                        }
                    }
                    Some(Ok(Message::Pong(_) | Message::Ping(_))) => {}
                    Some(Ok(Message::Binary(_))) => break Some(CloseReason::Abuse),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break None,
                }
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > DEAD_AFTER { break None; }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break None; }
            }
        }
    };
    let _ = room.send(crate::room::RoomCmd::Leave { conn }).await;
    if let Some(reason) = reason {
        let _ = sink.send(frame(&WireOut::Closed { reason })).await;
    }
    let _ = sink.close().await;
}
