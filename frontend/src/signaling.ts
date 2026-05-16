import type { ServerMessage } from './types';

// ── Event type map ──────────────────────────────────────────────────

export type SignalingEventMap = {
  peer_list: (peers: string[]) => void;
  peer_joined: (peerId: string) => void;
  peer_left: (peerId: string) => void;
  offer: (from: string, sdp: string) => void;
  answer: (from: string, sdp: string) => void;
  ice: (from: string, candidate: string) => void;
  connected: () => void;
  disconnected: () => void;
  error: (message: string) => void;
};

/**
 * WebSocket client for the EchoMesh signaling server.
 *
 * Handles room join, peer discovery, and SDP/ICE relay.
 * Auto-reconnects on disconnect (unless explicitly closed).
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private peerId: string;
  private roomId = '';
  private roomPassword = '';
  private listeners: Partial<{
    [K in keyof SignalingEventMap]: SignalingEventMap[K][];
  }> = {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private pendingJoin: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(url: string, peerId: string) {
    this.url = url;
    this.peerId = peerId;
  }

  /** Register an event listener. */
  on<K extends keyof SignalingEventMap>(
    event: K,
    callback: SignalingEventMap[K],
  ): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(callback);
  }

  private emit<K extends keyof SignalingEventMap>(
    event: K,
    ...args: Parameters<SignalingEventMap[K]>
  ): void {
    const cbs = this.listeners[event];
    if (cbs) for (const cb of cbs) (cb as Function)(...args);
  }

  /** Connect to the signaling server. Resolves when WS is open. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('[Signaling] Connected');
        this.emit('connected');
        resolve();
      };

      this.ws.onclose = () => {
        console.log('[Signaling] Disconnected');
        this.emit('disconnected');
        if (this.shouldReconnect) this.scheduleReconnect();
      };

      this.ws.onerror = (e) => {
        console.error('[Signaling] Error:', e);
        reject(e);
      };

      this.ws.onmessage = (e) => this.handleMessage(e.data);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as ServerMessage;
      switch (msg.type) {
        case 'peer_list':
          this.emit('peer_list', msg.peers);
          this.pendingJoin?.resolve();
          this.pendingJoin = null;
          break;
        case 'peer_joined':
          this.emit('peer_joined', msg.peer_id);
          break;
        case 'peer_left':
          this.emit('peer_left', msg.peer_id);
          break;
        case 'offer':
          this.emit('offer', msg.from, msg.sdp);
          break;
        case 'answer':
          this.emit('answer', msg.from, msg.sdp);
          break;
        case 'ice':
          this.emit('ice', msg.from, msg.candidate);
          break;
        case 'error':
          console.error('[Signaling] Server error:', msg.message);
          this.emit('error', msg.message);
          this.pendingJoin?.reject(new Error(msg.message));
          this.pendingJoin = null;
          break;
      }
    } catch (e) {
      console.error('[Signaling] Parse error:', e);
    }
  }

  /** Join a named room. Must be called after connect(). */
  joinRoom(roomId: string, password = '', create = false): Promise<void> {
    this.roomId = roomId;
    this.roomPassword = password;
    return new Promise((resolve, reject) => {
      this.pendingJoin = { resolve, reject };
      this.send({
        type: 'join',
        room: roomId,
        peer_id: this.peerId,
        password: this.roomPassword.trim() || null,
        create,
      });
    });
  }

  sendOffer(to: string, sdp: string): void {
    this.send({ type: 'offer', to, from: this.peerId, sdp });
  }

  sendAnswer(to: string, sdp: string): void {
    this.send({ type: 'answer', to, from: this.peerId, sdp });
  }

  sendIce(to: string, candidate: string): void {
    this.send({ type: 'ice', to, from: this.peerId, candidate });
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        if (this.roomId) void this.joinRoom(this.roomId, this.roomPassword);
      } catch {
        this.scheduleReconnect();
      }
    }, 3000);
  }

  /** Disconnect and stop auto-reconnect. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  get id(): string {
    return this.peerId;
  }
}
