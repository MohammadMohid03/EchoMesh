import { MessagingLayer } from './messaging';

// ── File transfer sub-types within MsgType.File ─────────────────────
const FILE_META = 0;    // File metadata: { name, size, totalChunks, id }
const FILE_CHUNK = 1;   // File chunk:    [FILE_CHUNK][index 4B][id 8B][data]

// ── Tuned for LAN speed — streaming approach ────────────────────────
// 512 KB chunks — good balance of throughput vs SCTP buffer pressure.
// The sender reads each chunk from disk via file.slice() instead of
// loading the entire file into memory, enabling transfers up to 1 GB.
const CHUNK_SIZE = 512 * 1024;                    // 512 KB per chunk
const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024;     // 1 GB limit

// Back-pressure: pause sending when the DataChannel buffer exceeds
// this threshold so we don't overwhelm the SCTP layer.
const BUFFER_HIGH_WATER = 2 * 1024 * 1024; // 2 MB
const BUFFER_DRAIN_WAIT = 5;               // ms to wait when buffer is full

// How often to update the UI during large transfers (every N chunks)
const UI_UPDATE_INTERVAL = 4;

export interface FileTransfer {
  id: string;
  name: string;
  size: number;
  totalChunks: number;
  receivedChunks: (Blob | undefined)[];  // Sparse array — browser can swap Blob parts to disk
  receivedCount: number;
  progress: number;          // 0 to 1
  done: boolean;
  blob?: Blob;
  from: string;
  startTime?: number;
}

type FileEventHandler = (transfer: FileTransfer) => void;

/**
 * High-speed file sharing over WebRTC DataChannels.
 *
 * Optimised for LAN transfers up to 1 GB:
 *  - Streaming reads: file.slice() reads chunks from disk (no full-file buffer)
 *  - 512 KB chunks for high throughput
 *  - Back-pressure via bufferedAmount checks
 *  - Receiver stores chunks as Blob parts (lower memory than Uint8Array map)
 *  - Live speed + ETA display
 */
