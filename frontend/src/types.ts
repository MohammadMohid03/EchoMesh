// ── Server → Client messages ────────────────────────────────────────

export interface PeerListMessage {
  type: 'peer_list';
  peers: string[];
}

export interface PeerJoinedMessage {
  type: 'peer_joined';
  peer_id: string;
}

export interface PeerLeftMessage {
  type: 'peer_left';
  peer_id: string;
}

export interface OfferFromServer {
  type: 'offer';
  from: string;
  sdp: string;
}

export interface AnswerFromServer {
  type: 'answer';
  from: string;
  sdp: string;
}

export interface IceFromServer {
  type: 'ice';
  from: string;
  candidate: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | PeerListMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | OfferFromServer
  | AnswerFromServer
  | IceFromServer
  | ErrorMessage;

// ── Data Channel message types ──────────────────────────────────────

/**
 * Binary protocol: first byte = message type, rest = payload.
 * This lets us multiplex sync (binary), awareness (JSON), and chat (JSON)
 * over a single DataChannel.
 */
export const MsgType = {
  /** Yjs CRDT document sync — binary payload (Uint8Array) */
  Sync: 0,
  /** User awareness/presence — JSON payload */
  Awareness: 1,
  /** Chat message — JSON payload */
  Chat: 2,
  /** File transfer — binary payload (chunked) */
  File: 3,
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

/** User awareness state broadcast to all peers. */
export interface AwarenessState {
  name: string;
  color: string;
  /** ISO timestamp of last activity */
  lastActive: string;
}

/** Chat message payload (inside the binary envelope). */
export interface ChatPayload {
  text: string;
  /** ISO timestamp */
  ts: string;
}

/** Pre-defined user colors for the awareness palette. */
export const USER_COLORS = [
  '#6c5ce7', '#00cec9', '#e17055', '#00b894',
  '#fdcb6e', '#e84393', '#0984e3', '#55efc4',
  '#fab1a0', '#74b9ff', '#a29bfe', '#ffeaa7',
] as const;

/** Pick a deterministic color from a peer ID. */
export function colorForPeer(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

