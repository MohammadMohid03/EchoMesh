import { MessagingLayer } from './messaging';
import { MsgType } from './types';

// ── File transfer sub-types within MsgType.File ─────────────────────
const FILE_META = 0;    // File metadata: { name, size, totalChunks, id }
const FILE_CHUNK = 1;   // File chunk:    [FILE_CHUNK][index 4B][id 8B][data]
const FILE_ACK = 2;     // Receiver confirmation: { id, ok, size, error? }
const FILE_ERROR = 3;   // Receiver-side failure: { id, error }

// ── Tuned for LAN speed — streaming approach ────────────────────────
// The sender reads 16 MB blocks from disk asynchronously, then slices them
// synchronously into network chunks in RAM. Keep chunks well below common
// WebRTC max-message limits after the app envelope/header bytes are added.
const CHUNK_SIZE = 32 * 1024;                     // 32 KB payload, conservative for WebRTC/WebView
const LARGE_CHUNK_SIZE = 8 * 1024 * 1024;         // 8 MB per disk read
const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024;     // 1 GB limit

// Back-pressure: pause sending when the DataChannel buffer exceeds
// this threshold so we don't overwhelm the SCTP layer.
const BUFFER_HIGH_WATER = 768 * 1024;
const BUFFER_DRAIN_WATER = 256 * 1024;

// How often to update the UI during large transfers (every N chunks)
const UI_UPDATE_INTERVAL = 16;
const DRAIN_CHECK_INTERVAL = 1;
const EVENT_LOOP_YIELD_INTERVAL = 16;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).substring(2, 10);
}

function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

export interface FileTransfer {
  id: string;
  name: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
  receivedChunks: (Blob | undefined)[];  // Sparse array — browser can swap Blob parts to disk
  receivedCount: number;
  progress: number;          // 0 to 1
  done: boolean;
  blob?: Blob;
  from: string;
  startTime?: number;
}

type FileEventHandler = (transfer: FileTransfer) => void;

interface OutgoingTransfer {
  id: string;
  name: string;
  size: number;
  totalChunks: number;
  itemEl: HTMLElement;
  startTime: number;
  peers: Set<string>;
  ackedPeers: Set<string>;
  failedPeers: Map<string, string>;
  resolveAck?: () => void;
}

/**
 * High-speed file sharing over WebRTC DataChannels.
 *
 * Optimised for LAN transfers up to 1 GB:
 *  - Streaming reads: file.slice() reads chunks from disk (no full-file buffer)
 *  - 32 KB chunks over a reliable ordered file channel
 *  - Back-pressure via bufferedAmount checks
 *  - Receiver stores chunks as Blob parts (lower memory than Uint8Array map)
 *  - Live speed + ETA display
 */
export class FileSharer {
  private messaging: MessagingLayer;
  private incoming = new Map<string, FileTransfer>();
  private outgoing = new Map<string, OutgoingTransfer>();
  private pendingChunks = new Map<string, { index: number; data: Uint8Array }[]>();
  private onProgress: FileEventHandler;
  private onComplete: FileEventHandler;
  private listEl: HTMLElement | null = null;

  constructor(
    messaging: MessagingLayer,
    onProgress: FileEventHandler,
    onComplete: FileEventHandler,
  ) {
    this.messaging = messaging;
    this.onProgress = onProgress;
    this.onComplete = onComplete;

    // Listen for incoming file messages
    this.messaging.on('file', (peerId, data) => {
      this.handleFileMessage(peerId, data);
    });
  }