export class FileSharer {
  private messaging: MessagingLayer;
  private incoming = new Map<string, FileTransfer>();
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
      await this.sendFile(file);
    }
  }

  /**
   * Send a file using streaming reads.
   * Instead of file.arrayBuffer() (loads everything into RAM),
   * we use file.slice(start, end) to read one chunk at a time from disk.
   */
  private async sendFile(file: File): Promise<void> {
    const id = crypto.randomUUID().slice(0, 8);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const startTime = performance.now();

    // Send metadata first
    const meta = { id, name: file.name, size: file.size, totalChunks };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const metaMsg = new Uint8Array(1 + metaBytes.length);
    metaMsg[0] = FILE_META;
    metaMsg.set(metaBytes, 1);
    this.messaging.sendFile(metaMsg);

    // Show in UI
    const itemEl = this.addFileItem(
      `📤 ${file.name} (${formatSize(file.size)})`,
      'sending', id,
    );

    // Pre-encode the file ID once (always 8 bytes)
    const idBytes = new TextEncoder().encode(id);

    // Stream chunks from disk one at a time
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);

      // Read ONLY this chunk from disk (no full-file buffer)
      const slice = file.slice(start, end);
      const chunkBuf = await slice.arrayBuffer();
      const chunk = new Uint8Array(chunkBuf);

      // Build the chunk message: [FILE_CHUNK][index 4B][id 8B][data]
      const msg = new Uint8Array(1 + 4 + idBytes.length + chunk.length);
      msg[0] = FILE_CHUNK;
      new DataView(msg.buffer).setUint32(1, i);
      msg.set(idBytes, 5);
      msg.set(chunk, 5 + idBytes.length);

      // Back-pressure: wait for DataChannel buffer to drain if needed
      await this.waitForDrain();

      this.messaging.sendFile(msg);

      // Update progress + speed (throttled for large files)
      if (i % UI_UPDATE_INTERVAL === 0 || i === totalChunks - 1) {
        const progress = (i + 1) / totalChunks;
        const elapsed = (performance.now() - startTime) / 1000;
        const bytesSent = end;
        const speed = elapsed > 0 ? bytesSent / elapsed : 0;
        const eta = speed > 0 ? (file.size - bytesSent) / speed : 0;
        const info = `${formatSpeed(speed)} • ${formatEta(eta)}`;
        this.updateProgress(itemEl, progress, undefined, info);
      }
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    const avgSpeed = formatSpeed(file.size / parseFloat(elapsed));
    this.updateProgress(itemEl, 1, `✅ ${file.name} — sent in ${elapsed}s (${avgSpeed})`);
  }

  /**
   * Wait until the DataChannel's bufferedAmount drops below the
   * high-water mark.
   */
  private async waitForDrain(): Promise<void> {
    const pm = this.messaging.peerManager;
    const peers = pm.getConnectedPeers();

    for (const peerId of peers) {
      const buffered = pm.getBufferedAmount(peerId);
      if (buffered > BUFFER_HIGH_WATER) {
        while (pm.getBufferedAmount(peerId) > BUFFER_HIGH_WATER / 2) {
          await new Promise(r => setTimeout(r, BUFFER_DRAIN_WAIT));
        }
      }
    }
  }

  private handleFileMessage(peerId: string, data: Uint8Array): void {
    if (data.length < 2) return;
    const subType = data[0];

    switch (subType) {
      case FILE_META: {
        const json = JSON.parse(new TextDecoder().decode(data.subarray(1)));
        const transfer: FileTransfer = {
          id: json.id,
          name: json.name,
          size: json.size,
          totalChunks: json.totalChunks,
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
        break;
      }
      case FILE_CHUNK: {
        const index = new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0);
        const id = new TextDecoder().decode(data.subarray(5, 13));
        const chunkData = data.subarray(13);

        const transfer = this.incoming.get(id);
        if (!transfer || transfer.done) return;

        // Store as Blob part (browser can swap to disk for large transfers)
        if (!transfer.receivedChunks[index]) {
          // .slice() creates a new ArrayBuffer copy — required for Blob compat
          transfer.receivedChunks[index] = new Blob([chunkData.slice()]);
          transfer.receivedCount++;
        }

        transfer.progress = transfer.receivedCount / transfer.totalChunks;

        // Throttled UI updates
        if (transfer.receivedCount % UI_UPDATE_INTERVAL === 0 || transfer.receivedCount === transfer.totalChunks) {
          this.onProgress(transfer);
          const itemEl = this.listEl?.querySelector(`[data-file-id="${id}"]`) as HTMLElement;
          if (itemEl) {
            const elapsed = (performance.now() - (transfer.startTime ?? performance.now())) / 1000;
            const bytesReceived = transfer.receivedCount * CHUNK_SIZE;
            const speed = elapsed > 0 ? bytesReceived / elapsed : 0;
            const remaining = transfer.size - bytesReceived;
            const eta = speed > 0 ? remaining / speed : 0;
            const info = `${formatSpeed(speed)} • ${formatEta(eta)}`;
            this.updateProgress(itemEl, transfer.progress, undefined, info);
          }
        }

        // Check completion
        if (transfer.receivedCount === transfer.totalChunks) {
          this.assembleFile(transfer);
        }
        break;
      }
    }
  }

  private assembleFile(transfer: FileTransfer): void {
    // Assemble using Blob constructor — takes an array of Blob parts
    // This is memory-efficient because the browser can stream from its
    // internal blob storage instead of holding everything in JS heap.
    const mimeType = guessMime(transfer.name);
    const parts = transfer.receivedChunks.filter((b): b is Blob => b !== undefined);
    transfer.blob = new Blob(parts, { type: mimeType });
    transfer.done = true;

    // Free chunk references
    transfer.receivedChunks = [];
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
