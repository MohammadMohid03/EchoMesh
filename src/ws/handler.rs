use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use tracing::{info, warn};

use crate::room::manager::{JoinError, RoomManager};
use crate::types::{PeerId, RoomId};
use crate::ws::messages::{ClientMessage, ServerMessage};

/// HTTP GET handler — upgrades the connection to a WebSocket.
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(room_manager): State<RoomManager>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_connection(socket, room_manager))
}

/// Manages the full lifecycle of a single WebSocket connection.
///
/// 1. Waits for a `Join` message to register the peer
/// 2. Sends back the current peer list
/// 3. Notifies existing peers about the new arrival
/// 4. Enters the main loop: reads client messages and routes them
/// 5. On disconnect: cleans up and notifies remaining peers
async fn handle_connection(socket: WebSocket, room_manager: RoomManager) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // ── Phase 1: Wait for the Join message ──────────────────────────────
    let (peer_id, room_id, mut peer_rx) = loop {
        match ws_receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::Join {
                        room,
                        peer_id,
                        password,
                        create,
                    }) => {
                        let room_id = RoomId(room);
                        let (rx, existing_peers) =
                            match room_manager.join_room(
                                &room_id,
                                &peer_id,
                                password.as_deref(),
                                create.unwrap_or(false),
                            ) {
                                Ok(joined) => joined,
                                Err(JoinError::MissingPassword) => {
                                    let err = ServerMessage::Error {
                                        message: "Room access key is required".into(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&err) {
                                        let _ = ws_sender.send(Message::Text(json.into())).await;
                                    }
                                    return;
                                }
                                Err(JoinError::InvalidPassword) => {
                                    let err = ServerMessage::Error {
                                        message: "Invalid room access key".into(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&err) {
                                        let _ = ws_sender.send(Message::Text(json.into())).await;
                                    }
                                    return;
                                }
                                Err(JoinError::RoomNotFound) => {
                                    let err = ServerMessage::Error {
                                        message: "Room not found. Ask the host to create it first.".into(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&err) {
                                        let _ = ws_sender.send(Message::Text(json.into())).await;
                                    }
                                    return;
                                }
                            };

                        // Tell the new peer who's already in the room
                        let peer_list = ServerMessage::PeerList {
                            peers: existing_peers,
                        };
                        if let Ok(json) = serde_json::to_string(&peer_list)
                            && ws_sender.send(Message::Text(json.into())).await.is_err()
                        {
                            return;
                        }

                        // Tell existing peers about the newcomer
                        room_manager
                            .broadcast_to_room(
                                &room_id,
                                &peer_id,
                                ServerMessage::PeerJoined {
                                    peer_id: peer_id.clone(),
                                },
                            )
                            .await;

                        break (peer_id, room_id, rx);
                    }
                    Ok(_) => {
                        let err = ServerMessage::Error {
                            message: "First message must be a 'join' message".into(),
                        };
                        if let Ok(json) = serde_json::to_string(&err) {
                            let _ = ws_sender.send(Message::Text(json.into())).await;
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "Failed to parse initial message");
                        let err = ServerMessage::Error {
                            message: format!("Invalid message format: {e}"),
                        };
                        if let Ok(json) = serde_json::to_string(&err) {
                            let _ = ws_sender.send(Message::Text(json.into())).await;
                        }
                    }
                }
            }
            Some(Ok(Message::Close(_))) | None => return,
            _ => continue,
        }
    };

    info!(peer = %peer_id, room = %room_id, "WebSocket connection established");

    // ── Phase 2: Spawn writer task (channel → WebSocket) ────────────────
    let write_task = tokio::spawn(async move {
        while let Some(msg) = peer_rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg)
                && ws_sender.send(Message::Text(json.into())).await.is_err()
            {
                break;
            }
        }
    });

    // ── Phase 3: Read loop (WebSocket → route) ──────────────────────────
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(text) => {
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(client_msg) => {
                        route_message(&room_manager, &room_id, &peer_id, client_msg).await;
                    }
                    Err(e) => {
                        warn!(peer = %peer_id, error = %e, "Invalid message from peer");
                    }
                }
            }
            Message::Close(_) => break,
            _ => {} // Ping/pong handled automatically by axum
        }
    }

    // ── Phase 4: Cleanup on disconnect ──────────────────────────────────
    info!(peer = %peer_id, room = %room_id, "WebSocket disconnected");
    room_manager.leave_room(&room_id, &peer_id);
    room_manager
        .broadcast_to_room(
            &room_id,
            &peer_id,
            ServerMessage::PeerLeft {
                peer_id: peer_id.clone(),
            },
        )
        .await;

    write_task.abort();
}

/// Routes a parsed client message to the correct peer.
async fn route_message(
    room_manager: &RoomManager,
    room_id: &RoomId,
    _sender: &PeerId,
    message: ClientMessage,
) {
    match message {
        ClientMessage::Offer { to, from, sdp } => {
            room_manager
                .relay_to_peer(room_id, &to, ServerMessage::Offer { from, sdp })
                .await;
        }
        ClientMessage::Answer { to, from, sdp } => {
            room_manager
                .relay_to_peer(room_id, &to, ServerMessage::Answer { from, sdp })
                .await;
        }
        ClientMessage::Ice {
            to,
            from,
            candidate,
        } => {
            room_manager
                .relay_to_peer(room_id, &to, ServerMessage::Ice { from, candidate })
                .await;
        }
        ClientMessage::Join { .. } => {
            warn!(peer = %_sender, "Duplicate join message ignored");
        }
    }
}
