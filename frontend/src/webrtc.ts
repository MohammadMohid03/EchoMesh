// ── Event type map ──────────────────────────────────────────────────

export type PeerEventMap = {
  peer_connected: (peerId: string) => void;
  peer_disconnected: (peerId: string) => void;
  message: (peerId: string, data: string | ArrayBuffer) => void;
};

interface PeerEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  connected: boolean;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

/**
 * Manages WebRTC PeerConnections and DataChannels for all remote peers.
 *
 * Full-mesh topology: one RTCPeerConnection per remote peer.
 * The **new** peer (who receives peer_list) creates offers to all
 * existing peers. Existing peers just wait for incoming offers.
 */
export class PeerManager {
  private peers = new Map<string, PeerEntry>();
  public readonly localId: string;
  private listeners: Partial<{
    [K in keyof PeerEventMap]: PeerEventMap[K][];
  }> = {};

  /** Set by the app to relay signaling messages. */
  public onSendOffer: ((to: string, sdp: string) => void) | null = null;
  public onSendAnswer: ((to: string, sdp: string) => void) | null = null;
  public onSendIce: ((to: string, candidate: string) => void) | null = null;

  constructor(localPeerId: string) {
    this.localId = localPeerId;
  }

  on<K extends keyof PeerEventMap>(event: K, cb: PeerEventMap[K]): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(cb);
  }

  private emit<K extends keyof PeerEventMap>(
    event: K,
    ...args: Parameters<PeerEventMap[K]>
  ): void {
    const cbs = this.listeners[event];
    if (cbs) for (const cb of cbs) (cb as Function)(...args);
  }

  // ── Offer / Answer / ICE handlers ───────────────────────────────────

  /**
   * We are the new peer — create an offer to an existing peer.
   * Only the offerer creates the DataChannel.
   */
  async createOffer(remotePeerId: string): Promise<void> {
    console.log(`[WebRTC] Creating offer → ${remotePeerId}`);
    const pc = this.makePeerConnection(remotePeerId);

    const dc = pc.createDataChannel('echomesh', { ordered: true });
    this.wireDataChannel(remotePeerId, dc);
    this.peers.get(remotePeerId)!.dc = dc;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.onSendOffer?.(remotePeerId, JSON.stringify(pc.localDescription));
  }

  /** Handle incoming offer and respond with an answer. */
  async handleOffer(from: string, sdp: string): Promise<void> {
    console.log(`[WebRTC] Offer from ${from}`);
    const pc = this.makePeerConnection(from);

    const desc = JSON.parse(sdp) as RTCSessionDescriptionInit;
    await pc.setRemoteDescription(new RTCSessionDescription(desc));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.onSendAnswer?.(from, JSON.stringify(pc.localDescription));
  }

  /** Handle incoming answer to our earlier offer. */
  async handleAnswer(from: string, sdp: string): Promise<void> {
    console.log(`[WebRTC] Answer from ${from}`);
    const peer = this.peers.get(from);
    if (!peer) return;

    const desc = JSON.parse(sdp) as RTCSessionDescriptionInit;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(desc));
  }

  /** Handle incoming ICE candidate. */
  async handleIce(from: string, candidate: string): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;

    const ice = JSON.parse(candidate) as RTCIceCandidateInit;
    await peer.pc.addIceCandidate(new RTCIceCandidate(ice));
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private makePeerConnection(remotePeerId: string): RTCPeerConnection {
    const existing = this.peers.get(remotePeerId);
    if (existing) existing.pc.close();

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers.set(remotePeerId, { pc, dc: null, connected: false });

    // Trickle ICE
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.onSendIce?.(remotePeerId, JSON.stringify(e.candidate));
      }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WebRTC] ${remotePeerId} → ${state}`);

      if (state === 'connected') {
        const p = this.peers.get(remotePeerId);
        if (p) p.connected = true;
        this.emit('peer_connected', remotePeerId);
      } else if (
        state === 'disconnected' ||
        state === 'failed' ||
        state === 'closed'
      ) {
        this.removePeer(remotePeerId);
      }
    };

    // Answerer receives DataChannel here
    pc.ondatachannel = (e) => {
      console.log(`[WebRTC] DataChannel received from ${remotePeerId}`);
      const p = this.peers.get(remotePeerId);
      if (p) {
        p.dc = e.channel;
        this.wireDataChannel(remotePeerId, e.channel);
      }
    };

    return pc;
  }

  private wireDataChannel(peerId: string, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => console.log(`[WebRTC] DC open: ${peerId}`);
    dc.onclose = () => console.log(`[WebRTC] DC closed: ${peerId}`);
    dc.onerror = (e) => console.error(`[WebRTC] DC error: ${peerId}`, e);
    dc.onmessage = (e) => this.emit('message', peerId, e.data);
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Send data to one peer. Returns false if channel isn't open. */
  sendTo(peerId: string, data: string | ArrayBuffer): boolean {
    const p = this.peers.get(peerId);
    if (p?.dc?.readyState === 'open') {
      p.dc.send(data as string);
      return true;
    }
    return false;
  }

  /** Broadcast data to all peers with open DataChannels. */
  broadcast(data: string | ArrayBuffer): void {
    for (const [, peer] of this.peers) {
      if (peer.dc?.readyState === 'open') peer.dc.send(data as string);
    }
  }

  /** Clean up a peer connection. */
  removePeer(peerId: string): void {
    const p = this.peers.get(peerId);
    if (p) {
      p.dc?.close();
      p.pc.close();
      this.peers.delete(peerId);
      this.emit('peer_disconnected', peerId);
    }
  }

  /** List of connected peer IDs. */
  getConnectedPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.connected)
      .map(([id]) => id);
  }

  /** Get the DataChannel buffered amount for a specific peer. */
  getBufferedAmount(peerId: string): number {
    const p = this.peers.get(peerId);
    return p?.dc?.bufferedAmount ?? 0;
  }

  /** Tear down everything. */
  destroy(): void {
    for (const [id] of this.peers) this.removePeer(id);
  }
}
