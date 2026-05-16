// ── Event type map ──────────────────────────────────────────────────

export type PeerEventMap = {
  peer_connected: (peerId: string) => void;
  peer_disconnected: (peerId: string) => void;
  message: (peerId: string, data: string | ArrayBuffer) => void;
};

interface PeerEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  fileDcs: RTCDataChannel[];
  connected: boolean;
}

const FILE_CHANNEL_LABEL = 'echomesh-file';
const FILE_LANE_COUNT = 1;
const DATA_CHANNEL_LOW_WATER = 256 * 1024;

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

    const peer = this.peers.get(remotePeerId)!;
    for (let lane = 0; lane < FILE_LANE_COUNT; lane++) {
      const fileDc = pc.createDataChannel(this.fileChannelLabel(lane), { ordered: true });
      this.wireDataChannel(remotePeerId, fileDc);
      peer.fileDcs[lane] = fileDc;
    }

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
    this.peers.set(remotePeerId, { pc, dc: null, fileDcs: [], connected: false });

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
        const wasConnected = p?.connected ?? false;
        if (p) p.connected = true;
        if (!wasConnected) this.emit('peer_connected', remotePeerId);
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
        const lane = this.fileChannelLane(e.channel.label);
        if (lane !== null) {
          p.fileDcs[lane] = e.channel;
        } else {
          p.dc = e.channel;
        }
        this.wireDataChannel(remotePeerId, e.channel);
      }
    };

    return pc;
  }

  private wireDataChannel(peerId: string, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER;
    dc.onopen = () => {
      const p = this.peers.get(peerId);
      const wasConnected = p?.connected ?? false;
      if (p) p.connected = true;
      if (!wasConnected) this.emit('peer_connected', peerId);
      console.log(`[WebRTC] DC open: ${peerId}/${dc.label}`);
    };
    dc.onclose = () => console.log(`[WebRTC] DC closed: ${peerId}/${dc.label}`);
    dc.onerror = (e) => console.error(`[WebRTC] DC error: ${peerId}/${dc.label}`, e);
    dc.onmessage = (e) => this.emit('message', peerId, e.data);
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Send data to one peer. Returns false if channel isn't open. */
  sendTo(peerId: string, data: string | ArrayBuffer): boolean {
    const p = this.peers.get(peerId);
    return this.sendOnChannel(p?.dc ?? null, data);
  }

  /** Broadcast data to all peers with open DataChannels. */
  broadcast(data: string | ArrayBuffer): void {
    for (const [, peer] of this.peers) {
      this.sendOnChannel(peer.dc, data);
    }
  }

  /** Send file data on the dedicated high-throughput file channel when available. */
  sendFileTo(peerId: string, data: string | ArrayBuffer, lane = 0): boolean {
    const p = this.peers.get(peerId);
    return this.sendOnChannel(this.getFileChannel(p, lane), data);
  }

  /** Broadcast file data without blocking the ordered control channel. */
  broadcastFile(data: string | ArrayBuffer, lane = 0): string[] {
    const sentTo: string[] = [];
    for (const [peerId, peer] of this.peers) {
      if (this.sendOnChannel(this.getFileChannel(peer, lane), data)) {
        sentTo.push(peerId);
      }
    }
    return sentTo;
  }

  /** Clean up a peer connection. */
  removePeer(peerId: string): void {
    const p = this.peers.get(peerId);
    if (p) {
      p.dc?.close();
      for (const dc of p.fileDcs) dc?.close();
      p.pc.close();
      this.peers.delete(peerId);
      this.emit('peer_disconnected', peerId);
    }
  }

  /** List of connected peer IDs. */
  getConnectedPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.connected || this.hasOpenChannel(p))
      .map(([id]) => id);
  }

  /** List peers that have at least one open file lane. */
  getFileReadyPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => this.getOpenFileChannels(p).length > 0)
      .map(([id]) => id);
  }

  /** Get the DataChannel buffered amount for a specific peer. */
  getBufferedAmount(peerId: string): number {
    const p = this.peers.get(peerId);
    return p?.dc?.bufferedAmount ?? 0;
  }

  /** Get the file channel buffered amount, falling back to control channel if needed. */
  getFileBufferedAmount(peerId: string, lane = 0): number {
    const p = this.peers.get(peerId);
    return this.getFileChannel(p, lane)?.bufferedAmount ?? 0;
  }

  /** Wait for a peer's file channel buffer to drain below a threshold. */
  async waitForFileBufferedAmountBelow(peerId: string, threshold: number, lane = 0): Promise<void> {
    const p = this.peers.get(peerId);
    const dc = this.getFileChannel(p, lane);
    if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= threshold) return;

    dc.bufferedAmountLowThreshold = threshold;

    await new Promise<void>((resolve) => {
      const previous = dc.onbufferedamountlow;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        dc.onbufferedamountlow = previous;
        resolve();
      };

      const timer = setInterval(() => {
        if (dc.readyState !== 'open' || dc.bufferedAmount <= threshold) finish();
      }, 16);

      dc.onbufferedamountlow = (event) => {
        if (typeof previous === 'function') previous.call(dc, event);
        finish();
      };
    });
  }

  /** Tear down everything. */
  destroy(): void {
    for (const [id] of this.peers) this.removePeer(id);
  }

  getFileLaneCount(peerId?: string): number {
    if (!peerId) return FILE_LANE_COUNT;
    const p = this.peers.get(peerId);
    return Math.max(1, this.getOpenFileChannels(p).length);
  }

  private getFileChannel(peer: PeerEntry | undefined, lane = 0): RTCDataChannel | null {
    if (!peer) return null;
    const fileDcs = this.getOpenFileChannels(peer);
    if (fileDcs.length > 0) return fileDcs[lane % fileDcs.length];
    if (peer?.dc?.readyState === 'open') return peer.dc;
    return null;
  }

  private getOpenFileChannels(peer: PeerEntry | undefined): RTCDataChannel[] {
    return peer?.fileDcs.filter(dc => dc?.readyState === 'open') ?? [];
  }

  private hasOpenChannel(peer: PeerEntry): boolean {
    return peer.dc?.readyState === 'open' || this.getOpenFileChannels(peer).length > 0;
  }

  private fileChannelLabel(lane: number): string {
    return `${FILE_CHANNEL_LABEL}-${lane}`;
  }

  private fileChannelLane(label: string): number | null {
    if (label === FILE_CHANNEL_LABEL) return 0;
    if (!label.startsWith(`${FILE_CHANNEL_LABEL}-`)) return null;
    const lane = Number(label.slice(FILE_CHANNEL_LABEL.length + 1));
    return Number.isInteger(lane) && lane >= 0 && lane < FILE_LANE_COUNT ? lane : null;
  }

  private sendOnChannel(dc: RTCDataChannel | null, data: string | ArrayBuffer): boolean {
    if (dc?.readyState !== 'open') return false;
    try {
      if (typeof data === 'string') {
        dc.send(data);
      } else {
        dc.send(data);
      }
      return true;
    } catch (error) {
      console.error(`[WebRTC] send failed on ${dc.label}`, error);
      return false;
    }
  }
}
