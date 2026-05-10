use crate::types::PeerId;
use serde::{Deserialize, Serialize};

/// Messages sent from a client to the signaling server.
///
/// Uses serde's internally-tagged representation for clean JSON:
/// `{ "type": "join", "room": "...", "peer_id": "..." }`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Join a named room. Must be the first message sent.
    Join {
        room: String,
        peer_id: PeerId,
    },

    /// Forward a WebRTC SDP offer to a specific peer.
    Offer {
        to: PeerId,
        from: PeerId,
        sdp: String,
    },

    /// Forward a WebRTC SDP answer to a specific peer.
    Answer {
        to: PeerId,
        from: PeerId,
        sdp: String,
    },

    /// Forward an ICE candidate to a specific peer.
    Ice {
        to: PeerId,
        from: PeerId,
        candidate: String,
    },
}

/// Messages sent from the signaling server to clients.
///
/// Same tagged format: `{ "type": "peer_joined", "peer_id": "..." }`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent to existing peers when a new peer joins.
    PeerJoined { peer_id: PeerId },

    /// Sent when a peer disconnects.
    PeerLeft { peer_id: PeerId },

    /// Sent to a newly joined peer listing all existing peers in the room.
    PeerList { peers: Vec<PeerId> },

    /// Forwarded SDP offer from another peer.
    Offer { from: PeerId, sdp: String },

    /// Forwarded SDP answer from another peer.
    Answer { from: PeerId, sdp: String },

    /// Forwarded ICE candidate from another peer.
    Ice { from: PeerId, candidate: String },

    /// Error from the server.
    Error { message: String },
}