  /** Mount the file sharing UI into a container. */
  mount(container: HTMLElement): void {
    container.innerHTML = '';

    // Drop zone
    const dropZone = document.createElement('div');
    dropZone.className = 'fs-dropzone';
    dropZone.innerHTML = `
      <div class="fs-drop-content">
        <span class="fs-drop-icon">📁</span>
        <span class="fs-drop-text">Drop files here or click to select</span>
        <span class="fs-drop-hint">Max 1 GB per file • LAN optimised</span>
      </div>
      <input type="file" class="fs-file-input" multiple />
    `;
    container.appendChild(dropZone);

    // File list
    this.listEl = document.createElement('div');
    this.listEl.className = 'fs-list';
    container.appendChild(this.listEl);

    // Wire events
    const fileInput = dropZone.querySelector('.fs-file-input') as HTMLInputElement;

    fileInput.addEventListener('click', (e) => e.stopPropagation());
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer?.files) {
        this.sendFiles(e.dataTransfer.files);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files) {
        this.sendFiles(fileInput.files);
        fileInput.value = '';
      }
    });
  }

  /** Send files to all connected peers. */
  async sendFiles(files: FileList): Promise<void> {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE) {
        this.addFileItem(`⚠️ ${file.name} exceeds 1 GB limit`, 'error');
        continue;
      }
      if (file.size === 0) {
        this.addFileItem(`⚠️ ${file.name} is empty`, 'error');
        continue;
      }
      try {
        await this.sendFile(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'transfer failed';
        this.addFileItem(`${file.name}: ${message}`, 'error');
      }
    }
  }

  /**
   * Send a file using a double-loop design.
   * Reads 16MB blocks from disk asynchronously, then synchronously slices them
   * into WebRTC packets in RAM. This avoids per-packet disk reads.
   */
  private async sendFile(file: File): Promise<void> {
    const id = generateId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const startTime = performance.now();
    const peers = await this.waitForFileReadyPeers();

    if (peers.length === 0) {
      this.addFileItem(`No connected peers for ${file.name}`, 'error');
      return;
    }

    // Send metadata first
    const meta = { id, name: file.name, size: file.size, totalChunks, chunkSize: CHUNK_SIZE };
    const metaBytes = textEncoder.encode(JSON.stringify(meta));
    const metaMsg = new Uint8Array(1 + metaBytes.length);
    metaMsg[0] = FILE_META;
    metaMsg.set(metaBytes, 1);

    // Show in UI
    const itemEl = this.addFileItem(
      `📤 ${file.name} (${formatSize(file.size)})`,
      'sending', id,
    );

    const transfer: OutgoingTransfer = {
      id,
      name: file.name,
      size: file.size,
      totalChunks,
      itemEl,
      startTime,
      peers: new Set(peers),
      ackedPeers: new Set(),
      failedPeers: new Map(),
    };
    this.outgoing.set(id, transfer);

    const openedPeers = this.messaging.sendFile(metaMsg);
    transfer.peers = new Set(openedPeers.filter(peerId => transfer.peers.has(peerId)));
    if (transfer.peers.size === 0) {
      this.outgoing.delete(id);
      this.updateProgress(itemEl, 0, `Could not start ${file.name}: file channel is not open`);
      return;
    }

    // Pre-encode the file ID once (always 8 bytes)
    const idBytes = textEncoder.encode(id);

    let globalChunkIndex = 0;

    // Outer loop: Read massive blocks from disk
    for (let diskStart = 0; diskStart < file.size; diskStart += LARGE_CHUNK_SIZE) {
      const diskEnd = Math.min(diskStart + LARGE_CHUNK_SIZE, file.size);
      
      // Single async disk read per large block
      const slice = file.slice(diskStart, diskEnd);
      const largeBuf = await slice.arrayBuffer();
      const largeArray = new Uint8Array(largeBuf);

      // Inner loop: synchronously send DataChannel chunks from memory.
      for (let memStart = 0; memStart < largeArray.byteLength; memStart += CHUNK_SIZE) {
        const memEnd = Math.min(memStart + CHUNK_SIZE, largeArray.byteLength);
        const chunk = largeArray.subarray(memStart, memEnd); // Zero-copy view

        // Build the final DataChannel packet directly:
        // [MsgType.File][FILE_CHUNK][index 4B][id 8B][data]
        const packet = this.createChunkPacket(globalChunkIndex, idBytes, chunk);
        const lane = globalChunkIndex % this.messaging.peerManager.getFileLaneCount();

        // Back-pressure: checking in small batches keeps the hot path fast.
        if (globalChunkIndex % DRAIN_CHECK_INTERVAL === 0) {
          await this.waitForDrain([...transfer.peers], lane);
        }

        for (const peerId of transfer.peers) {
          if (transfer.failedPeers.has(peerId)) continue;
          if (!this.messaging.sendPreparedFileTo(peerId, packet, lane) && !transfer.failedPeers.has(peerId)) {
            transfer.failedPeers.set(peerId, 'file channel closed');
          }
        }

        if (this.hasAllReceiverAcks(transfer)) break;

        // Update progress + speed (throttled for large files)
        if (globalChunkIndex % UI_UPDATE_INTERVAL === 0 || globalChunkIndex === totalChunks - 1) {
          const progress = (globalChunkIndex + 1) / totalChunks;
          const elapsed = (performance.now() - startTime) / 1000;
          const bytesSent = diskStart + memEnd;
          const speed = elapsed > 0 ? bytesSent / elapsed : 0;
          const eta = speed > 0 ? (file.size - bytesSent) / speed : 0;
          const info = `${formatSpeed(speed)} • ${formatEta(eta)}`;
          this.updateProgress(itemEl, progress, undefined, info);
        }

        globalChunkIndex++;
        if (globalChunkIndex % EVENT_LOOP_YIELD_INTERVAL === 0) {
          await yieldToBrowser();
        }
      }

      if (this.hasAllReceiverAcks(transfer)) break;
    }

    this.updateProgress(itemEl, 1, `Finalizing ${file.name}...`, 'waiting for receiver');
    await this.waitForDrain([...transfer.peers], undefined, 0);
    await this.waitForReceiverAcks(transfer);

    const elapsedSeconds = Math.max((performance.now() - startTime) / 1000, 0.001);
    const elapsed = elapsedSeconds.toFixed(1);
    const avgSpeed = formatSpeed(file.size / elapsedSeconds);
    const failed = [...transfer.failedPeers.entries()];

    if (failed.length > 0) {
      const details = failed.map(([peerId, reason]) => `${peerId}: ${reason}`).join('; ');
      this.updateProgress(itemEl, 1, `Transfer issue for ${file.name}`, details);
    } else {
      const confirmed = transfer.ackedPeers.size;
      this.updateProgress(itemEl, 1, `${file.name} delivered to ${confirmed} peer(s) in ${elapsed}s (${avgSpeed})`, 'complete');
    }

    this.outgoing.delete(id);
  }

  private async waitForFileReadyPeers(timeoutMs = 2000): Promise<string[]> {
    const pm = this.messaging.peerManager;
    const started = performance.now();
    const targetLaneCount = pm.getFileLaneCount();
    let peers = pm.getFileReadyPeers();

    while (performance.now() - started < timeoutMs) {
      if (peers.length > 0 && peers.every(peerId => pm.getFileLaneCount(peerId) >= targetLaneCount)) {
        return peers;
      }
      await new Promise(resolve => window.setTimeout(resolve, 50));
      peers = pm.getFileReadyPeers();
    }

    return peers.length > 0 ? peers : pm.getConnectedPeers();
  }

  private createChunkPacket(index: number, idBytes: Uint8Array, chunk: Uint8Array): ArrayBuffer {
    const packet = new Uint8Array(1 + 1 + 4 + idBytes.length + chunk.length);
    packet[0] = MsgType.File;
    packet[1] = FILE_CHUNK;
    new DataView(packet.buffer).setUint32(2, index);
    packet.set(idBytes, 6);
    packet.set(chunk, 6 + idBytes.length);
    return packet.buffer;
  }

  /** Wait until the file DataChannel bufferedAmount drops below the high-water mark. */
  private async waitForDrain(
    peerIds: string[],
    lane?: number,
    threshold = BUFFER_DRAIN_WATER,
  ): Promise<void> {
    const pm = this.messaging.peerManager;

    for (const peerId of peerIds) {
      const laneCount = lane === undefined ? pm.getFileLaneCount(peerId) : 1;
      for (let offset = 0; offset < laneCount; offset++) {
        const currentLane = lane ?? offset;
        if (pm.getFileBufferedAmount(peerId, currentLane) > BUFFER_HIGH_WATER) {
          await pm.waitForFileBufferedAmountBelow(peerId, threshold, currentLane);
        } else if (threshold === 0 && pm.getFileBufferedAmount(peerId, currentLane) > 0) {
          await pm.waitForFileBufferedAmountBelow(peerId, 0, currentLane);
        }
      }
    }
  }

  private async waitForReceiverAcks(transfer: OutgoingTransfer): Promise<void> {
    if (this.hasAllReceiverAcks(transfer)) return;

    const timeoutMs = Math.min(300_000, Math.max(30_000, transfer.size / (2 * 1024 * 1024) * 1000));
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => {
        for (const peerId of transfer.peers) {
          if (!transfer.ackedPeers.has(peerId) && !transfer.failedPeers.has(peerId)) {
            transfer.failedPeers.set(peerId, 'no completion confirmation');
          }
        }
        transfer.resolveAck = undefined;
        resolve();
      }, timeoutMs);

      transfer.resolveAck = () => {
        if (!this.hasAllReceiverAcks(transfer)) return;
        window.clearTimeout(timeout);
        transfer.resolveAck = undefined;
        resolve();
      };
    });
  }

  private hasAllReceiverAcks(transfer: OutgoingTransfer): boolean {
    for (const peerId of transfer.peers) {
      if (!transfer.ackedPeers.has(peerId) && !transfer.failedPeers.has(peerId)) {
        return false;
      }
    }
    return true;
  }

  private handleFileMessage(peerId: string, data: Uint8Array): void {
    if (data.length < 2) return;
    const subType = data[0];

    switch (subType) {
      case FILE_META: {
        const json = JSON.parse(textDecoder.decode(data.subarray(1)));
        const transfer: FileTransfer = {
          id: json.id,
          name: json.name,
          size: json.size,
          totalChunks: json.totalChunks,
          chunkSize: json.chunkSize ?? CHUNK_SIZE,
          receivedChunks: new Array(json.totalChunks),
          receivedCount: 0,
          progress: 0,
          done: false,
          from: peerId,
          startTime: performance.now(),
        };
        this.incoming.set(json.id, transfer);
        this.addFileItem(
          `📥 ${json.name} (${formatSize(json.size)}) from ${peerId}`,
          'receiving', json.id,
        );
        this.flushPendingChunks(json.id, transfer);
        break;
      }
      case FILE_CHUNK: {
        if (data.length < 13) return;
        const index = new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0);
        const id = textDecoder.decode(data.subarray(5, 13));
        const chunkData = data.subarray(13);

        const transfer = this.incoming.get(id);
        if (!transfer) {
          const pending = this.pendingChunks.get(id) ?? [];
          pending.push({ index, data: chunkData.slice() });
          this.pendingChunks.set(id, pending);
          return;
        }
        this.storeChunk(id, transfer, index, chunkData);
        return;

      }
      case FILE_ACK:
      case FILE_ERROR: {
        const json = JSON.parse(textDecoder.decode(data.subarray(1)));
        this.handleReceiverAck(peerId, {
          id: json.id,
          ok: subType === FILE_ACK && json.ok !== false,
          size: json.size,
          error: json.error,
        });
        return;
      }
    }
  }

  private handleReceiverAck(
    peerId: string,
    ack: { id: string; ok: boolean; size?: number; error?: string },
  ): void {
    const transfer = this.outgoing.get(ack.id);
    if (!transfer || !transfer.peers.has(peerId)) return;

    if (ack.ok && ack.size === transfer.size) {
      transfer.ackedPeers.add(peerId);
      transfer.failedPeers.delete(peerId);
    } else {
      transfer.failedPeers.set(peerId, ack.error || 'receiver reported an incomplete file');
    }

    transfer.resolveAck?.();
  }

  private flushPendingChunks(id: string, transfer: FileTransfer): void {
    const pending = this.pendingChunks.get(id);
    if (!pending) return;

    this.pendingChunks.delete(id);
    for (const chunk of pending) {
      if (transfer.done) break;
      this.storeChunk(id, transfer, chunk.index, chunk.data);
    }
  }

  private storeChunk(id: string, transfer: FileTransfer, index: number, chunkData: Uint8Array): void {
    if (transfer.done || index >= transfer.totalChunks) return;

    // Store as Blob part (browser can swap to disk for large transfers)
    if (!transfer.receivedChunks[index]) {
      transfer.receivedChunks[index] = new Blob([chunkData as Uint8Array<ArrayBuffer>]);
      transfer.receivedCount++;
    }

    transfer.progress = transfer.receivedCount / transfer.totalChunks;

    // Throttled UI updates
    if (transfer.receivedCount % UI_UPDATE_INTERVAL === 0 || transfer.receivedCount === transfer.totalChunks) {
      this.onProgress(transfer);
      const itemEl = this.listEl?.querySelector(`[data-file-id="${id}"]`) as HTMLElement;
      if (itemEl) {
        const elapsed = (performance.now() - (transfer.startTime ?? performance.now())) / 1000;
        const bytesReceived = Math.min(transfer.receivedCount * transfer.chunkSize, transfer.size);
        const speed = elapsed > 0 ? bytesReceived / elapsed : 0;
        const remaining = Math.max(transfer.size - bytesReceived, 0);
        const eta = speed > 0 ? remaining / speed : 0;
        const info = `${formatSpeed(speed)} • ${formatEta(eta)}`;
        this.updateProgress(itemEl, transfer.progress, undefined, info);
      }
    }

    // Check completion
    if (transfer.receivedCount === transfer.totalChunks) {
      this.assembleFile(transfer);
    }
  }

  private assembleFile(transfer: FileTransfer): void {
    // Assemble using Blob constructor — takes an array of Blob parts
    // This is memory-efficient because the browser can stream from its
    // internal blob storage instead of holding everything in JS heap.
    const mimeType = guessMime(transfer.name);
    const parts = transfer.receivedChunks.filter((b): b is Blob => b !== undefined);
    transfer.blob = new Blob(parts, { type: mimeType });

    if (parts.length !== transfer.totalChunks || transfer.blob.size !== transfer.size) {
      this.sendTransferResult(transfer.from, transfer.id, false, transfer.blob.size, 'received file size mismatch');
      this.markReceiveFailed(transfer, 'File did not arrive completely. Please send it again.');
      return;
    }

    transfer.done = true;
    this.sendTransferResult(transfer.from, transfer.id, true, transfer.blob.size);

    // Free chunk references
    transfer.receivedChunks = [];
    this.incoming.delete(transfer.id);
    this.onComplete(transfer);

    // Calculate total time
    const elapsed = ((performance.now() - (transfer.startTime ?? performance.now())) / 1000).toFixed(1);
    const avgSpeed = formatSpeed(transfer.size / parseFloat(elapsed));

    // Create download button
    const itemEl = this.listEl?.querySelector(`[data-file-id="${transfer.id}"]`) as HTMLElement;
    if (itemEl) {
      const fileName = transfer.name;
      const blob = transfer.blob!;

      itemEl.innerHTML = `
        <div class="fs-item-row">
          <span class="fs-item-icon">✅</span>
          <span class="fs-item-text">${fileName}</span>
          <button class="fs-download-btn" title="Download ${fileName}">💾 Download</button>
        </div>
        <div class="fs-item-row">
          <span class="fs-item-size">${formatSize(transfer.size)} — received in ${elapsed}s (${avgSpeed})</span>
        </div>
      `;

      itemEl.querySelector('.fs-download-btn')!.addEventListener('click', () => {
        triggerDownload(blob, fileName);
      });
    }
  }

  private sendTransferResult(
    peerId: string,
    id: string,
    ok: boolean,
    size: number,
    error?: string,
  ): void {
    const payload = textEncoder.encode(JSON.stringify({ id, ok, size, error }));
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = ok ? FILE_ACK : FILE_ERROR;
    msg.set(payload, 1);
    this.messaging.sendFileTo(peerId, msg);
  }

  private markReceiveFailed(transfer: FileTransfer, reason: string): void {
    transfer.done = true;
    transfer.receivedChunks = [];
    this.incoming.delete(transfer.id);

    const itemEl = this.listEl?.querySelector(`[data-file-id="${transfer.id}"]`) as HTMLElement;
    if (itemEl) {
      this.updateProgress(itemEl, transfer.progress, `${transfer.name}: ${reason}`, 'incomplete');
    }
  }

  // ── UI helpers ──────────────────────────────────────────────────────

  private addFileItem(text: string, type: string, id?: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `fs-item fs-${type}`;
    if (id) el.dataset.fileId = id;
    el.innerHTML = `
      <div class="fs-item-row">
        <span class="fs-item-text">${text}</span>
        <span class="fs-item-speed"></span>
      </div>
      <div class="fs-progress"><div class="fs-progress-bar" style="width:0%"></div></div>
    `;
    this.listEl?.appendChild(el);
    return el;
  }

  private updateProgress(el: HTMLElement, progress: number, text?: string, speed?: string): void {
    const bar = el.querySelector('.fs-progress-bar') as HTMLElement;
    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    if (text) {
      const textEl = el.querySelector('.fs-item-text');
      if (textEl) textEl.textContent = text;
    }
    if (speed) {
      const speedEl = el.querySelector('.fs-item-speed');
      if (speedEl) speedEl.textContent = speed;
    }
  }

  destroy(): void {
    this.incoming.clear();
    this.outgoing.clear();
    this.pendingChunks.clear();
  }
}

