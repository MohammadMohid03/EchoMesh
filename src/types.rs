use serde::{Deserialize, Serialize};
use std::fmt;

/// Unique identifier for a peer connection.
#[derive(Debug, Clone, Hash, Eq, PartialEq, Serialize, Deserialize)]
pub struct PeerId(pub String);

/// Unique identifier for a collaboration room.
#[derive(Debug, Clone, Hash, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoomId(pub String);

impl fmt::Display for PeerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl fmt::Display for RoomId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl PeerId {
    /// Generate a new random peer ID.
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}
