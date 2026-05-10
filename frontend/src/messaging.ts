import { PeerManager } from './webrtc';
import {
  MsgType,
  type MsgTypeValue,
  type AwarenessState,
  type ChatPayload,
} from './types';

// ── Encoder / Decoder ───────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode a typed message into a binary envelope.
 *
 * Wire format: [ msgType (1 byte) | payload (N bytes) ]
 * - Sync:      payload is raw Uint8Array
 * - Awareness: payload is UTF-8 JSON
 * - Chat:      payload is UTF-8 JSON
 */
export function encode(type: typeof MsgType.Sync, payload: Uint8Array): ArrayBuffer;
export function encode(type: typeof MsgType.Awareness, payload: AwarenessState): ArrayBuffer;
export function encode(type: typeof MsgType.Chat, payload: ChatPayload): ArrayBuffer;
export function encode(type: typeof MsgType.File, payload: Uint8Array): ArrayBuffer;
export function encode(type: MsgTypeValue, payload: unknown): ArrayBuffer {
  let body: Uint8Array;

  if (type === MsgType.Sync || type === MsgType.File) {
    body = payload as Uint8Array;
  } else {
    body = encoder.encode(JSON.stringify(payload));
  }

  const buf = new Uint8Array(1 + body.byteLength);
  buf[0] = type;
  buf.set(body, 1);
  return buf.buffer;
}

/** Decoded message from the wire. */
export type DecodedMessage =
  | { type: typeof MsgType.Sync; payload: Uint8Array }
  | { type: typeof MsgType.Awareness; payload: AwarenessState }
  | { type: typeof MsgType.Chat; payload: ChatPayload }
  | { type: typeof MsgType.File; payload: Uint8Array };

/** Decode a binary envelope back into a typed message. */
export function decode(data: ArrayBuffer): DecodedMessage | null {
  const buf = new Uint8Array(data);
  if (buf.byteLength < 1) return null;

  const type = buf[0] as MsgTypeValue;
  const body = buf.subarray(1);

  switch (type) {
    case MsgType.Sync:
      return { type, payload: body };
    case MsgType.Awareness:
      return { type, payload: JSON.parse(decoder.decode(body)) };
    case MsgType.Chat:
      return { type, payload: JSON.parse(decoder.decode(body)) };
    case MsgType.File:
      return { type, payload: body };
    default:
      console.warn('[Messaging] Unknown message type:', type);
      return null;
  }
}

// ── Messaging Layer ─────────────────────────────────────────────────

export type MessagingEvents = {
  chat: (peerId: string, msg: ChatPayload) => void;
  awareness: (peerId: string, state: AwarenessState) => void;
  sync: (peerId: string, data: Uint8Array) => void;
  file: (peerId: string, data: Uint8Array) => void;
};

/**
 * High-level messaging layer on top of PeerManager.
 *
 * Handles:
 * - Binary message encoding/decoding
 * - Message type dispatching
 * - User awareness broadcasting
 * - Chat message sending
 */
export class MessagingLayer {
  private pm: PeerManager;
  private listeners: Partial<{
    [K in keyof MessagingEvents]: MessagingEvents[K][];
  }> = {};

  /** Public access to the underlying PeerManager (used by editor). */
  get peerManager(): PeerManager {
    return this.pm;
  }

  /** Map of peer ID → latest awareness state. */
  public awareness = new Map<string, AwarenessState>();

  /** Our own awareness state. */
  public localAwareness: AwarenessState;

  private awarenessInterval: ReturnType<typeof setInterval> | null = null;