// ── Formatting helpers ──────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return 'calculating…';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s left`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  return `${hrs}h ${mins}m left`;
}

/** Guess MIME type from file extension for proper blob creation. */
function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    // Images
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    ico: 'image/x-icon', bmp: 'image/bmp',
    // Documents
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Text
    txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
    html: 'text/html', css: 'text/css', js: 'text/javascript',
    json: 'application/json', xml: 'application/xml',
    // Archives
    zip: 'application/zip', rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed', gz: 'application/gzip',
    tar: 'application/x-tar',
    // Audio / Video
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', mov: 'video/quicktime',
    // Executables / disk images
    exe: 'application/x-msdownload', msi: 'application/x-msi',
    iso: 'application/x-iso9660-image',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Trigger a file download with the correct filename.
 *
 * Primary: File System Access API (showSaveFilePicker)
 * Fallback: data URI approach
 */
async function triggerDownload(blob: Blob, fileName: string): Promise<void> {
  // Try the File System Access API first (modern Chrome/Edge)
  if ('showSaveFilePicker' in window) {
    try {
      const ext = fileName.includes('.') ? fileName.split('.').pop()! : '';
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: fileName,
        types: ext ? [{
          description: `${ext.toUpperCase()} file`,
          accept: { [blob.type || 'application/octet-stream']: [`.${ext}`] },
        }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
    }
  }

  // Fallback: data URI (works for files under ~500MB)
  const reader = new FileReader();
  reader.onload = () => {
    const a = document.createElement('a');
    a.href = reader.result as string;
    a.download = fileName;
    a.click();
  };
  reader.readAsDataURL(blob);
}
