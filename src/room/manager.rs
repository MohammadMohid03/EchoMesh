use crate::types::{PeerId, RoomId};
use crate::ws::messages::ServerMessage;
use dashmap::DashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{info, warn};

/// Max messages buffered per peer before backpressure kicks in.
const PEER_CHANNEL_CAPACITY: usize = 64;

/// Sender half — used by the room manager to push messages to a peer's WebSocket.
pub type PeerSender = mpsc::Sender<ServerMessage>;

/// Receiver half — held by the WebSocket write task.
pub type PeerReceiver = mpsc::Receiver<ServerMessage>;

/// Manages all active rooms and their connected peers.
///
/// Uses `Arc<DashMap>` internally so that cloning (required by Axum's
/// state extraction) shares the same underlying room registry.
#[derive(Debug, Clone)]
pub struct RoomManager {
    /// room_id → { peer_id → sender_channel }
    rooms: Arc<DashMap<RoomId, DashMap<PeerId, PeerSender>>>,
    /// room_id -> password hash. None means the room is open.
    room_passwords: Arc<DashMap<RoomId, Option<u64>>>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum JoinError {
    MissingPassword,
    InvalidPassword,
    RoomNotFound,
}

impl RoomManager {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
            room_passwords: Arc::new(DashMap::new()),
        }
    }

    /// Register a peer in a room.
    ///
    /// Returns the receiver end of the peer's message channel and
    /// a list of peers already in the room.
    pub fn join_room(
        &self,
        room_id: &RoomId,
        peer_id: &PeerId,
        password: Option<&str>,
        create: bool,
    ) -> Result<(PeerReceiver, Vec<PeerId>), JoinError> {
        self.ensure_password(room_id, password, create)?;

        let (tx, rx) = mpsc::channel(PEER_CHANNEL_CAPACITY);

        // Ensure the room exists (creates if needed, then drops the write lock)
        self.rooms
            .entry(room_id.clone())
            .or_default();

        // Get a read reference to the room (separate lock scope)
        let room = self.rooms.get(room_id).expect("room was just created");

        // Snapshot existing peers before adding the new one
        let existing_peers: Vec<PeerId> = room.iter().map(|entry| entry.key().clone()).collect();

        // Add the new peer
        room.insert(peer_id.clone(), tx);

        // Release the read lock before logging
        drop(room);

        info!(
            room = %room_id,
            peer = %peer_id,
            existing = existing_peers.len(),
            "Peer joined room"
        );

        Ok((rx, existing_peers))
    }

    /// Remove a peer from a room. Cleans up empty rooms automatically.
    pub fn leave_room(&self, room_id: &RoomId, peer_id: &PeerId) {
        if let Some(room) = self.rooms.get(room_id) {
            room.remove(peer_id);
            let remaining = room.len();

            info!(room = %room_id, peer = %peer_id, remaining, "Peer left room");

            if remaining == 0 {
                drop(room); // Release DashMap ref before removing entry
                self.rooms.remove(room_id);
                self.room_passwords.remove(room_id);
                info!(room = %room_id, "Room removed (empty)");
            }
        }
    }

    fn ensure_password(
        &self,
        room_id: &RoomId,
        password: Option<&str>,
        create: bool,
    ) -> Result<(), JoinError> {
        let incoming = normalize_password(password);
        if incoming.is_none() {
            return Err(JoinError::MissingPassword);
        }

        if let Some(stored) = self.room_passwords.get(room_id) {
            return if *stored == incoming {
                Ok(())
            } else {
                Err(JoinError::InvalidPassword)
            };
        }

        if !create {
            return Err(JoinError::RoomNotFound);
        }

        self.room_passwords.insert(room_id.clone(), incoming);
        Ok(())
    }

    /// Send a message to a specific peer in a room.
    ///
    /// Uses `try_send` (non-blocking) — if the peer's channel is full,
    /// the message is dropped and a warning is logged (backpressure).
    pub async fn relay_to_peer(
        &self,
        room_id: &RoomId,
        target_peer: &PeerId,
        message: ServerMessage,
    ) {
        if let Some(room) = self.rooms.get(room_id) {
            if let Some(sender) = room.get(target_peer) {
                if let Err(e) = sender.try_send(message) {
                    warn!(
                        room = %room_id,
                        peer = %target_peer,
                        error = %e,
                        "Failed to relay to peer (channel full or closed)"
                    );
                }
            } else {
                warn!(room = %room_id, peer = %target_peer, "Target peer not found in room");
            }
        }
    }

    /// Broadcast a message to all peers in a room except the sender.
    pub async fn broadcast_to_room(
        &self,
        room_id: &RoomId,
        exclude_peer: &PeerId,
        message: ServerMessage,
    ) {
        if let Some(room) = self.rooms.get(room_id) {
            for entry in room.iter() {
                if entry.key() != exclude_peer
                    && let Err(e) = entry.value().try_send(message.clone())
                {
                    warn!(
                        room = %room_id,
                        peer = %entry.key(),
                        error = %e,
                        "Failed to broadcast to peer"
                    );
                }
            }
        }
    }
}

fn normalize_password(password: Option<&str>) -> Option<u64> {
    let trimmed = password?.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut hasher = DefaultHasher::new();
    trimmed.hash(&mut hasher);
    Some(hasher.finish())
}