  constructor(peerManager: PeerManager, localName: string, localColor: string) {
    this.pm = peerManager;
    this.localAwareness = {
      name: localName,
      color: localColor,
      lastActive: new Date().toISOString(),
    };

    // Listen for raw DataChannel messages and decode them
    this.pm.on('message', (peerId, data) => {
      if (data instanceof ArrayBuffer) {
        const msg = decode(data);
        if (!msg) return;

        switch (msg.type) {
          case MsgType.Chat:
            this.emit('chat', peerId, msg.payload);
            break;
          case MsgType.Awareness:
            this.awareness.set(peerId, msg.payload);
            this.emit('awareness', peerId, msg.payload);
            break;
          case MsgType.Sync:
            this.emit('sync', peerId, msg.payload);
            break;
          case MsgType.File:
            this.emit('file', peerId, msg.payload);
            break;
        }
      } else if (typeof data === 'string') {
        // Backward compat: handle old JSON chat messages
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'chat') {
            this.emit('chat', peerId, {
              text: parsed.text,
              ts: new Date().toISOString(),
            });
          }
        } catch { /* ignore */ }
      }
    });

    // When a new peer connects, send our awareness state
    this.pm.on('peer_connected', (peerId) => {
      this.sendAwarenessTo(peerId);
    });

    // Clean up awareness when peer disconnects
    this.pm.on('peer_disconnected', (peerId) => {
      this.awareness.delete(peerId);
    });
  }

  on<K extends keyof MessagingEvents>(event: K, cb: MessagingEvents[K]): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(cb);
  }

  private emit<K extends keyof MessagingEvents>(
    event: K,
    ...args: Parameters<MessagingEvents[K]>
  ): void {
    const cbs = this.listeners[event];
    if (cbs) for (const cb of cbs) (cb as Function)(...args);
  }

  // ── Chat ────────────────────────────────────────────────────────────

  /** Broadcast a chat message to all peers. */
  sendChat(text: string): void {
    const payload: ChatPayload = { text, ts: new Date().toISOString() };
    this.pm.broadcast(encode(MsgType.Chat, payload));
  }

  // ── Awareness ───────────────────────────────────────────────────────

  /** Send our awareness state to a specific peer. */
  private sendAwarenessTo(peerId: string): void {
    this.localAwareness.lastActive = new Date().toISOString();
    this.pm.sendTo(peerId, encode(MsgType.Awareness, this.localAwareness));
  }

  /** Broadcast our awareness state to all peers. */
  broadcastAwareness(): void {
    this.localAwareness.lastActive = new Date().toISOString();
    this.pm.broadcast(encode(MsgType.Awareness, this.localAwareness));
  }

  /** Start periodic awareness broadcasts (heartbeat). */
  startAwareness(intervalMs = 5000): void {
    this.stopAwareness();
    this.broadcastAwareness();
    this.awarenessInterval = setInterval(() => {
      this.broadcastAwareness();
    }, intervalMs);
  }

  /** Stop periodic awareness broadcasts. */
  stopAwareness(): void {
    if (this.awarenessInterval) {
      clearInterval(this.awarenessInterval);
      this.awarenessInterval = null;
    }
  }

  // ── Sync (for CRDT — used in Phase 4-5) ─────────────────────────────

  /** Broadcast a binary sync update to all peers. */
  sendSync(data: Uint8Array): void {
    this.pm.broadcast(encode(MsgType.Sync, data));
  }

  /** Send a binary sync update to a specific peer. */
  sendSyncTo(peerId: string, data: Uint8Array): void {
    this.pm.sendTo(peerId, encode(MsgType.Sync, data));
  }

  // ── File (for file sharing — Phase 6) ──────────────────────────────

  /** Broadcast a file chunk/meta to all peers. */
  sendFile(data: Uint8Array): void {
    this.pm.broadcast(encode(MsgType.File, data));
  }

  /** Send a file chunk/meta to a specific peer. */
  sendFileTo(peerId: string, data: Uint8Array): void {
    this.pm.sendTo(peerId, encode(MsgType.File, data));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Get all known peer awareness states. */
  getPeerStates(): Map<string, AwarenessState> {
    return new Map(this.awareness);
  }

  /** Clean up resources. */
  destroy(): void {
    this.stopAwareness();
    this.awareness.clear();
  }
}
